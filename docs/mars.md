# MARS agent sandboxes

The `mars` backend runs each QM scope in a DigitalOcean MARS microVM with a
persistent home, file transfers, and background process sessions. Paused
sessions resume on use.

MARS normally runs its own agent loop inside the microVM. Core does not use it.
The session manifest says `agent: none`, which MARS admits as a bare sandbox:
it lands on MARS's own base template with no managed agent, no in-guest
event-translation runtime, and no model credential. Core
drives the microVM itself over exec and workspace transfer, so the agent stays
in core exactly as it does for every other backend. See
[the design record](../adrs/mars-sandbox-backend.md) for why.

## Configure

```sh
SANDBOX_BACKEND=mars
MARS_API_TOKEN=dop_v1_your-digitalocean-iam-token
MARS_NAME_PREFIX=my-qm
MARS_SNAPSHOT_S3_BUCKET=my-qm-sandbox-homes
```

One credential, one endpoint. The IAM token carries the team identity that owns
the sessions, and it authenticates both halves of the integration: the session
lifecycle REST calls and the WebSocket tunnel that carries commands and files.
Nothing else needs provisioning — no client certificates, no internal
hostnames.

Store the token as a core service secret. Production requires `DATABASE_URL`
for session records and provisioning locks across instances. Use a distinct
name prefix for each independent deployment sharing a MARS team, including
development instances.

## How core reaches the guest

Session lifecycle goes to `https://api.digitalocean.com/v2/agents/sessions` over
ordinary REST.

Commands and file transfer take a different path. Every MARS microVM runs
`sandbox-agent`, a gRPC server on guest port 8443 that MARS's own control plane
uses for exec, file transfer, and readiness probing. Core reaches it the same
way `doctl agents port-forward` does: it opens a WebSocket to
`/v2/agents/sessions/{id}/port-forward/8443`, which the control plane bridges to the
guest port, and exposes the result as a local TCP listener that a gRPC client
dials. Guest port 8443 is explicitly allowed by the tunnel's port policy, and
the port-forward route carries no request deadline, so a command is limited
only by `SANDBOX_TIMEOUT_SEC`.

Core deliberately does not use the REST `POST /v2/agents/sessions/{id}/sandbox/exec`. That
endpoint buffers output in the control plane, so it clamps commands to four
minutes and one mebibyte per stream and carries no per-command environment —
all three are below what an agent turn needs.

Core must be able to reach `api.digitalocean.com`, and the microVMs must be
able to reach core's public API for the connector SDK and file callbacks. That
second direction is the one that catches people out: `PUBLIC_API_URL` has to be
a host the microVM can resolve, so a deployment behind `localhost` serves shell
commands fine but cannot complete a cron, a send, or a credential fetch.

File transfer is confined to the guest workspace, so a scope's home lives at
`/workspace/home` rather than the usual `/home/user`. That also places it inside
the volume MARS preserves, so the home survives pause and resume on its own.

## What a scope sees

Nothing is provisioned when core boots. A turn that needs no shell never
touches MARS. The first execute-family tool call is what creates the session,
waits for it to report ready, opens the tunnel, and runs the command — about
ten seconds end to end. Every later turn for that scope reconnects to the same
microVM in well under a second, because the session name is derived from the
scope: core tries its stored session id, then asks MARS to list anything
matching the name, and only creates when both come up empty.

Each person and each room gets its own microVM, isolated at the hypervisor.
Teardown pauses rather than destroys, so files and installed packages persist
between conversations. When MARS reclaims an idle session, the next command
finds it absent, provisions a replacement, and hydrates the home from the last
snapshot — the only visible effect is a slower first command.

With `EAGER_PROVISION` left at its default, a scope that has used tools before
starts provisioning at the top of every turn rather than waiting for the model
to ask, which hides the cold start. Set `EAGER_PROVISION=0` to see the strictly
on-demand path.

## Settings

| Variable                     | Default                        | Purpose                                                           |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `MARS_API_TOKEN`             | Required                       | DigitalOcean IAM token, held by core.                             |
| `MARS_API_BASE_URL`          | `https://api.digitalocean.com` | Control-plane endpoint override; any path prefix is preserved.    |
| `MARS_TEMPLATE`              | Provider bare base             | Template override; unset means the bare base `agent: none` picks. |
| `MARS_NAME_PREFIX`           | `qm`                           | Namespace for scope discovery.                                    |
| `MARS_SIZE_SLUG`             | Provider default               | microVM size.                                                     |
| `MARS_IDLE_TIMEOUT_SEC`      | Provider default               | Provider-side idle pause backstop when no core is sweeping.       |
| `MARS_EGRESS_PROXY_URL`      | Unset                          | Proxy host to allow; everything else is denied.                   |
| `MARS_SNAPSHOT_S3_BUCKET`    | Unset                          | Portable home tars. Without it the backend reports no recovery.   |
| `MARS_SNAPSHOT_INTERVAL_SEC` | `300`                          | Snapshot throttle.                                                |
| `SANDBOX_TIMEOUT_SEC`        | `600`                          | Default command deadline in seconds.                              |

Session names are derived from the scope and the name prefix, so an operator
can find a scope's microVM in the MARS console without consulting core's
database. MARS caps them at 64 characters and rejects UUID-shaped names.

Command output is limited to 16 MiB per stream; write larger results to files.

Sessions are created with a permissions block that allows `bash` outright.
MARS has its own human-in-the-loop gate on command execution, and leaving it
on would hold every command behind an approval nobody is watching — core's
own approval gates stay authoritative.

Without `MARS_EGRESS_PROXY_URL`, sandboxes have unrestricted egress and the
profile reports no enforcement. With it, sessions are created denying all
outbound traffic except the proxy host, so the `HTTPS_PROXY` environment cannot
be bypassed from inside the microVM.

`MARS_SNAPSHOT_S3_BUCKET` is how a scope's home survives losing its session.
MARS does expose session checkpoints, but core does not use them yet, so
without the bucket a destroyed session takes the home with it. Set it. See
[sandbox recovery](sandbox-preservation.md) for the capture and hydration
rules.

The bare base image carries `bash`, `git`, `curl`, `tar`, `node`, `python3`,
`make` and `gcc`. It does not carry `jq`, `rg` or `unzip`, which agent prompts
reach for by name; the profile reports them as not installed, and a template of
your own named in `MARS_TEMPLATE` is how you add them.

## Local development

```sh
export MARS_API_TOKEN=dop_v1_...
bash scripts/dev-instance.sh up --surface web --sandbox mars
```

Two things differ from the other backends. `dev-instance` reads provider
secrets from your shell or `~/.config/qm/dev.env`, not from the worktree
`.env`, so the token has to be exported. And a live slot reloads from its
persisted boot spec, so changing `--sandbox` on a running slot keeps the old
backend — take it down first.

## Tests

Backend tests run without an account. The client tests stand up an in-process
control plane, a real gRPC `sandbox-agent`, and a WebSocket tunnel between them,
so the transport is exercised end to end:

```sh
node --test test/mars-client.test.ts test/mars-sandbox.test.ts
```

Two smokes exercise a real account. The first provisions a microVM and runs
commands, files, and a pause cycle through the `Sandbox` interface; set
`MARS_SMOKE_LONG=1` to add a 250-second command that outlives the REST exec
clamp. The second drives a live model turn against a running core and asserts
the reply carries output that could only have come from the guest.

```sh
MARS_API_TOKEN=dop_v1_... npm run smoke:mars-sandbox
CORE_SIGNING_SECRET=... PORTAL_IDENTITY_SECRET=... npm run smoke:mars-turn
```
