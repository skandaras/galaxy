# Galaxy — Custom AI Workspace (Harness): Build Plan

## Context

Greenfield project in the empty `skandaras/galaxy` repo. Goal: a lightweight, customisable, extensible self-hosted AI harness that supports (a) coding directly into GitHub repos and (b) agentic chat with web search, deep research, and attachment/image reading. It runs on an Ubuntu server in Docker, sits behind Authelia, and exists as two instances — **dev** and **prod** — on separate subdomains. The coding agent inside the platform will maintain the platform itself: build on dev, promote to prod when stable.

This plan covers architecture, recommended stack, a mapping of every requested feature to an implementation approach, the gaps in the original spec (now folded in), a future backlog, and phased milestones.

---

## Key decisions (recommended defaults — each is flippable before build starts)

| Decision | Recommendation | Rationale |
|---|---|---|
| **Agent engine** | **Hybrid**: Claude Agent SDK (TypeScript) powers the *coding* task; a custom provider-agnostic loop powers chat / research / memory / visual / skill tasks | Coding-agent plumbing (sandboxed shell, file edits, plan mode, MCP client, git ops) is the single largest cost in the project — the SDK provides it all. The custom loop keeps every other task genuinely multi-provider. |
| **Stack** | **TypeScript full-stack**: SvelteKit (UI + API routes) on Node 22 | You floated Rust — honest trade-off: the heavy lifting here is API orchestration and streaming, where Rust's edge is marginal, while the Agent SDK, MCP clients, and provider SDKs are all TS-native. One language also makes the platform easiest for its own coding agent to maintain. *Alternative if you want Rust anyway: Axum API + TS frontend + small Node sidecar for the Agent SDK — documented but not recommended.* |
| **Database** | SQLite (WAL mode) + Drizzle ORM | Single-server, small user count. One file to back up. FTS5 gives full-text search free. Postgres is a backlog item if ever needed. |
| **Providers (day 1)** | Anthropic direct + OpenRouter | Anthropic direct for coding (prompt caching, best coding models). OpenRouter fills the model dropdown with hundreds of models via one key. The provider layer is an interface, so direct OpenAI/Google/Ollama adapters can be added later from the admin panel design. |
| **Auth** | Authelia forward-auth trusted headers (`Remote-User`, `Remote-Email`, `Remote-Groups`) | No in-app passwords. Users auto-provision on first login. Admin role = membership in an Authelia group (e.g. `galaxy-admins`). Headers accepted **only** from the reverse proxy's IP. |
| **Realtime** | SSE streaming; all agent runs are server-side **jobs** that survive browser disconnects | Critical for mobile (locked phone mid-run) and long coding sessions. Reconnecting clients resume the stream by job id. |
| **Coding sandbox** | Ephemeral runner containers (sibling containers via `docker-socket-proxy`), fresh clone per session, no host mounts, scoped tokens | The coding agent executes arbitrary commands — it must never run in the main app container. |
| **Visual task scope** | Diagrams/charts first (Mermaid + HTML/SVG artifacts), image generation + deep image analysis on backlog | Diagrams are immediately useful and free; gen APIs slot into the provider layer later. |

---

## Architecture

```
                    ┌─ ai.example.com ──► galaxy-prod ─► /data-prod volume
Internet ─► Proxy ──┤
(Caddy/Traefik      └─ dev-ai.example.com ► galaxy-dev ─► /data-dev volume
 + Authelia)                                    │
                                                ├─► spawns ephemeral galaxy-runner
                                                │   containers (coding sessions)
                                                └─► docker-socket-proxy (create/kill
                                                    runners only — no host access)
```

**One deployable image, three roles:**
- **galaxy** (prod + dev instances) — SvelteKit app: UI, API routes, orchestrator (chat loop, provider registry, tool layer, MCP client manager, job queue, cron scheduler, memory job).
- **galaxy-runner** — ephemeral per-coding-session container: clones the target repo, runs a Claude Agent SDK session, streams events back to the orchestrator over an internal socket, pushes to GitHub, dies.
- **docker-socket-proxy** — restricted Docker API so the app can spawn/kill runners but nothing else.

**Data volume layout (per instance):**
```
/data/
  galaxy.db            # SQLite (WAL)
  library/*.md         # the Library — flat directory of markdown, per spec
  skills/<category>/<skill-name>/SKILL.md   # Agent Skills format; dir is a git repo for versioning
  uploads/<chat-id>/   # attachments
  themes/*.json        # theme presets
```

**Core SQLite tables:** `users`, `chats` (with `hidden` flag), `messages`, `attachments`, `task_configs` (one per core task: system prompt, primary model, backup model, tool allowlist, options), `providers`, `models`, `skills` (index metadata; body on disk), `library_docs` (metadata + cached snippet; body on disk), `mcp_servers`, `jobs`, `memory_items`, `settings` (global + per-user), `usage_log` (tokens + cost per request), `audit_log` (admin changes).

---

## Feature map (spec → implementation)

