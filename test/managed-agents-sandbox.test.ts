import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollProcess } from "../src/sandbox/process-poll.ts";
import { createManagedAgentsSandbox, type StoredManagedAgentsSandbox } from "../src/sandbox/managed-agents-sandbox.ts";
import {
  managedAgentsEgressAllow,
  managedAgentsSessionState,
  ManagedAgentsHitlRejectedError,
} from "../src/sandbox/managed-agents-client.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { installFakeManagedAgents, type FakeManagedAgents } from "./support/fake-managed-agents.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeManagedAgents;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createManagedAgentsSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "managed-agents-ws-"))), {
    client: fake.client,
    namePrefix: "qmt",
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeManagedAgents();
  sandbox = make();
});

after(() => fake?.cleanup());

test("provision runs commands with env and cwd", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /workspace/);
  assert.match(r.stdout, /VAR=v1/);
});

test("one session per scope is reused across provisions", async () => {
  const first = await sandbox.provision(layers);
  await sandbox.teardown(first, { keepWarm: true });
  const second = await sandbox.provision(layers);
  assert.equal(second.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("the session is named after the scope so an operator can find it", async () => {
  await sandbox.provision(layers);
  const current = fake.current(scopeName());
  assert.ok(current, "expected a session registered under the scope name");
  assert.ok(scopeName().length <= 64, "Managed Agents caps session names at 64 characters");
  assert.doesNotMatch(scopeName(), /^[0-9a-f]{8}-[0-9a-f]{4}-/, "Managed Agents rejects UUID-shaped session names");
});

test("teardown pauses the session and the next provision resumes it", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "echo hi > kept.txt");
  await sandbox.teardown(h);
  assert.deepEqual(fake.pauseCalls().length, 1);
  assert.equal(fake.current(scopeName())?.state, "paused");

  const again = await sandbox.provision(layers);
  assert.equal(fake.resumeCalls().length, 1);
  const r = await sandbox.run(again, "cat kept.txt");
  assert.match(r.stdout, /hi/);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("keepWarm teardown leaves the session running for background work", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { keepWarm: true });
  assert.equal(fake.pauseCalls().length, 0);
  assert.equal(fake.current(scopeName())?.state, "ready");
});

test("a lost session is re-adopted by name when the durable record is gone", async () => {
  const store: DurableMap<StoredManagedAgentsSandbox> = createMemoryMap<StoredManagedAgentsSandbox>();
  sandbox = make({ store });
  await sandbox.provision(layers);
  const before = fake.current(scopeName());
  await store.delete(scope);

  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(fake.current(scopeName())?.sessionId, before?.sessionId);
});

test("a destroyed session is replaced on the next provision", async () => {
  await sandbox.provision(layers);
  fake.destroy(scopeName());
  const again = await sandbox.provision(layers);
  assert.ok(again.id);
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("destroying a scope disconnects the live guest rather than only deleting the session", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "true");
  const live = fake.current(scopeName());
  assert.ok(live, "expected a live session before destroying the scope");
  await sandbox.destroyScope!(scope);
  assert.deepEqual(fake.guestDisconnects(), [live.sessionId]);
  assert.equal(fake.current(scopeName()), null);
});

test("a command lost mid-flight is surfaced rather than silently retried", async () => {
  const h = await sandbox.provision(layers);
  fake.loseNextCommand(scopeName());
  await assert.rejects(() => sandbox.run(h, "echo nope"), /was lost while a command was running/);
});

test("a Managed Agents approval rejection names the permissions fix", async () => {
  const h = await sandbox.provision(layers);
  fake.rejectNextCommand(scopeName());
  await assert.rejects(() => sandbox.run(h, "echo nope"), ManagedAgentsHitlRejectedError);
  await assert.rejects(() => {
    fake.rejectNextCommand(scopeName());
    return sandbox.run(h, "echo nope");
  }, /permissions to allow bash/);
});

test("files round trip through the data plane", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "notes/a.txt", "hello managed agents");
  assert.equal(await sandbox.readFile(h, "notes/a.txt"), "hello managed agents");
  assert.equal(await sandbox.readFile(h, "notes/missing.txt"), null);
});

test("destroy removes the session and its durable record", async () => {
  const store: DurableMap<StoredManagedAgentsSandbox> = createMemoryMap<StoredManagedAgentsSandbox>();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { destroy: true });
  assert.equal(await store.get(scope), null);
  assert.equal(fake.current(scopeName()), null);
});

test("computerStatus reports a paused machine without waking it", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.provisioned, true);
  assert.equal(status.guestResponsive, false);
  assert.equal(status.lifecycleState, "paused");
  assert.equal(fake.resumeCalls().length, 0);
});

test("computerStatus probes a running machine", async () => {
  await sandbox.provision(layers);
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.provisioned, true);
  assert.equal(status.guestResponsive, true);
});

test("computerStatus on an unprovisioned scope reports nothing provisioned", async () => {
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.provisioned, false);
  assert.equal(status.guestResponsive, false);
});

test("scratch sandboxes are reference counted and never persisted", async () => {
  const store: DurableMap<StoredManagedAgentsSandbox> = createMemoryMap<StoredManagedAgentsSandbox>();
  sandbox = make({ store });
  const a = await sandbox.provision(layers, { scratch: { key: "k1" } });
  const b = await sandbox.provision(layers, { scratch: { key: "k1" } });
  assert.equal(a.id, b.id);
  assert.equal(a.scratch, true);
  await sandbox.teardown(a);
  assert.ok(fake.current(a.id), "still held by the second handle");
  await sandbox.teardown(b);
  assert.equal(fake.current(a.id), null);
  assert.equal(await store.get(scope), null);
});

test("the profile advertises provider-managed persistence and parks on teardown", () => {
  assert.equal(sandbox.profile.backend, "do-managed-agents");
  assert.equal(sandbox.profile.writablePersistence, "provider_managed");
  assert.equal(sandbox.profile.parksOnTeardown, true);
  assert.equal(supportsProcessSessions(sandbox), true);
});

test("egress enforcement is only claimed when a proxy is configured", () => {
  assert.equal(sandbox.profile.egressEnforcement, "none");
  assert.equal(make({ egressProxyUrl: "https://egress.example.com" }).profile.egressEnforcement, "domain");
});

test("the egress allowlist carries just the proxy host", () => {
  assert.deepEqual(managedAgentsEgressAllow("https://egress.example.com:443/path"), ["egress.example.com"]);
  assert.deepEqual(managedAgentsEgressAllow("http://10.0.0.7:8080"), ["10.0.0.7"]);
});

test("session status wire values map onto backend states", () => {
  assert.equal(managedAgentsSessionState("SESSION_STATUS_READY"), "ready");
  assert.equal(managedAgentsSessionState("SESSION_STATUS_PAUSED"), "paused");
  assert.equal(managedAgentsSessionState("SESSION_STATUS_DESTROYED"), "destroyed");
  assert.equal(managedAgentsSessionState("nonsense"), "unspecified");
  assert.equal(managedAgentsSessionState(undefined), "unspecified");
});

test("process sessions stream output through the data plane exec path", async () => {
  assert.ok(supportsProcessSessions(sandbox));
  if (!supportsProcessSessions(sandbox)) return;
  const h = await sandbox.provision(layers);
  const { processId } = await sandbox.startProcess(h, "echo one; echo two");
  const { output, status } = await pollProcess(sandbox, h, processId, { deadlineMs: 5_000, waitMs: 100 });
  assert.equal(status.state, "exited");
  assert.match(output, /one/);
  assert.match(output, /two/);
});
