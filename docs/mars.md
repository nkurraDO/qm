# MARS agent sandboxes

The `mars` backend runs each QM scope in a DigitalOcean MARS microVM with a
persistent home, file transfers, and background process sessions. Paused
sessions resume on use.

MARS normally runs its own agent loop inside the microVM. Core does not use it.
The session manifest says `agent: none`, which MARS admits as a bare sandbox:
it lands on MARS's own base template with no managed agent, no Open Harness
Runtime, no Open Harness Pulse event stream, and no model credential. Core
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
`/v2/agents/sessions/{id}/port-forward/8443`, which harness-api bridges to the
guest port, and exposes the result as a local TCP listener that a gRPC client
dials. Guest port 8443 is explicitly allowed by the tunnel's port policy, and
the port-forward route carries no request deadline, so a command is limited
only by `SANDBOX_TIMEOUT_SEC`.

Core deliberately does not use harness-api's `POST /sandbox/exec`. That
endpoint buffers output in the control plane, so it clamps commands to four
minutes and one mebibyte per stream and carries no per-command environment —
all three are below what an agent turn needs.

Core must be able to reach `api.digitalocean.com`, and the microVMs must be
able to reach core's public API for the connector SDK and file callbacks.

## Settings

| Variable                     | Default                        | Purpose                                                           |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `MARS_API_TOKEN`             | Required                       | DigitalOcean IAM token, held by core.                             |
| `MARS_API_BASE_URL`          | `https://api.digitalocean.com` | harness-api endpoint override; any path prefix is preserved.      |
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

## Tests

Backend tests run without an account. The client tests stand up an in-process
harness-api, a real gRPC `sandbox-agent`, and a WebSocket tunnel between them,
so the transport is exercised end to end:

```sh
node --test test/mars-client.test.ts test/mars-sandbox.test.ts
```
