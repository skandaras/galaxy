# ✦ Galaxy

A lightweight, self-hosted, **model-agnostic** AI workspace: agentic chat with web
search and deep research, plus a coding agent that works directly in GitHub repos —
including this one, which it maintains itself (build on dev, promote to prod).

See [PLAN.md](./PLAN.md) for the full architecture, feature map, and milestones. See [docs/INSTALL.md](./docs/INSTALL.md) for the Ubuntu server installation guide
(Docker, reverse proxy + Authelia, runners, backups, promotion).

## Development

```sh
cp .env.example .env       # AUTH_MODE=dev bypasses Authelia locally
npm install
npm run db:generate        # regenerate migrations after schema changes
npm run dev
```

- `npm test` — unit tests (Vitest)
- `npm run check` — type checks
- `npm run build && npm start` — production build (adapter-node)

## Deployment

Two instances of one image behind your reverse proxy + Authelia — see
`docker-compose.yml`. CI builds `ghcr.io/skandaras/galaxy:dev` from every green
`main` build; promotion retags `:dev` → `:stable`.

| Env var | Purpose |
|---|---|
| `DATA_DIR` | SQLite DB + library/skills/uploads/themes (default `/data` in Docker) |
| `GALAXY_ENV` | `dev` or `prod` — badge in the UI |
| `AUTH_MODE` | `authelia` (trusted headers) or `dev` (local bypass) |
| `TRUSTED_PROXY_IPS` | IPs/CIDRs allowed to supply identity headers |
| `ADMIN_GROUP` | Authelia group granting the admin role (default `galaxy-admins`) |
