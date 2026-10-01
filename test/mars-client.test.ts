import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSdkMarsClient,
  marsEgressAllow,
  marsManifest,
  marsSessionState,
  MarsSandboxGoneError,
  type MarsClient,
  type MarsSession,
} from "../src/sandbox/mars-client.ts";
import { tunnelUrl, SANDBOX_AGENT_PORT } from "../src/sandbox/mars-tunnel.ts";
import { startFakeMarsService, type FakeMarsService } from "./support/fake-mars-service.ts";

let service: FakeMarsService;
let client: MarsClient;
const opened: MarsSession[] = [];

const session = async (name: string): Promise<MarsSession> => {
  const created = await client.create({ name });
  opened.push(created);
  return created;
};

before(async () => {
  service = await startFakeMarsService();
  client = createSdkMarsClient({
    apiToken: service.token,
    apiBaseUrl: service.apiBaseUrl,
    template: "base",
  });
});

after(async () => {
  await Promise.all(opened.map((s) => s.kill().catch(() => undefined)));
  await service?.close();
});

test("the port-forward url targets sandbox-agent over wss", () => {
  assert.equal(
    tunnelUrl("https://api.digitalocean.com", "sess-1", SANDBOX_AGENT_PORT),
    "wss://api.digitalocean.com/v2/agents/sessions/sess-1/port-forward/8443",
  );
  assert.equal(
    tunnelUrl("http://127.0.0.1:9000/edge", "sess-2", SANDBOX_AGENT_PORT),
    "ws://127.0.0.1:9000/edge/v2/agents/sessions/sess-2/port-forward/8443",
  );
  assert.throws(() => tunnelUrl("ftp://example.com", "s", 8443), /must be http/);
});

test("the manifest names an agent, pins a template, and pre-allows bash so MARS never gates a command", () => {
  const yaml = marsManifest({ name: "qm-personal-tester", template: "base" });
  assert.match(yaml, /^name: "qm-personal-tester"$/m);
  assert.match(yaml, /^agent: "codex"$/m);
  assert.match(yaml, /^template: "base"$/m);
  assert.match(yaml, /^persistent_workspace: true$/m);
  assert.match(yaml, /tool: bash/);
  assert.match(yaml, /action: allow/);
});

test("the manifest omits the template so MARS derives it from the agent", () => {
  const yaml = marsManifest({ name: "n", template: "" });
  assert.match(yaml, /^agent: "codex"$/m);
  assert.doesNotMatch(yaml, /^template:/m);
});

test("the manifest carries size, idle timeout and the egress allowlist only when configured", () => {
  const bare = marsManifest({ name: "n", template: "base" });
  assert.doesNotMatch(bare, /size:|idle_timeout:|egress:/);
  const full = marsManifest({
    name: "n",
    template: "base",
    sizeSlug: "mv-2vcpu-4gb",
    idleTimeoutSec: 600,
    egressAllow: ["proxy.example.com"],
  });
  assert.match(full, /^size: "mv-2vcpu-4gb"$/m);
  assert.match(full, /^idle_timeout: "600s"$/m);
  assert.match(full, /^ {2}- "proxy\.example\.com"$/m);
});

test("the vendored proto carries no internal annotations", () => {
  const proto = readFileSync(join(process.cwd(), "src/sandbox/mars-sandbox-agent.proto"), "utf8");
  assert.doesNotMatch(proto, /do\/doge/);
  assert.doesNotMatch(proto, /dorpc/);
  assert.match(proto, /service SandboxAgentService/);
});

test("creating a session posts a yaml manifest and waits for ready", async () => {
  const s = await session("qm-create");
  assert.ok(s.sessionId);
  assert.equal(service.sessions().length, 1);
  assert.match(service.manifests()[0] ?? "", /template: "base"/);
  assert.equal(service.sessions()[0]?.template, "base");
});

test("a command runs in the guest over the port-forward tunnel", async () => {
  const s = await session("qm-exec");
  const result = await s.runCommand("echo hello-from-guest; echo oops >&2; exit 3");
  assert.equal(result.exitCode, 3);
  assert.match(result.stdout, /hello-from-guest/);
  assert.match(result.stderr, /oops/);
  assert.ok(service.tunnelCount() > 0, "exec must travel through the tunnel, not the REST exec endpoint");
});

test("command env and working directory reach the guest", async () => {
  const s = await session("qm-env");
  const result = await s.runCommand("echo VAR=$MY_VAR", { env: { MY_VAR: "set-by-qm" } });
  assert.match(result.stdout, /VAR=set-by-qm/);
});

test("files round trip through the guest upload and download streams", async () => {
  const s = await session("qm-files");
  const body = Buffer.from("mars file payload");
  await s.writeFileBytes("/home/user/notes/a.txt", new Uint8Array(body));
  const read = await s.readFileBytes("/home/user/notes/a.txt");
  assert.ok(read);
  assert.equal(Buffer.from(read).toString("utf8"), "mars file payload");
});

test("a missing file reads as null rather than an error", async () => {
  const s = await session("qm-missing");
  assert.equal(await s.readFileBytes("/home/user/nope.txt"), null);
});

test("a large file survives the chunked upload path", async () => {
  const s = await session("qm-large");
  const body = Buffer.alloc(900 * 1024, "x");
  await s.writeFileBytes("/home/user/big.bin", new Uint8Array(body));
  const read = await s.readFileBytes("/home/user/big.bin");
  assert.equal(read?.length, body.length);
});

test("list resolves a session by name and skips destroyed rows", async () => {
  const s = await session("qm-list");
  const found = await client.list("qm-list");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sessionId, s.sessionId);
  await s.kill();
  assert.deepEqual(await client.list("qm-list"), []);
});

test("connect resumes a paused session before handing it back", async () => {
  const s = await session("qm-paused");
  await s.pause();
  assert.equal((await client.info(s.sessionId)).state, "paused");
  const again = await client.connect(s.sessionId);
  assert.equal((await client.info(again.sessionId)).state, "ready");
  const result = await again.runCommand("echo awake");
  assert.match(result.stdout, /awake/);
});

test("a destroyed session reports a terminal state, and reconnecting to it fails fast", async () => {
  const s = await session("qm-gone");
  await client.kill(s.sessionId);
  assert.equal((await client.info(s.sessionId)).state, "destroyed");
  await assert.rejects(() => client.connect(s.sessionId), MarsSandboxGoneError);
});

test("a session the control plane has never heard of reads as gone", async () => {
  await assert.rejects(() => client.info("11111111-2222-3333-4444-555555555555"), MarsSandboxGoneError);
});

test("a bad token is refused by the control plane", async () => {
  const wrong = createSdkMarsClient({ apiToken: "nope", apiBaseUrl: service.apiBaseUrl, template: "base" });
  await assert.rejects(() => wrong.create({ name: "qm-unauth" }), /401|bad token/);
});

test("session status wire values map onto backend states", () => {
  assert.equal(marsSessionState("SESSION_STATUS_READY"), "ready");
  assert.equal(marsSessionState("SESSION_STATUS_PAUSED"), "paused");
  assert.equal(marsSessionState("nonsense"), "unspecified");
});

test("the egress allowlist carries just the proxy host", () => {
  assert.deepEqual(marsEgressAllow("https://egress.example.com:443/path"), ["egress.example.com"]);
});
