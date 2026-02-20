# OpenClaw Headless Production Runbook (Netcup + Matrix)

> Purpose: a single place to track **what is deployed**, **why**, and **how to verify/rollback**.
> This file intentionally contains **no secrets** (no passwords, access tokens, shared secrets).

## Scope

- Production deployment target: Netcup server `159.195.32.188`
- Operator comms channel: self-hosted Matrix/Synapse at `https://matrix.versusfuture.com`
- Operator Matrix ID: `@mariusz:matrix.versusfuture.com`
- Bot Matrix ID: `@zed:matrix.versusfuture.com`

## High-level security goals

- Keep OpenClaw Gateway **non-public** (loopback-only).
- Keep Matrix/Synapse **public** (TLS) for operator comms.
- Disable optional discovery / broadcast features (e.g. mDNS/Bonjour) on a headless public server.
- Disable Control UI.
- Ensure DM allowlisting is enforced for the Matrix bot.
- Preserve a clear, non-confusing “source of truth” for what binary/config systemd runs.

## Deployed services and ports

### Public listeners (expected)

- `tcp/22` SSH
- `tcp/80` + `tcp/443` reverse proxy (Caddy) for Matrix/Synapse

### Loopback-only listeners (expected)

- OpenClaw Gateway WebSocket: `127.0.0.1:18789` (and `::1:18789`)
- Gateway HTTP auxiliary server: `127.0.0.1:18792`
- Temporal gRPC: `127.0.0.1:7233`
- Temporal UI: `127.0.0.1:8080`

### Discovery / broadcast (must be disabled)

- mDNS/Bonjour (UDP 5353) **must not** be listening.

## Paths on the server

### OpenClaw

- Runtime install directory: `/opt/openclaw`
- OpenClaw home:
  - `OPENCLAW_HOME=/home/openclaw`
  - config: `/home/openclaw/.openclaw/openclaw.json`

### Matrix/Synapse

- Synapse deployment directory: `/opt/matrix`
  - `docker-compose.yml`
  - `synapse/homeserver.yaml`
  - `Caddyfile`
  - secrets (permissions: `chmod 600`):
    - `/opt/matrix/operator.txt`
    - `/opt/matrix/bot.json`

## systemd: OpenClaw gateway

### Unit file

- `/etc/systemd/system/openclaw-gateway.service`

### ExecStart (source of truth)

The running service must use the Temporal-enabled build:

- `/usr/bin/node /opt/openclaw/dist/entry.js gateway --bind loopback --port 18789`

### Hardening / environment

We disable mDNS/Bonjour advertising (prevents UDP 5353 binding):

- `Environment=OPENCLAW_DISABLE_BONJOUR=1`

> Note: We attempted to disable Bonjour via config (`gateway.discovery.mdns.mode=off`) but the deployed build rejected `gateway.discovery` as an unknown key. The env var approach is compatible and effective.

## CLI path deconfliction (avoid “multiple OpenClaw versions” confusion)

### Current desired behavior

- Running `openclaw ...` should match the systemd-deployed runtime.

### Implementation

- `/usr/local/bin/openclaw` is a wrapper that execs the runtime in `/opt/openclaw`.
- Any duplicate root-only wrapper (e.g. `/root/.local/bin/openclaw`) should be removed.
- Do **not** install upstream `openclaw@latest` globally via npm on this host unless it is known-compatible with our config schema (it was not, due to `temporal` config).

## Synapse hardening checklist

Synapse is configured as a single-tenant control plane:

- federation disabled
- registration disabled (after bootstrap)
- URL previews disabled
- stats/reporting disabled

(See `/opt/matrix/synapse/homeserver.yaml` for the authoritative settings.)

## OpenClaw configuration: critical security settings

In `/home/openclaw/.openclaw/openclaw.json`:

- `gateway.bind = "loopback"`
- `gateway.controlUi.enabled = false`

Gateway HTTP hardening (Phase 5):

- Plugin HTTP routes/handlers are **auth-required by default**.
  - If you need a public webhook-style plugin endpoint, explicitly allowlist it via:
    - `gateway.pluginHttp.publicPaths = ["/some/path", "/prefix/*"]`
  - `/api/channels/*` stays auth-required regardless.
- `POST /tools/invoke` (gateway HTTP tool execution surface) has a tightened default denylist.
  - High-risk tools like `exec`, `shell`, `spawn`, `fs_*`, `apply_patch` are denied by default.
  - Explicit override is possible via `gateway.tools.allow`, but treat this as a last resort.
- Control UI guardrail: if Control UI is enabled, non-local requests require gateway auth.
  - If gateway auth mode is `none`, non-local Control UI requests are **forbidden**.

Matrix channel (operator comms):

- E2EE enabled
- DMs allowlisted (only operator user ID)
- rooms disabled

> Do not store access tokens/passwords in this repo.

## Operational commands

### Check listeners

```bash
ss -ltnp
ss -lunp
```

Expected:

- `18789` and `18792` only on `127.0.0.1` / `::1`
- **no** UDP listeners for OpenClaw (especially none on `:5353`)

### Gateway service status

```bash
systemctl status openclaw-gateway --no-pager -l
journalctl -u openclaw-gateway --no-pager -n 200
```

### Matrix stack status

```bash
cd /opt/matrix
docker compose ps
docker compose logs --tail=200
```

### Temporal stack status

```bash
cd /opt/temporal
docker compose ps
```

## Phase 4 probe results (summary)

- Only `22/80/443` are public.
- OpenClaw Gateway is loopback-only.
- Control UI is not served.
- `/tools/invoke` requires gateway auth (returns 401 without token).
- mDNS/Bonjour disabled via `OPENCLAW_DISABLE_BONJOUR=1`.

## Rollback guidance

### If the gateway fails to start after config changes

1. Restore the last known-good config backup:

```bash
ls -1t /home/openclaw/.openclaw/openclaw.json.bak.* | head
cp -a /home/openclaw/.openclaw/openclaw.json.bak.<timestamp> /home/openclaw/.openclaw/openclaw.json
chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json
chmod 600 /home/openclaw/.openclaw/openclaw.json
systemctl restart openclaw-gateway
```

2. If systemd unit changes broke startup, restore the last unit backup:

```bash
ls -1t /etc/systemd/system/openclaw-gateway.service.bak.* | head
cp -a /etc/systemd/system/openclaw-gateway.service.bak.<timestamp> /etc/systemd/system/openclaw-gateway.service
systemctl daemon-reload
systemctl restart openclaw-gateway
```

## Next phase (Phase 5: code hardening)

Priorities:

1. Control UI guardrail: refuse to start (or require auth) when enabled on non-loopback.
2. Tighten `/tools/invoke` HTTP defaults: add a stronger default deny list (ensure `exec` is not remotely invokable by default).
3. Plugin HTTP routes: default to auth-required unless explicitly declared public.
