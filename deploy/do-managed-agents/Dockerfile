# QM sandbox image for DigitalOcean Managed Agents (Harness Runtime BYOT).
# Registered on the agentless `sandbox` base; see docs/managed-agents.md.
FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl wget jq tar xz-utils unzip zip ripgrep \
    python3 python3-pip python3-venv \
    openssh-client gnupg less vim-tiny procps \
  && rm -rf /var/lib/apt/lists/* \
  && node --version && npm --version

# The platform owns /workspace and ignores USER, so the image creates no user or
# workspace; it only points HOME at the home the adapter manages. Clear node's
# REPL entrypoint so the session process stays up.
ENV HOME=/workspace/home
ENTRYPOINT ["sleep", "infinity"]
CMD []