1. **Per-task agents** — six core tasks: `coding`, `chat`, `deep-research`, `visual`, `memory`, `skill-optimiser`. Each is a `task_configs` row: editable system prompt, primary model + **one** backup model, tool allowlist, task-specific options. Failover triggers are explicit: timeout, HTTP 429/5xx, or provider error → retry once on primary, then backup, with a visible "switched to backup" notice in the UI.

2. **Chat mode** — SSE streaming; model dropdown defaulting to the task config; web search toggle (default **on**) and deep research toggle beside the input; image/PDF attachments (images resized before vision calls, PDFs text-extracted); left pane of past chats; **Hidden toggle** — a hidden chat lives in memory only: never written to the DB, excluded from the memory job, scrubbed from logs.

3. **Coding mode** — repo dropdown (listed via the stored GitHub token); **Plan mode** = Agent SDK plan permission mode → proposed plan rendered for approval, user can edit it before approving; **Implement mode** = straight to action. Each session gets a fresh runner container, fresh clone, its own branch (avoids collisions between concurrent sessions on one repo), commits and pushes as it goes. UI shows a live, collapsible tool-call trace and a diff viewer.

4. **Web search** — pluggable provider interface (Brave / Tavily / SearXNG); admin sets provider, result count, timeouts. Runs as a tool inside the chat loop.

5. **Deep research** — a pipeline, not a single call: plan → parallel searches → fetch + read pages → iterate → synthesis with citations. Admin sets engine, max tokens, timeout, iteration cap. Progress UI streams the stages. Output can be saved to the Library in one click.

