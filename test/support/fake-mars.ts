import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MarsCommandLostError,
  MarsHitlRejectedError,
  MarsSandboxGoneError,
  type MarsClient,
  type MarsCommandResult,
  type MarsSession,
  type MarsSessionInfo,
  type MarsSessionState,
  type MarsSessionSummary,
} from "../../src/sandbox/mars-client.ts";
import { mkdtempSync } from "node:fs";

const GUEST_HOME_DIR = "/workspace/home";

interface FakeRecord {
  sessionId: string;
  sandboxId: string;
  name: string;
  state: MarsSessionState;
  home: string;
  createdAt: number;
  loseNextCommand: boolean;
  rejectNextCommand: boolean;
}

export interface FakeMars {
  client: MarsClient;
  current(name: string): { sessionId: string; sandboxId: string; state: MarsSessionState } | null;
  createdCount(name: string): number;
  homeDir(name: string): string;
  pause(name: string): void;
  destroy(name: string): void;
  loseNextCommand(name: string): void;
  rejectNextCommand(name: string): void;
  execScripts(): string[];
  pauseCalls(): string[];
  resumeCalls(): string[];
  cleanup(): void;
}

export function installFakeMars(): FakeMars {
  const root = mkdtempSync(join(tmpdir(), "fake-mars-"));
  const records = new Map<string, FakeRecord>();
  const execScripts: string[] = [];
  const pauseCalls: string[] = [];
  const resumeCalls: string[] = [];
  let nextId = 1;
  let clock = 0;

  const gone = (state: MarsSessionState): boolean =>
    state === "destroyed" || state === "destroying" || state === "failed";

  const byName = (name: string): FakeRecord | undefined => {
    const all = [...records.values()].filter((r) => r.name === name).sort((a, b) => b.createdAt - a.createdAt);
    return all.find((r) => !gone(r.state)) ?? all[0];
  };

  const need = (name: string): FakeRecord => {
    const r = byName(name);
    if (!r) throw new Error(`fake-mars: no session named ${name}`);
    return r;
  };

  const remap = (r: FakeRecord, script: string): string => {
    const homeRe = r.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(r.home)}; ` +
      script
        .replace(/\btimeout \d+ /g, "")
        .replaceAll(GUEST_HOME_DIR, r.home)
        .replace(remapPath, (mm) => (mm.startsWith(r.home) ? mm : `${r.home}/tmp/`))
    );
  };

  const alive = (r: FakeRecord): void => {
    if (gone(r.state)) throw new MarsSandboxGoneError(r.sessionId, `status ${r.state}`);
    if (r.state === "paused") r.state = "ready";
  };

  const info = (r: FakeRecord): MarsSessionInfo => ({
    sessionId: r.sessionId,
    sandboxId: r.sandboxId,
    name: r.name,
    state: r.state,
    createdAtMs: r.createdAt,
  });

  const session = (r: FakeRecord): MarsSession => ({
    sessionId: r.sessionId,
    sandboxId: r.sandboxId,
    async runCommand(command): Promise<MarsCommandResult> {
      alive(r);
      if (r.loseNextCommand) {
        r.loseNextCommand = false;
        r.state = "destroyed";
        throw new MarsCommandLostError(r.sessionId, "sandbox is not running anymore");
      }
      if (r.rejectNextCommand) {
        r.rejectNextCommand = false;
        throw new MarsHitlRejectedError(r.sessionId);
      }
      execScripts.push(command);
      mkdirSync(join(r.home, "tmp"), { recursive: true });
      const spawned = spawnSync("sh", ["-c", remap(r, command)], {
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      return {
        stdout: (spawned.stdout ?? Buffer.alloc(0)).toString("utf8"),
        stderr: (spawned.stderr ?? Buffer.alloc(0)).toString("utf8"),
        exitCode: spawned.status ?? (spawned.signal ? 137 : -1),
      };
    },
    async readFileBytes(absPath): Promise<Uint8Array | null> {
      alive(r);
      const hostPath = absPath.startsWith(GUEST_HOME_DIR) ? r.home + absPath.slice(GUEST_HOME_DIR.length) : absPath;
      if (!existsSync(hostPath)) return null;
      return new Uint8Array(readFileSync(hostPath));
    },
    async writeFileBytes(absPath, data): Promise<void> {
      alive(r);
      const hostPath = absPath.startsWith(GUEST_HOME_DIR) ? r.home + absPath.slice(GUEST_HOME_DIR.length) : absPath;
      mkdirSync(dirname(hostPath), { recursive: true });
      writeFileSync(hostPath, Buffer.from(data));
    },
    async pause(): Promise<void> {
      if (gone(r.state)) throw new MarsSandboxGoneError(r.sessionId, `status ${r.state}`);
      pauseCalls.push(r.sessionId);
      r.state = "paused";
    },
    async resume(): Promise<void> {
      if (gone(r.state)) throw new MarsSandboxGoneError(r.sessionId, `status ${r.state}`);
      resumeCalls.push(r.sessionId);
      r.state = "ready";
    },
    async kill(): Promise<void> {
      r.state = "destroyed";
      rmSync(r.home, { recursive: true, force: true });
    },
  });

  const client: MarsClient = {
    nativePause: true,
    async info(sessionId): Promise<MarsSessionInfo> {
      const r = records.get(sessionId);
      if (!r || gone(r.state)) throw new MarsSandboxGoneError(sessionId, "session was not found");
      return info(r);
    },
    async create(opts): Promise<MarsSession> {
      const id = `sess-${nextId++}`;
      const r: FakeRecord = {
        sessionId: id,
        sandboxId: `sbx-${id}`,
        name: opts.name,
        state: "ready",
        home: join(root, id),
        createdAt: ++clock,
        loseNextCommand: false,
        rejectNextCommand: false,
      };
      mkdirSync(r.home, { recursive: true });
      records.set(id, r);
      return session(r);
    },
    async connect(sessionId): Promise<MarsSession> {
      const r = records.get(sessionId);
      if (!r || gone(r.state)) throw new MarsSandboxGoneError(sessionId, "session was not found");
      if (r.state === "paused") {
        resumeCalls.push(r.sessionId);
        r.state = "ready";
      }
      return session(r);
    },
    async list(name): Promise<MarsSessionSummary[]> {
      return [...records.values()]
        .filter((r) => !gone(r.state) && r.name === name)
        .map((r) => ({ sessionId: r.sessionId, sandboxId: r.sandboxId, name: r.name, state: r.state }));
    },
    async kill(sessionId): Promise<void> {
      const r = records.get(sessionId);
      if (!r) return;
      r.state = "destroyed";
      rmSync(r.home, { recursive: true, force: true });
    },
  };

  return {
    client,
    current: (name) => {
      const r = byName(name);
      return r && !gone(r.state) ? { sessionId: r.sessionId, sandboxId: r.sandboxId, state: r.state } : null;
    },
    createdCount: (name) => [...records.values()].filter((r) => r.name === name).length,
    homeDir: (name) => need(name).home,
    pause: (name) => {
      need(name).state = "paused";
    },
    destroy: (name) => {
      const r = need(name);
      r.state = "destroyed";
      rmSync(r.home, { recursive: true, force: true });
    },
    loseNextCommand: (name) => {
      need(name).loseNextCommand = true;
    },
    rejectNextCommand: (name) => {
      need(name).rejectNextCommand = true;
    },
    execScripts: () => [...execScripts],
    pauseCalls: () => [...pauseCalls],
    resumeCalls: () => [...resumeCalls],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
