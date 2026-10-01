import { fileURLToPath } from "node:url";
import { fetchWithRetry } from "../util/async.ts";
import { errMessage, withRequestId } from "../util/errors.ts";
import { openMarsTunnel, SANDBOX_AGENT_PORT, type MarsTunnel } from "./mars-tunnel.ts";

export interface MarsCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  hitlRejected?: boolean;
}

interface MarsRunOpts {
  timeoutMs?: number;
  workdir?: string;
  env?: Record<string, string>;
}

export type MarsSessionState =
  "unspecified" | "provisioning" | "ready" | "detached" | "destroying" | "destroyed" | "failed" | "paused";

export interface MarsSessionSummary {
  sessionId: string;
  sandboxId: string;
  name: string;
  state: MarsSessionState;
}

export interface MarsSessionInfo extends MarsSessionSummary {
  createdAtMs?: number;
  errorMessage?: string;
  sizeSlug?: string;
  template?: string;
}

export interface MarsSession {
  readonly sessionId: string;
  readonly sandboxId: string;
  runCommand(command: string, opts?: MarsRunOpts): Promise<MarsCommandResult>;
  readFileBytes(absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(absPath: string, data: Uint8Array): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  kill(): Promise<void>;
}

export class MarsSandboxGoneError extends Error {
  constructor(sessionId: string, detail: string) {
    super(`mars session ${sessionId} is gone: ${detail}`);
    this.name = "MarsSandboxGoneError";
  }
}

export class MarsCommandLostError extends Error {
  constructor(sessionId: string, detail: string) {
    super(
      `mars session ${sessionId} was lost while a command was running (${detail}); the command may have partially executed and was not retried`,
    );
    this.name = "MarsCommandLostError";
  }
}

export class MarsHitlRejectedError extends Error {
  constructor(sessionId: string) {
    super(
      `mars rejected a command in session ${sessionId} at its own approval gate; set the session permissions to allow bash so qm's approval gates stay authoritative`,
    );
    this.name = "MarsHitlRejectedError";
  }
}

interface MarsCreateOpts {
  name: string;
  egressAllow?: string[];
}

export interface MarsClient {
  readonly nativePause?: boolean;
  info(sessionId: string): Promise<MarsSessionInfo>;
  create(opts: MarsCreateOpts): Promise<MarsSession>;
  connect(sessionId: string): Promise<MarsSession>;
  list(name: string): Promise<MarsSessionSummary[]>;
  kill(sessionId: string): Promise<void>;
}

export interface SdkMarsClientOptions {
  apiToken: string;
  apiBaseUrl?: string;
  template?: string;
  agent?: string;
  sizeSlug?: string;
  idleTimeoutSec?: number;
  maxCommandMs?: number;
  egressProxyUrl?: string;
}

const DEFAULT_API_BASE_URL = "https://api.digitalocean.com";
const DEFAULT_TEMPLATE = "";
const DEFAULT_AGENT = "codex";
const DEFAULT_MAX_COMMAND_MS = 3600_000;
const CREATE_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_MS = 2_000;
const UPLOAD_CHUNK_BYTES = 256 * 1024;
const DOWNLOAD_CHUNK_BYTES = 256 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const GRPC_NOT_FOUND = 5;
const GRPC_UNAVAILABLE = 14;

const PROTO_PATH = fileURLToPath(new URL("./mars-sandbox-agent.proto", import.meta.url));

const STATE_BY_WIRE: Record<string, MarsSessionState> = {
  SESSION_STATUS_UNSPECIFIED: "unspecified",
  SESSION_STATUS_PROVISIONING: "provisioning",
  SESSION_STATUS_READY: "ready",
  SESSION_STATUS_DETACHED: "detached",
  SESSION_STATUS_DESTROYING: "destroying",
  SESSION_STATUS_DESTROYED: "destroyed",
  SESSION_STATUS_FAILED: "failed",
  SESSION_STATUS_PAUSED: "paused",
};

const GONE_STATES: ReadonlySet<MarsSessionState> = new Set<MarsSessionState>(["destroying", "destroyed", "failed"]);

const USABLE_STATES: ReadonlySet<MarsSessionState> = new Set<MarsSessionState>(["ready", "detached"]);

export const marsSessionState = (wire: string | undefined): MarsSessionState =>
  STATE_BY_WIRE[wire ?? ""] ?? "unspecified";

export function marsEgressAllow(egressProxyUrl: string): string[] {
  const host = new URL(egressProxyUrl).hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error(`MARS_EGRESS_PROXY_URL ${egressProxyUrl} has no host to put on the egress allowlist`);
  return [host];
}

export function marsManifest(opts: {
  name: string;
  template: string;
  agent?: string;
  sizeSlug?: string;
  idleTimeoutSec?: number;
  egressAllow?: readonly string[];
}): string {
  const lines = [`name: ${JSON.stringify(opts.name)}`, `agent: ${JSON.stringify(opts.agent ?? DEFAULT_AGENT)}`];
  if (opts.template) lines.push(`template: ${JSON.stringify(opts.template)}`);
  lines.push("persistent_workspace: true");
  if (opts.sizeSlug) lines.push(`size: ${JSON.stringify(opts.sizeSlug)}`);
  if (opts.idleTimeoutSec) lines.push(`idle_timeout: ${JSON.stringify(`${opts.idleTimeoutSec}s`)}`);
  if (opts.egressAllow?.length) {
    lines.push("egress:");
    for (const host of opts.egressAllow) lines.push(`  - ${JSON.stringify(host)}`);
  }
  lines.push("permissions:", "  default: allow", "  rules:", "    - tool: bash", "      action: allow");
  return `${lines.join("\n")}\n`;
}

interface WireSession {
  id?: string;
  session_id?: string;
  sandbox_id?: string;
  name?: string;
  status?: string;
  template?: string;
  size_slug?: string;
  error_message?: string;
  created_at?: string;
}

const toSummary = (s: WireSession): MarsSessionSummary => ({
  sessionId: s.session_id ?? s.id ?? "",
  sandboxId: s.sandbox_id ?? "",
  name: s.name ?? "",
  state: marsSessionState(s.status),
});

const toInfo = (s: WireSession): MarsSessionInfo => {
  const createdAtMs = s.created_at ? Date.parse(s.created_at) : Number.NaN;
  return {
    ...toSummary(s),
    ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
    ...(s.error_message ? { errorMessage: s.error_message } : {}),
    ...(s.size_slug ? { sizeSlug: s.size_slug } : {}),
    ...(s.template ? { template: s.template } : {}),
  };
};

interface GrpcCallError {
  code?: number;
  details?: string;
  message?: string;
}

const grpcCode = (err: unknown): number | undefined =>
  typeof err === "object" && err !== null ? (err as GrpcCallError).code : undefined;

const isGuestGone = (err: unknown): boolean => {
  const code = grpcCode(err);
  return code === GRPC_NOT_FOUND || code === GRPC_UNAVAILABLE;
};

type ProtoLoader = typeof import("@grpc/proto-loader");
type Grpc = typeof import("@grpc/grpc-js");

interface GrpcDuplex {
  write(msg: unknown): void;
  end(): void;
  cancel(): void;
  on(event: string, cb: (arg: never) => void): void;
}

type GrpcWritable = Pick<GrpcDuplex, "write" | "end" | "on">;
type GrpcReadable = Pick<GrpcDuplex, "on" | "cancel">;

interface SandboxAgent {
  Exec(): GrpcDuplex;
  Upload(cb: (err: unknown, res?: { bytes_written?: string }) => void): GrpcWritable;
  Download(req: unknown): GrpcReadable;
  close(): void;
}

interface ExecOutputFrame {
  output?: "stdout" | "stderr" | "exit";
  stdout?: Buffer;
  stderr?: Buffer;
  exit?: { exit_code?: number; hitl_rejected?: boolean; timed_out?: boolean };
}

interface DownloadFrame {
  output?: "header" | "chunk" | "end";
  chunk?: Buffer;
}

let grpcModules: Promise<[ProtoLoader, Grpc]> | null = null;

function loadGrpc(): Promise<[ProtoLoader, Grpc]> {
  grpcModules ??= Promise.all([
    import("@grpc/proto-loader").catch((e: unknown) => {
      throw new Error(`@grpc/proto-loader is not installed: ${errMessage(e)}`);
    }),
    import("@grpc/grpc-js").catch((e: unknown) => {
      throw new Error(`@grpc/grpc-js is not installed: ${errMessage(e)}`);
    }),
  ]) as Promise<[ProtoLoader, Grpc]>;
  return grpcModules;
}

async function dialSandboxAgent(localPort: number): Promise<SandboxAgent> {
  const [loader, grpc] = await loadGrpc();
  const definition = loader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    do: {
      teams: {
        hosted_agents: {
          runtime: {
            sandbox_agent: {
              v1: {
                SandboxAgentService: new (
                  addr: string,
                  creds: ReturnType<Grpc["credentials"]["createInsecure"]>,
                  options: Record<string, number>,
                ) => SandboxAgent;
              };
            };
          };
        };
      };
    };
  };
  const Service = pkg.do.teams.hosted_agents.runtime.sandbox_agent.v1.SandboxAgentService;
  return new Service(`127.0.0.1:${localPort}`, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": MAX_EXEC_OUTPUT_BYTES,
    "grpc.max_send_message_length": MAX_EXEC_OUTPUT_BYTES,
  });
}