6. **Admin panel** — skills CRUD + index; provider/key management (keys encrypted at rest via a master key from env, never sent to the client); per-task model preferences + backup; search & research options; MCP server registry (stdio + HTTP servers, health check, live tool listing); user list (auto-provisioned from Authelia, role from group); memory-job frequency; **usage dashboard** (tokens/cost by user, task, model — added, wasn't in spec); audit log.

7. **System prompts** — per-task, editable in admin, **versioned with history and rollback**. These sit above repo-level `AGENTS.md`/`CLAUDE.md`, which the coding agent still reads inside the repo.

8. **Library** — flat `/data/library/*.md` per spec; list view + CodeMirror markdown editor with preview; uploads converted to markdown; a cached **snippet** per doc (first lines or a one-time model summary) so the on-load digest stays cheap; FTS5 full-text search; docs readable by all agents; agent-authored docs flagged as such.

9. **Memory job** — cron (default 12 h, frequency editable in admin) with an activity **watermark**: only new non-hidden chats, library changes, and coding sessions since last run; skips entirely when idle. Outputs structured `memory_items` (preferences, patterns) and **candidate skills that land in a human-approval queue** — never auto-activated (this is the main defence against prompt-injection poisoning the skill set).

10. **Context bootstrap** — on session start each agent receives: its system prompt + the tool/skill **index** (names + one-line descriptions only — bodies load on demand, per Agent Skills progressive-disclosure guidelines) + MCP/connector inventory + Library snippet digest + relevant memory items.

11. **Skills** — `SKILL.md` template with frontmatter (`name`, `description`, `category`, `version`, `author: agent|user`, triggers), organised into a categorised Skill index with brief descriptions; the skills directory is itself a git repo, so every edit (human or agent) is versioned and revertible.

12. **Theme / UI** — futuristic-minimalist space aesthetic: pre-rendered ASCII-art galaxy as the ambient background (subtle, low-contrast; optional slow canvas shimmer), monospace-accent typography. All theming = CSS custom properties driven from theme JSON: colours, fonts, backgrounds, highlights, button styling, layout density — editable in Theme settings with live preview, per-user selection, exportable presets.

13. **Mobile** — responsive layout from day one + **PWA** (manifest + service worker) so it installs to a phone home screen immediately; APK wrapper (Capacitor/TWA) is a backlog item, not v1.

---

## Deployment & dev → prod flow

- `docker-compose.yml`: `galaxy-prod` (image `:stable`), `galaxy-dev` (image `:dev`), `docker-socket-proxy`, optional `searxng`. Separate data volumes — **nothing is shared between dev and prod**, including secrets: the dev instance (which the coding agent effectively controls) must not be able to read prod's env or volume.
- **CI (GitHub Actions):** push to `main` → build image → run tests → on green, tag `:dev` → dev subdomain auto-redeploys (webhook or watchtower).
- **Promotion:** a manual action (admin button or workflow dispatch) retags the current `:dev` digest as `:stable` and redeploys prod. **Rollback** = retag the previous stable digest. Because the app updates itself, DB **migrations run automatically on boot and must be forward-compatible** (expand-migrate-contract pattern) so a prod rollback never meets a broken schema.
- **Backups:** nightly cron — `sqlite3 .backup` + tar of `/data` → restic/borg to a second disk or remote. Documented restore runbook.

---

## What the original spec missed (now folded into the plan)

1. **Sandboxing the coding agent** — it executes arbitrary commands on your server; ephemeral runner containers with no host mounts and scoped tokens are non-negotiable.
2. **Secrets management** — encrypted-at-rest API keys, GitHub via fine-grained PAT (GitHub App later), and the self-hosting twist: dev (agent-controlled) must be firewalled from prod secrets.
3. **Job resilience & streaming** — server-side jobs that survive browser disconnects; a locked phone must not kill a 20-minute coding run.
4. **Cost & usage tracking** — per-request token/cost logging, admin dashboard, monthly budget alert.
5. **Explicit failover semantics** — *when* exactly the backup model kicks in, and visibly.
6. **Prompt-injection surface** — web pages, repo contents, and uploads are untrusted input; hence per-task tool allowlists, human approval for memory-derived skills, and flagged agent-authored Library docs.
7. **Per-chat context management** — long conversations need compaction/summarisation; the 12 h memory job doesn't cover this.
8. **Observability** — structured logs plus per-session tool-call traces in the UI ("why did it do that?"), and an audit log for admin changes.
9. **Backup/restore** — spec had no data-durability story.
10. **Attachment pipeline details** — size limits, storage location, PDF extraction, image downscaling before vision calls.
11. **Concurrency** — job queue with per-user limits; branch-per-session so two coding runs on one repo can't collide.
12. **Health & status** — `/healthz` per instance; provider + MCP connectivity panel in admin.
13. **Authelia trust boundary** — trust forwarded headers only from the proxy IP; role mapping from groups; sane logout.
14. **Self-updating migrations** — the coding agent will alter the schema of the very app it runs in; auto-migration + forward compatibility is what makes promotion/rollback safe.

---

## Backlog (future considerations, roughly ordered)

- **PWA push notifications** (job finished, research complete) → then the APK wrapper (Capacitor/TWA).
- **E2E promotion gate** — a Playwright smoke suite the dev instance must pass before the promote button unlocks (self-hosting safety net).
- **SearXNG self-hosted search** as default provider — removes the external search-API dependency.
- **Ollama / local model provider.**
- **Embeddings + RAG** over Library and past chats (semantic search) once FTS5 stops being enough.
- **GitHub App + PR watching** — review agent, CI auto-fix via webhooks, replacing the PAT.
- **Artifacts pane** — sandboxed iframe rendering of interactive HTML/SVG the agents produce.
- **Image generation providers** (gpt-image / Imagen / Flux) + a gallery surface in the Library; deep image analysis (OCR, structured extraction).
- **Generic scheduled tasks** — user-defined cron agents beyond the memory job (morning brief, repo health check).
- **Multi-agent orchestration** — agents spawning subagents; pipelines (research → draft → review).
- **Voice** — dictation input and TTS replies, mobile-first.
- **Per-user spending caps** and model-access policies.
- **Skill eval harness** — A/B test skill versions; pairs naturally with the skill-optimiser agent.
- **Chat export** (markdown/JSON) and full data portability.
- **Chat sharing / collaboration** between Authelia users.
- **Postgres migration path** if it ever outgrows SQLite.

---

## Milestones

Each milestone ends **deployed on the dev subdomain**; promote to prod when stable.

- **M0 — Foundation:** repo scaffold (SvelteKit + Drizzle + SQLite), Authelia header auth + user auto-provisioning, docker-compose (dev/prod/socket-proxy), CI building and deploying `:dev`, `/healthz`.
- **M1 — Chat core:** provider registry (Anthropic + OpenRouter), streaming chat with jobs + SSE resume, history pane, Hidden toggle, model dropdown, attachments, web-search tool + toggle, usage logging.
- **M2 — Admin panel v1:** task configs + editable system prompts (versioned), API key management, search settings, usage dashboard, audit log.
- **M3 — Coding mode:** runner containers + socket-proxy, Agent SDK integration, repo dropdown, plan/implement modes, tool-call trace + diff UI, branch-per-session pushes.
- **M4 — Skills + Library:** SKILL.md template + categorised index, skills git-versioning, Library editor + snippets + FTS5, context bootstrap for all agents.
- **M5 — Memory & optimisation:** memory cron with watermark + editable frequency, memory items, skill candidate approval queue, skill-optimiser task.
- **M6 — Deep research + visual:** research pipeline with progress UI and citations, save-to-Library, Mermaid/HTML artifact rendering.
- **M7 — Theme + mobile polish:** ASCII-galaxy aesthetic, Theme settings with live preview + presets, PWA install, responsive audit, promotion-gate smoke suite.

## Verification

- **Automated:** Vitest unit/integration per milestone; Playwright e2e for the chat and coding happy paths; CI green required before `:dev` tag.
- **Manual per-milestone checklist on dev:** log in as two Authelia users → confirm separate histories/settings; start a coding run, kill the browser, reopen → job still running and stream resumes; primary model key revoked → backup model takes over visibly; hidden chat → absent from DB, logs, and next memory run; promote → prod updated; rollback drill → previous stable restored with intact data.
- **Security checks:** runner container cannot reach the Docker socket, host filesystem, or prod volume; API keys absent from client bundles and logs; forwarded auth headers rejected when not from the proxy IP.
