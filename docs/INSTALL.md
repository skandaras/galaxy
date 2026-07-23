# Installing Galaxy on an Ubuntu server

This guide takes a clean Ubuntu server (22.04/24.04) to a running Galaxy
deployment: **prod** and **dev** instances in Docker behind your reverse proxy
and Authelia, with sandboxed coding runners, CI-built images, backups, and the
dev → prod promotion flow.

## 1. Prerequisites

```sh
# Docker Engine + compose plugin (skip if already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # re-login afterwards
```

Already in place on your side (not covered here): a reverse proxy
(Caddy/Traefik/NPM) terminating TLS, and Authelia protecting your domains.

## 2. Get the deployment files

```sh
mkdir -p /opt/galaxy && cd /opt/galaxy
curl -fsSLO https://raw.githubusercontent.com/skandaras/galaxy/main/docker-compose.yml
```

Create `/opt/galaxy/.env`:

```sh
# IP or CIDR of your reverse proxy as the galaxy containers see it —
# identity headers are ONLY trusted from here. For a proxy on the same
# docker network this is that network's subnet, e.g. 172.18.0.0/16.
TRUSTED_PROXY_IPS=172.18.0.0/16
```

Optional per-instance env you may add in `docker-compose.yml`:

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | 64 hex chars; master key for encrypting API keys. If unset, a key file is generated in the data volume (back it up!). `openssl rand -hex 32` |
| `ADMIN_GROUP` | Authelia group granting admin (default `galaxy-admins`) |
| `GITHUB_REPO` | `owner/repo` used by the Promote button (default `skandaras/galaxy`) |
| `DEV_HEALTH_URL` | e.g. `http://galaxy-dev:3000/healthz` — promotion gate: Promote refuses if dev is unhealthy |
| `RUNNER_IMAGE`, `DATA_VOLUME`, `RUNNER_NETWORK`, `DOCKER_API_URL`, `CODING_EXECUTOR` | Coding sandbox wiring — defaults are already in the compose file; `DATA_VOLUME` must match the compose project's real volume name (`docker volume ls`) |

## 3. Reverse proxy + Authelia

Galaxy trusts `Remote-User`, `Remote-Email`, `Remote-Groups`, `Remote-Name`
headers **only** from `TRUSTED_PROXY_IPS`. Wire your proxy so Authelia
authenticates the domain and the headers are forwarded. Caddy example:

```caddy
ai.example.com {
    forward_auth authelia:9091 {
        uri /api/verify?rd=https://auth.example.com
        copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
    }
    reverse_proxy galaxy-prod:3000
}

dev-ai.example.com {
    forward_auth authelia:9091 {
        uri /api/verify?rd=https://auth.example.com
        copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
    }
    reverse_proxy galaxy-dev:3000
}
```

In Authelia, create a `galaxy-admins` group and add yourself. Users are
auto-provisioned on first visit; group members get the Admin nav.

The compose file expects your proxy's docker network to exist as `proxy`
(`networks: proxy: external: true`) — change the name to match yours.

## 4. First start

```sh
cd /opt/galaxy
docker compose pull
docker compose up -d
curl -s http://<container-ip>:3000/healthz   # or open the dev subdomain
```

Migrations run automatically on boot. Visit the **dev** subdomain first:

1. **Admin → Providers**: add OpenRouter (or any OpenAI-compatible endpoint),
   paste the API key, hit **Sync models**.
2. **Admin → Models**: enable the models you want (synced models start
   disabled on purpose — aggregators list hundreds).
3. **Admin → Tasks**: pick primary + backup models per task (coding needs a
   tool-capable model — the `T` badge).
4. **Admin → Settings**: web search provider, budget cap, GitHub PAT
   (fine-grained; Contents read/write on the repos you'll code in, plus
   workflow scope if you want the Promote button), memory schedule.

## 5. Coding runners (sandbox)

Coding sessions execute every agent command in a throwaway container. The
compose file already runs `docker-socket-proxy` and points both instances at
it. Build/pull the runner image once:

```sh
docker build -t ghcr.io/skandaras/galaxy-runner:latest \
  https://github.com/skandaras/galaxy.git#main:runner
```

Check `DATA_VOLUME` matches reality: `docker volume ls | grep galaxy` — the
compose project prefixes volume names (e.g. `galaxy_galaxy-dev-data`).

If a coding session errors with "Runner create failed", inspect the
socket-proxy logs; the proxy only permits container lifecycle calls.

## 6. CI, dev deploys, promotion

- Every green push to `main` builds `ghcr.io/skandaras/galaxy:dev` (see
  `.github/workflows/ci.yml`; the end-to-end smoke suite is the gate).
- The **dev** container follows `:dev`. Auto-update it with watchtower:

```sh
docker run -d --name watchtower --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower --interval 300 --cleanup galaxy-dev galaxy-prod
```

- **Promote** (Admin → Settings → Deployment) dispatches the Promote
  workflow: it retags `stable → stable-prev`, then `dev → stable`. Prod
  follows `:stable`, so watchtower rolls it out. **Rollback** restores
  `stable-prev`. Without watchtower: `docker compose pull && docker compose up -d`.
- The promotion gate: with `DEV_HEALTH_URL` set, Promote refuses while dev
  is unhealthy.

## 7. Backups

Everything lives in the two data volumes (SQLite DB, library, skills repo,
uploads, encryption key). Nightly cron example:

```sh
cat > /etc/cron.daily/galaxy-backup <<'EOF'
#!/bin/sh
set -e
STAMP=$(date +%F)
for VOL in galaxy_galaxy-prod-data galaxy_galaxy-dev-data; do
  docker run --rm -v $VOL:/data:ro -v /backup/galaxy:/out alpine \
    sh -c "sqlite3 /data/galaxy.db '.backup /tmp/galaxy.db' 2>/dev/null || cp /data/galaxy.db /tmp/galaxy.db; \
           tar czf /out/$VOL-$STAMP.tgz -C / tmp/galaxy.db data/library data/skills data/themes 2>/dev/null || true"
done
find /backup/galaxy -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/galaxy-backup
```

(Or point restic/borg at `/var/lib/docker/volumes/<vol>/_data`.) **Restore** =
stop the container, untar into the volume, start.

## 8. Local development (no Docker)

```sh
git clone https://github.com/skandaras/galaxy && cd galaxy
cp .env.example .env        # AUTH_MODE=dev bypasses Authelia
npm install && npm run dev
# tests + the same smoke CI runs:
npm test && npm run build && bash scripts/smoke-e2e.sh
```

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403 Forbidden: request did not arrive via the trusted proxy` | `TRUSTED_PROXY_IPS` doesn't cover the proxy's address as seen by the container (check `docker network inspect`) |
| `401 Unauthorized: no identity headers` | Authelia isn't injecting `Remote-User` — check `copy_headers` / forward-auth config |
| Model dropdown empty | Provider added but models not synced, or none enabled in Admin → Models |
| Coding refuses model | The selected model lacks tool support — pick one with the `T` badge |
| `Budget cap reached` | Raise/disable in Admin → Settings, or wait for the period to roll over |
| Promote button errors | GitHub PAT missing workflow scope, or `GITHUB_REPO` wrong, or dev unhealthy (gate) |
| Memory never runs | Admin → Memory: enabled? interval? It also skips when there's no new activity |

The Observatory (left pane, or `/observatory`) shows every model call, tool
use and failure — it's the first place to look when behaviour is puzzling.
