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

Everything below happens in your **project directory** — the one holding
`docker-compose.yml`. Compose reads `.env` from there and resolves the
`./searxng/settings.yml` bind mount relative to it, so the location is yours to
choose; it just has to be consistent. This guide uses `/opt/galaxy` as an
example.

```sh
mkdir -p /opt/galaxy/searxng && cd /opt/galaxy
curl -fsSLO https://raw.githubusercontent.com/skandaras/galaxy/main/docker-compose.yml
# The compose file bind-mounts this; without it the searxng container won't start.
curl -fsSL -o searxng/settings.yml \
  https://raw.githubusercontent.com/skandaras/galaxy/main/searxng/settings.yml
```

> **Already installed and not sure where that is?** Ask Docker rather than
> guessing — the `CONFIG FILES` column gives the compose file actually in use,
> and its directory is your project directory:
>
> ```sh
> docker compose ls
> # or, from a running container:
> docker inspect galaxy-prod --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
> ```

> **Upgrading an existing install?** The `searxng` service and its settings file
> were added after the first release. If your `docker-compose.yml` predates it,
> re-download both files above (keeping your `.env`) rather than hand-editing —
> and see §7c for the setup it needs.
>
> If your project directory is also a git clone of this repo, prefer `git pull`
> to `curl`. `.env` is gitignored and safe, but local edits to
> `docker-compose.yml` will conflict.

Create `.env` in that same directory:

```sh
# IP or CIDR of your reverse proxy as the galaxy containers see it —
# identity headers are ONLY trusted from here. For a proxy on the same
# docker network this is that network's subnet, e.g. 172.18.0.0/16.
TRUSTED_PROXY_IPS=172.18.0.0/16
```

**Also set `ORIGIN` per instance** to that instance's public URL (e.g.
`ORIGIN=https://ai.example.com` for prod, `https://dev-ai.example.com` for dev).
SvelteKit's CSRF protection compares the `Origin` header against the server's
own idea of its address; behind a reverse proxy it can't infer that, and
form posts — including **attachment uploads** — are rejected with a 403.

Optional per-instance env you may add in `docker-compose.yml`:

| Variable | Purpose |
|---|---|
| `ORIGIN` | Public URL of this instance. Required behind a proxy or multipart uploads 403 (see above) |
| `BODY_SIZE_LIMIT` | Largest request body accepted. **Already set to `32M` in the compose file and image** — adapter-node's own default is 512K, which rejects attachment uploads well below the app's 5 MB image / 25 MB document limits. Lower it only if you want to cap uploads more tightly |
| `SECRET_KEY` | 64 hex chars; master key for encrypting API keys. If unset, a key file is generated in the data volume (back it up!). `openssl rand -hex 32` |
| `ADMIN_GROUP` | Authelia group granting admin (default `galaxy-admins`) |
| `GITHUB_REPO` | `owner/repo` used by the Promote button (default `skandaras/galaxy`) |
| `DEV_HEALTH_URL` | e.g. `http://galaxy-dev:3000/healthz` — promotion gate: Promote refuses if dev is unhealthy |
| `RUNNER_IMAGE`, `DATA_VOLUME`, `RUNNER_NETWORK`, `DOCKER_API_URL`, `CODING_EXECUTOR` | Coding sandbox wiring — defaults are already in the compose file; `DATA_VOLUME` must match the compose project's real volume name (`docker volume ls`) |
| `STREAM_IDLE_TIMEOUT_MS` | How long a model call may send *nothing* before it's treated as stalled (default 90000). This is an idle timeout, not a total one — a long coding turn is fine as long as output keeps arriving |
| `STREAM_TOTAL_TIMEOUT_MS` | Absolute ceiling on one model call, for a provider that trickles forever without finishing (default 1800000) |
| `TOOL_OUTPUT_BUDGET_CHARS` | Tool output carried in one turn before the oldest results are dropped (default 240000). Every result is re-sent on each later step, so this bounds how large a turn's request can grow |
| `TOOL_RESULT_MAX_CHARS` | Per-call cap on a single tool result (default 30000, hard ceiling 60000) |
| `CODING_MAX_STEPS` | Model round-trips one coding turn may take (default 50). Counts round-trips, not tool calls — a model that calls one tool at a time spends one per file read. Raise it for large tasks; the agent continues automatically rather than stopping dead when it runs out |

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
cd /opt/galaxy   # your project directory
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

Coding sessions execute every agent command in a throwaway container on an
isolated network. Three prerequisites must exist before the first session:

