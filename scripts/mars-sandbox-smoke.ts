#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarsSandbox } from "../src/sandbox/mars-sandbox.ts";
import { createSdkMarsClient } from "../src/sandbox/mars-client.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";

const apiToken = process.env.MARS_API_TOKEN;
const apiBaseUrl = process.env.MARS_API_BASE_URL;
const template = process.env.MARS_TEMPLATE ?? "";
const agent = process.env.MARS_AGENT;
const keep = process.env.MARS_SMOKE_KEEP === "1";

const log = (...a: unknown[]) => console.log("[mars-smoke]", ...a);

async function main(): Promise<void> {
  if (!apiToken) throw new Error("MARS_API_TOKEN is required");

  const client = createSdkMarsClient({
    apiToken,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(agent ? { agent } : {}),
    ...(template ? { template } : {}),
  });

  const prefix = `qms${randomBytes(3).toString("hex")}`;
  const sandbox = createMarsSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "mars-smoke-ws-"))), {
    client,
    namePrefix: prefix,
  });
  const scope = scopeId("personal", "smoke");
  const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];

  log(`provisioning a qm agent computer (prefix ${prefix})...`);
  const handle = await sandbox.provision(layers, { env: { QM_SMOKE: "1" } });
  log("provisioned", handle.id, "coldStart", handle.coldStart);

  try {
    log("running a command through the qm Sandbox interface...");
    const r = await sandbox.run(handle, "pwd; echo QM_SMOKE=$QM_SMOKE; whoami");
    assert.equal(r.code, 0, `run exited ${r.code}: ${r.stderr}`);
    log("stdout:", JSON.stringify(r.stdout));
    assert.match(r.stdout, /QM_SMOKE=1/);

    log("writing and reading a workspace file through qm...");
    await sandbox.writeFile(handle, "notes/hello.txt", "written by qm");
    assert.equal(await sandbox.readFile(handle, "notes/hello.txt"), "written by qm");
    log("file round-trip OK");

    log("checking the toolchain qm expects...");
    const tools = await sandbox.run(
      handle,
      "for t in bash git node python3 rg jq; do printf '%s=%s ' $t $(command -v $t >/dev/null && echo yes || echo NO); done; echo",
    );
    log(tools.stdout.trim());

    log("checking a command survives past the 4-minute REST exec clamp...");
    const long = await sandbox.run(handle, "sleep 250; echo past-the-clamp", { timeoutMs: 400_000 });
    assert.equal(long.code, 0, `long run exited ${long.code}: ${long.stderr}`);
    assert.match(long.stdout, /past-the-clamp/);
    log("250s command completed over the tunnel");

    log("ALL CHECKS PASSED");
  } finally {
    if (keep) {
      log("MARS_SMOKE_KEEP=1 — leaving the sandbox alive");
    } else {
      log("tearing down and destroying the scope...");
      await sandbox.teardown(handle, { destroy: true }).catch((e: unknown) => log("teardown failed:", e));
    }
  }
}

main().catch((e: unknown) => {
  console.error("[mars-smoke] FAILED", e);
  process.exit(1);
});