export function createSdkMarsClient(opts: SdkMarsClientOptions): MarsClient {
  const apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const maxCommandMs = opts.maxCommandMs ?? DEFAULT_MAX_COMMAND_MS;
  const egressAllow = opts.egressProxyUrl ? marsEgressAllow(opts.egressProxyUrl) : undefined;

  function send(method: string, path: string, body?: string, contentType?: string, signal?: AbortSignal) {
    return fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiToken}`,
        accept: "application/json",
        ...(contentType ? { "content-type": contentType } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  function call(
    method: string,
    path: string,
    body?: string,
    contentType?: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const operation = (signal?: AbortSignal): Promise<Response> => send(method, path, body, contentType, signal);
    return method === "GET" || method === "DELETE"
      ? fetchWithRetry((signal) => operation(signal), "idempotent", { timeoutMs })
      : operation(AbortSignal.timeout(timeoutMs));
  }

  async function failure(action: string, sessionId: string, res: Response): Promise<Error> {
    const raw = await res.text().catch(() => "");
    let message = raw.slice(0, 200);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      message = raw.slice(0, 200);
    }
    const detail = withRequestId(`http ${res.status} ${message}`, res.headers);
    if (res.status === 404 || res.status === 410) return new MarsSandboxGoneError(sessionId, detail);
    return new Error(`mars ${action}: ${detail}`);
  }

  async function callJson<T>(
    method: string,
    path: string,
    sessionId: string,
    body?: string,
    contentType?: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const res = await call(method, path, body, contentType, timeoutMs);
    if (!res.ok) throw await failure(`${method} ${path}`, sessionId, res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const getInfo = async (sessionId: string): Promise<MarsSessionInfo> => {
    const body = await callJson<{ session?: WireSession }>("GET", `/v2/agents/sessions/${sessionId}`, sessionId);
    if (!body.session) throw new MarsSandboxGoneError(sessionId, "response carried no session");
    return toInfo(body.session);
  };

  async function awaitUsable(sessionId: string): Promise<MarsSessionInfo> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let resumed = false;
    for (;;) {
      const info = await getInfo(sessionId);
      if (USABLE_STATES.has(info.state)) return info;
      if (GONE_STATES.has(info.state))
        throw new MarsSandboxGoneError(sessionId, info.errorMessage ?? `status ${info.state}`);
      if (info.state === "paused" && !resumed) {
        resumed = true;
        await callJson<void>("POST", `/v2/agents/sessions/${sessionId}/resume`, sessionId);
      }
      if (Date.now() >= deadline)
        throw new Error(`mars session ${sessionId} did not become ready within ${READY_TIMEOUT_MS}ms`);
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  }

  function buildSession(info: MarsSessionInfo): MarsSession {
    const sessionId = info.sessionId;
    let guest: Promise<{ tunnel: MarsTunnel; agent: SandboxAgent }> | null = null;

    const connect = (): Promise<{ tunnel: MarsTunnel; agent: SandboxAgent }> =>
      (guest ??= (async () => {
        const tunnel = await openMarsTunnel({
          apiBaseUrl,
          sessionId,
          remotePort: SANDBOX_AGENT_PORT,
          getToken: async () => opts.apiToken,
        });
        try {
          return { tunnel, agent: await dialSandboxAgent(tunnel.localPort) };
        } catch (e) {
          await tunnel.close();
          throw e;
        }
      })().catch((e: unknown) => {
        guest = null;
        throw e;
      }));

    async function disconnect(): Promise<void> {
      const pending = guest;
      guest = null;
      if (!pending) return;
      await pending
        .then(async ({ tunnel, agent }) => {
          agent.close();
          await tunnel.close();
        })
        .catch(() => undefined);
    }

    const guestDetail = async (err: unknown): Promise<string> => {
      const tunnelFailure = await guest
        ?.then(({ tunnel }) => tunnel.lastFailure())
        .catch(() => null)
        .then((v) => v ?? null);
      return tunnelFailure ?? errMessage(err);
    };

    return {
      sessionId,
      sandboxId: info.sandboxId,

      async runCommand(command, runOpts): Promise<MarsCommandResult> {
        const { agent } = await connect();
        const timeoutMs = Math.min(runOpts?.timeoutMs ?? maxCommandMs, maxCommandMs);
        return new Promise<MarsCommandResult>((resolve, reject) => {
          const stream = agent.Exec();
          const out: Buffer[] = [];
          const errOut: Buffer[] = [];
          let outBytes = 0;
          let errBytes = 0;
          let exit: { exit_code?: number; hitl_rejected?: boolean } | undefined;
          let settled = false;
          const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            fn();
          };

          stream.on("data", ((frame: ExecOutputFrame) => {
            if (frame.stdout && outBytes < MAX_EXEC_OUTPUT_BYTES) {
              out.push(frame.stdout);
              outBytes += frame.stdout.length;
            }
            if (frame.stderr && errBytes < MAX_EXEC_OUTPUT_BYTES) {
              errOut.push(frame.stderr);
              errBytes += frame.stderr.length;
            }
            if (frame.exit) exit = frame.exit;
          }) as (arg: never) => void);

          stream.on("error", ((err: unknown) => {
            settle(() => {
              void disconnect();
              void guestDetail(err).then((detail) => {
                reject(
                  isGuestGone(err)
                    ? new MarsCommandLostError(sessionId, detail)
                    : new Error(`mars exec failed: ${detail}`),
                );
              });
            });
          }) as (arg: never) => void);

          stream.on("end", (() => {
            settle(() => {
              if (exit?.hitl_rejected) {
                reject(new MarsHitlRejectedError(sessionId));
                return;
              }
              resolve({
                stdout: Buffer.concat(out).toString("utf8"),
                stderr: Buffer.concat(errOut).toString("utf8"),
                exitCode: exit?.exit_code ?? -1,
              });
            });
          }) as (arg: never) => void);

          stream.write({
            start: {
              argv: ["/bin/bash", "-c", command],
              ...(runOpts?.workdir ? { workdir: runOpts.workdir } : {}),
              ...(runOpts?.env ? { env: runOpts.env } : {}),
              timeout_seconds: Math.ceil(timeoutMs / 1000),
            },
          });
          stream.end();
        });
      },

      async readFileBytes(absPath): Promise<Uint8Array | null> {
        const { agent } = await connect();
        return new Promise<Uint8Array | null>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const stream = agent.Download({ path: absPath, as_archive: false, chunk_size_bytes: DOWNLOAD_CHUNK_BYTES });
          let settled = false;
          const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            fn();
          };
          stream.on("data", ((frame: DownloadFrame) => {
            if (frame.chunk?.length) chunks.push(frame.chunk);
          }) as (arg: never) => void);
          stream.on("error", ((err: unknown) => {
            settle(() => {
              if (grpcCode(err) === GRPC_NOT_FOUND) {
                resolve(null);
                return;
              }
              void disconnect();
              void guestDetail(err).then((detail) =>
                reject(
                  grpcCode(err) === GRPC_UNAVAILABLE
                    ? new MarsSandboxGoneError(sessionId, detail)
                    : new Error(`mars download ${absPath} failed: ${detail}`),
                ),
              );
            });
          }) as (arg: never) => void);
          stream.on("end", (() => settle(() => resolve(new Uint8Array(Buffer.concat(chunks))))) as (
            arg: never,
          ) => void);
        });
      },

      async writeFileBytes(absPath, data): Promise<void> {
        const { agent } = await connect();
        await new Promise<void>((resolve, reject) => {
          const stream = agent.Upload((err: unknown) => {
            if (!err) {
              resolve();
              return;
            }
            void disconnect();
            void guestDetail(err).then((detail) =>
              reject(
                isGuestGone(err)
                  ? new MarsSandboxGoneError(sessionId, detail)
                  : new Error(`mars upload ${absPath} failed: ${detail}`),
              ),
            );
          });
          stream.write({ header: { path: absPath, mode: 0o644, is_archive: false } });
          for (let offset = 0; offset < data.length; offset += UPLOAD_CHUNK_BYTES)
            stream.write({ chunk: Buffer.from(data.subarray(offset, offset + UPLOAD_CHUNK_BYTES)) });
          stream.write({ end: {} });
          stream.end();
        });
      },

      async pause(): Promise<void> {
        await disconnect();
        await callJson<void>("POST", `/v2/agents/sessions/${sessionId}/pause`, sessionId);
      },

      async resume(): Promise<void> {
        await callJson<void>("POST", `/v2/agents/sessions/${sessionId}/resume`, sessionId);
      },

      async kill(): Promise<void> {
        await disconnect();
        await callJson<void>("DELETE", `/v2/agents/sessions/${sessionId}`, sessionId);
      },
    };
  }

  return {
    nativePause: true,

    info: getInfo,

    async create(createOpts): Promise<MarsSession> {
      const manifest = marsManifest({
        name: createOpts.name,
        template,
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.sizeSlug ? { sizeSlug: opts.sizeSlug } : {}),
        ...(opts.idleTimeoutSec ? { idleTimeoutSec: opts.idleTimeoutSec } : {}),
        ...((createOpts.egressAllow ?? egressAllow) ? { egressAllow: createOpts.egressAllow ?? egressAllow } : {}),
      });
      const body = await callJson<{ session?: WireSession }>(
        "POST",
        "/v2/agents/sessions",
        createOpts.name,
        manifest,
        "application/x-yaml",
        CREATE_TIMEOUT_MS,
      );
      const created = body.session ? toSummary(body.session) : null;
      if (!created?.sessionId) throw new Error("mars create session: response carried no session id");
      return buildSession(await awaitUsable(created.sessionId));
    },

    async connect(sessionId): Promise<MarsSession> {
      return buildSession(await awaitUsable(sessionId));
    },

    async list(name): Promise<MarsSessionSummary[]> {
      const body = await callJson<{ sessions?: WireSession[] }>(
        "GET",
        `/v2/agents/sessions?name=${encodeURIComponent(name)}`,
        name,
      );
      return (body.sessions ?? []).map(toSummary).filter((s) => s.name === name && !GONE_STATES.has(s.state));
    },

    async kill(sessionId): Promise<void> {
      await callJson<void>("DELETE", `/v2/agents/sessions/${sessionId}`, sessionId);
    },
  };
}