**a) The runner image.** CI publishes `ghcr.io/<owner>/galaxy-runner:latest` on
every green push to `main`. It is *not* a compose service (runners are created
at runtime via the Docker API), so `docker compose pull` will **not** fetch it —
pull it explicitly once:

```sh
docker pull ghcr.io/skandaras/galaxy-runner:latest
```

If the GHCR package is private, `docker login ghcr.io` first. To build it
locally instead of pulling:

```sh
docker build -t ghcr.io/skandaras/galaxy-runner:latest ./runner
```

The image must exist on the host before a session starts — the executor creates
containers but never pulls.

**b) The runners network.** The compose file declares `runners` but Compose does
not create a network that no service joins — and no service should join this one,
by design (runners are created at runtime through the Docker API). Create it
once:

```sh
docker network create galaxy_runners
```

Confirm with `docker network ls | grep galaxy_runners`. The name must match
`RUNNER_NETWORK` in the compose file.

> **Why not `--internal`?** Runners need outbound access: `git clone`/`git push`
> and dependency installs (`npm install`, `pip install`) all run *inside* the
> runner. An internal network would break coding against GitHub. The sandbox
> boundary is enforced separately — runners are not attached to the internal
> `docker-api` network, so they can never reach the Docker socket proxy and
> cannot spawn or control containers. Only use `--internal` if you exclusively
> work with local repos and never install dependencies.

**c) Socket-proxy lifecycle permissions** are already set in the compose file
(`ALLOW_START/STOP/RESTARTS/DELETE` on `docker-socket-proxy`). No action needed
unless you override the proxy environment.

Check `DATA_VOLUME` matches reality: `docker volume ls | grep galaxy` — the
compose project prefixes volume names (e.g. `galaxy_galaxy-dev-data`).

### Troubleshooting

| Error | Cause |
|---|---|
| `Runner create failed (4xx)` | Socket proxy denying `/containers/create`, or `RUNNER_IMAGE` not present locally |
| `Runner start failed (404)` | `galaxy_runners` network doesn't exist, or `ALLOW_START` unset on the proxy |
| Dead runners accumulating (`docker ps -a`) | `ALLOW_DELETE` unset — cleanup is failing silently |
| `Clone failed: could not resolve host` | The runners network was created with `--internal` (see above) |

## 6. CI, dev deploys, promotion

- Every green push to `main` builds `ghcr.io/skandaras/galaxy:dev` (see
  `.github/workflows/ci.yml`; the end-to-end smoke suite is the gate).
- The **dev** container follows `:dev`. Pull updates manually:

```sh
docker compose pull galaxy-dev && docker compose up -d galaxy-dev
```
- A cron job is the easiest way to implement an autodeploy on dev.
  (Auto-updaters like watchtower are not recommended here: they reap the
  ephemeral coding-runner containers mid-session, and must in any case be scoped
  to `galaxy-dev` only — never `galaxy-prod`, which must only change via
  Promote. `containrrr/watchtower` is also unmaintained and crash-loops against
  current Docker Engine.)

- **Promote** (Admin → Settings → Deployment) dispatches the Promote
  workflow: it retags `stable → stable-prev`, then `dev → stable`. Prod
  follows `:stable`. **Rollback** restores `stable-prev`. Apply either with
  `docker compose pull galaxy-prod && docker compose up -d galaxy-prod`.
- The promotion gate: with `DEV_HEALTH_URL` set, Promote refuses while dev
  is unhealthy.

## 7. Backups

Everything persists in the two data volumes. A volume holds:

| Path | Contents | Back up? |
|---|---|---|
| `galaxy.db` (+ `-wal`, `-shm`) | chats, messages, settings, skills index, usage, events | **yes** |
| `galaxy.key` | master key encrypting every provider API key and the GitHub PAT | **yes — critical** |
| `library/` | Library markdown documents | yes |
| `skills/` | SKILL.md files (a git repo, with history) | yes |
| `uploads/` | chat attachments | yes |
| `workspaces/` | ephemeral coding-session clones | no — recreated per session |

> **`galaxy.key` is the one that bites.** Lose it and every stored API key and
> the GitHub token become permanently undecryptable — silently, until the next
> model call fails. It is generated once on first boot if `SECRET_KEY` is unset.
> Setting `SECRET_KEY` in the environment instead (and recording it in your
> password manager) removes this failure mode entirely.

Nightly cron:

```sh
cat > /etc/cron.daily/galaxy-backup <<'EOF'
#!/bin/sh
# Fail loudly: a silently-broken backup is worse than no backup.
set -eu
STAMP=$(date +%F)
mkdir -p /backup/galaxy
for VOL in galaxy_galaxy-prod-data galaxy_galaxy-dev-data; do
  docker run --rm -v "$VOL":/data:ro -v /backup/galaxy:/out alpine sh -eu -c "
    apk add -q --no-cache sqlite
    # .backup is WAL-safe on a live database; a bare cp of galaxy.db is not.
    sqlite3 /data/galaxy.db \".backup '/tmp/galaxy.db'\"
    sqlite3 /tmp/galaxy.db 'PRAGMA integrity_check' | grep -qx ok
    cd /data
    tar czf /out/$VOL-$STAMP.tgz -C /tmp galaxy.db -C /data galaxy.key library skills uploads
  "
done
find /backup/galaxy -name '*.tgz' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/galaxy-backup
```

Why it looks like that: the old version piped errors to `/dev/null` and fell back
to `cp`, which on a WAL-mode database can silently produce a corrupt or
stale snapshot; `alpine` also ships without `sqlite3`, so the safe path never
ran. This version installs sqlite, uses `.backup`, verifies the result with
`integrity_check`, and aborts the whole run on any failure.

Verify a backup restores before you need it:

```sh
# inspect
tar tzf /backup/galaxy/galaxy_galaxy-prod-data-$(date +%F).tgz

# restore into a stopped instance
docker compose stop galaxy-prod
docker run --rm -v galaxy_galaxy-prod-data:/data -v /backup/galaxy:/in alpine \
  sh -c 'cd /data && tar xzf /in/galaxy_galaxy-prod-data-YYYY-MM-DD.tgz'
docker compose start galaxy-prod
```

(Or point restic/borg at `/var/lib/docker/volumes/<vol>/_data` — same caveat:
snapshot `galaxy.db` with `.backup`, not a raw file copy of a live database.)

### Does deploying wipe data?

No — and it is worth knowing exactly why, because it is easy to break later:

- All state is in **named volumes** (`galaxy-prod-data:/data`), never in the
  image. `docker compose pull && up -d` destroys and recreates the *container*;
  the volume is untouched. `.dockerignore` excludes `data/`, so no stray copy is
  baked into the image to shadow the mount.
- **Never** run `docker compose down -v` — the `-v` deletes volumes. Plain
  `down`/`up` is safe.
- **Promote/Rollback only retag images.** They never touch volumes.
- Migrations run on boot and are **additive**; a rollback to `:stable-prev` meets
  a newer schema it can still read (added columns are nullable). The single
  exception is documented in the release notes for per-user memory, which
  intentionally clears `memory_items` (and nothing else) — memories regenerate
  from each user's own activity.

## 7c. Web search

Galaxy searches through one provider, with an optional fallback for when the
first one fails. The shape that works:

- **primary — a keyed search API** (Brave is supported out of the box);
- **fallback — the bundled SearXNG container**, which costs nothing.

### Why a keyed API rather than SearXNG alone

SearXNG is a metasearch front end: it queries DuckDuckGo, Brave, Startpage and
friends on your behalf by scraping them. Those engines challenge automated
querying — from datacenter IPs *and* from home connections. A blocked instance
does not error; it answers HTTP 200 with an empty result list, and every engine
reports why in `unresponsive_engines`:

```json
"unresponsive_engines": [["brave","too many requests"],["duckduckgo","CAPTCHA"]]
```

There is no free, reliable, automation-permitted web index. Indexing the web is
expensive and the organisations that do it charge for access — which is why
hosted assistants query licensed commercial indexes or their own crawlers, and
bill for the feature. The realistic choice is a small paid index or scrapers
that flap.

**How much would you actually use?** One deep-research run makes at most
`rounds × queries per round` searches: 16 at Exhaustive effort, about 9 at
Balanced, with the ceiling set in Admin → Settings → Deep research. An ordinary
chat turn makes at most `searches per turn`, default 6. Divide whatever
allowance a provider currently offers by those numbers before assuming you need
a paid tier — a personal instance often does not.

`max results` is not part of that arithmetic. Providers bill the request, not
the row: Brave returns up to 20 for the same call, and SearXNG and DuckDuckGo
have theirs parsed either way. Lowering it saves no quota and only narrows what
the model and the reader get to see. What it does spend is context, which is why
the snippet shown per result shrinks as the count rises.

Searches against a provider with a published rate limit are spaced out rather
than fired back to back — `SEARCH_PROVIDER_GAP_MS` (default 1200ms) is the gap,
and exists for Brave's per-second free tier. If a provider starts refusing
anyway, the run tightens itself to `SEARCH_THROTTLED_GAP_MS` and says so once.

Brave's current tiers and rate limits are on their pricing page
(<https://brave.com/search/api/>); they change, so check rather than trusting a
number written here.

### Setting up SearXNG (the fallback)

Two files are required and both come from the repo (see §2): the `searxng`
service in `docker-compose.yml`, and `searxng/settings.yml`, which the service
bind-mounts read-only. A missing settings file stops the container from starting.

A secret is required once. The compose file declares
`SEARXNG_SECRET: "${SEARXNG_SECRET:?…}"`, so the service refuses to start
without it — meaning **if search already works, yours is already set**. Check
before adding a second one:

```sh
cd /opt/galaxy                 # your project directory (see §2)
grep SEARXNG_SECRET .env || echo "SEARXNG_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d searxng
```

`searxng/settings.yml` enables five engines through `use_default_settings.engines.keep_only`.
That nesting matters: a *top-level* `engines:` list merges into SearXNG's
defaults rather than replacing them, so a short list there quietly leaves every
default engine running as well.

### Wiring it up

In **Admin → Settings → Web search**, set the provider (paste an API key for a
keyed one, or `http://searxng:8080` for SearXNG), pick a fallback, save, and
press **Test search**. It reports the provider, the result count, any engine
that did not answer, and — when something is wrong — the HTTP status, response
size and reason.

The fallback is used when the primary *fails*: blocked, unreachable,
unparseable, or every engine down. A provider that legitimately returns zero
results has answered, so it never silently costs a second query.

### Pacing

Searches within a research round are paced rather than fired at once, because
bursts are what trigger "too many requests" and "unusual traffic from your
network". Pacing starts from what the provider is known to tolerate and tightens
for the rest of the run if anything reports a rate limit or a CAPTCHA. Two env
vars tune it: `SEARCH_CONCURRENCY` (default 3) and `SEARCH_THROTTLED_GAP_MS`
(default 2000). Lower the first if your provider's rate limit is tight.

### When search returns nothing

Ask the instance directly — the answer distinguishes the two causes, which need
opposite fixes:

```sh
docker compose exec searxng python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8080/search?q=test&format=json',timeout=20).read()[:800])"
```

- **CAPTCHA / too many requests** — the container is connecting fine and the
  engines are refusing it. Pacing helps; a keyed primary is the real answer.
- **DNS errors / connection refused** — the container cannot reach the internet.
  Confirm with a TCP connect, not a name lookup, because Docker's embedded
  resolver can answer a lookup even when the container has no route out:

  ```sh
  docker compose exec searxng python -c \
    "import socket; socket.create_connection(('duckduckgo.com',443),5); print('egress OK')"
  ```

`docker compose logs --tail=100 searxng` names the failing engines in full.

Two things worth knowing:

- `searxng/settings.yml` sets `search.formats: [html, json]`. SearXNG serves
  only HTML by default and answers the JSON API with **403** — the usual reason
  a fresh instance appears broken.
- The **fallback** provider is used only when the primary *fails* (blocked,
  unreachable, unparseable), never when it legitimately returns zero results, so
  an empty answer never silently costs a second query.

## 7d. MCP servers

Galaxy can pull tools from external MCP servers, registered in
**Admin → Tools → MCP servers**. Which servers work (and which can't, because
they require an OAuth sign-in Galaxy doesn't support) is covered in
[MCP.md](MCP.md), along with the transports and their credential handling.

## 7b. Phones and tablets

Galaxy is responsive and installs to a home screen as a PWA once served over
HTTPS — no extra deployment steps. See [MOBILE.md](./MOBILE.md) for install
instructions per platform, offline behaviour, the Authelia cookie caveat on iOS,
and optional APK packaging.

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
| Search returns zero results for everything, but the same queries work in a browser | Ask the instance which engines failed and why (§7c, "When search returns nothing"). **CAPTCHA / too many requests** means the container connects fine and the engines are refusing it — the fix is a keyed primary, not more configuration. **DNS errors / connection refused** means it cannot get out; confirm with a TCP connect rather than a name lookup, because Docker's resolver answers lookups even with no route out |
| A search returns one Wikipedia result and nothing else | The scraped engines are benched. SearXNG suspends a blocked engine for 180s–1h, so runs get progressively thinner. Admin → Settings → **Test search** names them. Expected on SearXNG alone; it is why a keyed API is the recommended primary |
| Search results are thinner than expected | **Test search** lists any engine that did not answer. Scraped engines (DuckDuckGo, Brave, Startpage) periodically refuse datacenter IPs; `searxng/settings.yml` enables several so one being blocked thins the results rather than emptying them. A keyed provider (Brave, Tavily) as the **fallback** is not IP-blocked |
| `searxng` container won't start | `searxng/settings.yml` missing next to `docker-compose.yml` (§2) — the service bind-mounts it |
| `No such file or directory` writing `.env` | You're not in the project directory. `docker compose ls` shows where the compose file actually is (§2); `/opt/galaxy` in this guide is only an example |
| MCP server won't connect | See [MCP.md](MCP.md#troubleshooting); the common cases are a wrong header and a server that requires OAuth |
| Attachment upload fails / 403 on form posts | `ORIGIN` not set to this instance's public URL (SvelteKit CSRF check) |
| Small attachments upload but larger ones fail with `413` / `exceeds the server's request limit` | `BODY_SIZE_LIMIT` too low (or missing, so adapter-node's 512K default applies). Set it to `32M`. A reverse proxy can impose its own cap too — nginx's `client_max_body_size` defaults to 1 MB |
| Memory never runs | Admin → Memory: enabled? interval? It also skips when there's no new activity |
| Deep research returns nothing, or always searches "1 queries" | A reasoning model spending its whole token budget thinking. Both the planner and the synthesis now retry with more room automatically; if it persists, raise Max tokens in Admin → Research or pick a non-reasoning model |
| Deep research reports "no sources could be retrieved" | Search returned nothing — check the provider in Admin → Settings with the Test button. The answer that follows is general knowledge, not research |
| Deep research says "Consolidation returned no usable JSON" | The model could not produce the between-rounds brief in the shape asked for. The run falls back to searching the gaps it already had and only stops after two failures in a row, so the answer still lands — but a model that cannot follow a JSON contract will research shallowly. Pick a different one for the deep-research task |
| Deep research always runs one round whatever the effort slider says | Admin → Settings → Deep research → "rounds per run" is the ceiling; effort spends a fraction of it, so a ceiling of 1 makes every level identical. The run says so in chat when that happens |
| Deep research ignored the toggle and just did a web search | Fixed in this version. Creating a chat by pressing send used to clear the composer's per-message choices before the request was built, so the first message of a *new* chat silently lost Deep research, the effort level and the model picked in the dropdown |
| Deep research seems to ignore the conversation | It no longer does: a follow-up is first restated as a standalone question (the `framing` stage, skipped on a chat's first message). If it still looks wrong, the chat shows the resolved question as a `Researching: …` notice — that is exactly what was searched |
| Lots of sources say "search snippet only" | The Sources list now names the cause. "the site refused the request" is bot-blocking or a paywall; "the page carried no readable text" is usually a JavaScript-rendered page. Research sends a browser user-agent and retries rate limits once, but a site determined to refuse will still refuse. The per-cause counts are on the `research.rounds` event in the Observatory |
| A research answer repeats something the conversation already settled | Should no longer happen: the round that decides what is still missing now sees the original message, the resolved question and what the conversation established, not just the restated question |
| A source is cited but the quote is not on the page | Look for "search snippet only" in the Sources list. That page could not be read — a paywall, a JS-only shell, or a refused content type — so only the search engine's summary was available. The answer is told not to rest a claim on one |
| Deep research is slower or costlier than it was | Expected: it now runs up to 4 rounds by default rather than 2, consolidating what it read between them. Use the Quick effort level per message, or lower "rounds per run" |
| Coding agent stops mid-task with nothing committed | It ran out of steps. It now says so, checkpoints the work and carries on by itself (Admin → Settings → Coding agent). Raise `CODING_MAX_STEPS` if it still needs more room per leg |
| Coding session has `WIP checkpoint (auto)` commits | Work a turn left uncommitted, committed locally so it is not invisible. Nothing is pushed. Turn it off under Admin → Settings → Coding agent |
| Resuming a coding session re-reads the whole repo | Should no longer happen: each turn carries a session-state block listing files already read and changed plus current git status. Check the Observatory shows the turn ending with a `stopReason` |
| Coding agent fails with `TimeoutError` on a big repo | Fixed in this version — calls are now bounded by silence rather than total duration. If it recurs against a genuinely slow provider, raise `STREAM_IDLE_TIMEOUT_MS` |
| Coding run reports dropping earlier tool results | Working as intended: the turn exceeded `TOOL_OUTPUT_BUDGET_CHARS` and shed its oldest tool output to keep the request sane. Raise it if the model needs more history at once |

The Observatory (left pane, or `/observatory`) shows every model call, tool
use and failure — it's the first place to look when behaviour is puzzling.
