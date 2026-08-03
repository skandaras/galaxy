# Galaxy — Custom AI Workspace (Harness): Build Plan

## Context

Greenfield project in the `skandaras/galaxy` repo. Goal: a lightweight, customisable, extensible self-hosted AI harness that supports (a) coding directly into GitHub repos and (b) agentic chat with web search, deep research, and attachment/image reading. It runs on an Ubuntu server in Docker, sits behind Authelia, and exists as two instances — **dev** and **prod** — on separate subdomains. The coding agent inside the platform will maintain the platform itself: build on dev, promote to prod when stable.

This plan covers architecture, the locked stack, a mapping of every requested feature to an implementation approach, the gaps in the original spec (now folded in), a future backlog, and phased milestones. Revised after owner review: the engine is **fully model-agnostic** (no Claude-centricity anywhere), TypeScript is locked in, automatic conversation compaction is added, promotion is an admin button, and observability is promoted to a first-class feature (**the Observatory**).

---

## Key decisions (locked after review)

| Decision | Choice | Rationale |
|---|---|---|
| **Agent engine** | **Unified model-agnostic engine**: one custom agentic loop powers *every* task — coding included — built on a provider-abstraction layer (Vercel AI SDK) + the official MCP TypeScript SDK | Owner requirement: zero vendor-centricity. Any tool-calling-capable model (Claude via OpenRouter, GLM, Sol, Hy3, …) can drive any task. Trade-off accepted: we build the coding plumbing (sandboxed bash, file-edit tools, plan mode) ourselves in M3, kept tractable by a deliberately lean core toolset. Upside: one engine, one event stream, one permission model across all six tasks. |
| **Stack** | **TypeScript full-stack — locked**: SvelteKit (UI + API routes) on Node 22 | Single language everywhere; the MCP SDK and provider abstractions are TS-native; easiest for the platform's own coding agent to maintain. |
| **Database** | SQLite (WAL mode) + Drizzle ORM | Single-server, small user count. One file to back up. FTS5 gives full-text search free. Postgres is a backlog item if ever needed. |
| **Providers (day 1)** | **OpenRouter as the primary aggregator** + a generic OpenAI-compatible direct adapter | One key fills the model dropdown with every major provider's models. Each model row carries **capability flags** (tool-calling, vision, context window, cost) — the coding task requires `tools: true`, enforced by capability, never by vendor. The direct adapter covers any OpenAI-compatible endpoint (including local/self-hosted) without new code; further native adapters can be added behind the same interface. |
| **Auth** | Authelia forward-auth trusted headers (`Remote-User`, `Remote-Email`, `Remote-Groups`) | No in-app passwords. Users auto-provision on first login. Admin role = membership in an Authelia group (e.g. `galaxy-admins`). Headers accepted **only** from the reverse proxy's IP. |
| **Realtime** | SSE streaming; all agent runs are server-side **jobs** that survive browser disconnects | Critical for mobile (locked phone mid-run) and long coding sessions. Reconnecting clients resume the stream by job id. |
| **Coding sandbox** | Ephemeral runner containers (sibling containers via `docker-socket-proxy`), fresh clone per session, no host mounts, scoped tokens | The coding agent executes arbitrary commands — it must never run in the main app container. Runners execute the platform's **own engine** with the coding toolset enabled. |
| **Promotion** | **Admin-panel button** (with rollback button beside it) | Owner preference: simplicity. Retags the current `:dev` image digest as `:stable` and redeploys prod. |
| **Visual task scope** | Diagrams/charts first (Mermaid + HTML/SVG artifacts), image generation + deep image analysis on backlog | Diagrams are immediately useful and free; gen APIs slot into the provider layer later. |

---

## The engine (model-agnostic core)

One agentic loop serves all six tasks. Per iteration: compose context → call the configured model through the provider layer → execute any tool calls → append results → repeat until done or budget/limit hit.

- **Provider layer** — adapter interface (`chat`, `stream`, capability metadata, usage extraction). Day 1 adapters: OpenRouter + generic OpenAI-compatible. Model registry rows: id, provider, capability flags, cost rates, context window.
- **Toolsets** — composable groups gated per task: `core` (web_search, fetch_url, library_read/write, skill_load), `coding` (bash-in-runner, read/write/edit file, glob/grep, git ops), plus tools mounted from registered MCP servers. Per-task allowlists from `task_configs`.
- **Plan mode** — an engine-level permission state, not a vendor feature: in plan mode only read-only tools are executable; the loop produces a structured plan artifact, the UI renders it for approval/edits, and approval flips the session to implement mode.
- **Failover** — timeout / 429 / 5xx / provider error → one retry on primary, then the task's backup model, with a visible "switched to backup" notice.
- **Events** — every model call, tool call, skill load, MCP invocation, and failure emits a structured event (see the Observatory). The event bus is built into the engine from day one, not bolted on.

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
- **galaxy** (prod + dev instances) — SvelteKit app: UI, API routes, the engine (loop, provider registry, toolsets, MCP client manager), job queue, cron scheduler, memory job, event bus.
- **galaxy-runner** — ephemeral per-coding-session container: clones the target repo, runs a sandboxed engine session with the coding toolset, streams events back to the orchestrator over an internal socket, pushes to GitHub, dies.
- **docker-socket-proxy** — restricted Docker API so the app can spawn/kill runners but nothing else.

**Data volume layout (per instance):**
```
/data/
  galaxy.db            # SQLite (WAL)
  library/*.md         # the Library — flat directory of markdown, per spec
  skills/<category>/<skill-name>/SKILL.md   # skills format; dir is a git repo for versioning
  uploads/<chat-id>/   # attachments
  themes/*.json        # theme presets
```

**Core SQLite tables:** `users`, `chats` (with `hidden` flag), `messages`, `attachments`, `task_configs` (one per core task: system prompt, primary model, backup model, tool allowlist, options), `providers`, `models` (with capability flags), `skills` (index metadata; body on disk), `library_docs` (metadata + cached snippet; body on disk), `mcp_servers`, `jobs`, `events` (Observatory feed), `memory_items`, `settings` (global + per-user), `usage_log` (tokens + cost per request), `audit_log` (admin changes).

---

## Feature map (spec → implementation)

1. **Per-task agents** — seven core tasks: `coding`, `chat`, `deep-research`, `visual`, `memory`, `skill-optimiser`, `ux-audit`. Each is a `task_configs` row: editable system prompt, primary model + **one** backup model (any tool-capable model for coding — vendor-agnostic), tool allowlist, task-specific options.

2. **Chat mode** — SSE streaming; model dropdown defaulting to the task config; web search toggle (default **on**) and deep research toggle beside the input; image/PDF attachments (images resized before vision calls, PDFs text-extracted); left pane of past chats; **Hidden toggle** — a hidden chat lives in memory only: never written to the DB, excluded from the memory job, scrubbed from logs.

3. **Automatic conversation compaction** — when a chat's context reaches a configurable cutoff (default ~70 % of the active model's context window, admin-editable as % or absolute tokens), older turns are summarised into a rolling compact block; the most recent N messages stay verbatim. Compaction affects only what is *sent to the model* — the full transcript stays in the DB and the UI, with a subtle marker showing where the compaction boundary sits. A manual "compact now" action is also available.

4. **Coding mode** — repo dropdown (listed via the stored GitHub token); **Plan mode** (engine permission state: read-only tools → plan artifact → user approves or tweaks) and **Implement mode** (straight to action). Each session gets a fresh runner container, fresh clone, its own branch (avoids collisions between concurrent sessions on one repo), commits and pushes as it goes. UI shows a live tool-call trace (backed by the Observatory event stream) and a diff viewer.

5. **Web search** — pluggable provider interface (Brave / Tavily / SearXNG); admin sets provider, result count, timeouts. Runs as a tool inside the engine loop.

6. **Deep research** — a pipeline, not a single call: plan → parallel searches → fetch + read pages → iterate → synthesis with citations. Admin sets engine, max tokens, timeout, iteration cap. Progress UI streams the stages. Output can be saved to the Library in one click.

7. **The Observatory (observability panel)** — an open window into the machinery, first-class feature. A compact live panel docked in the left pane (below the chat list, also available in settings) streaming structured events: model calls (model, tokens, latency), tool uses, bash commands, skill loads, MCP invocations, web searches — each with status and duration, **failures flagged in red** and surfaced even when collapsed (badge count). Expandable to a full-screen view with filters (by chat, task, event type, status) and click-through to full detail (args, output, error). Backed by the `events` table + SSE; doubles as the debugging trace for "why did it do that?". Events for hidden chats are shown live but never persisted.

8. **Admin panel** — skills CRUD + index; provider/key management (keys encrypted at rest via a master key from env, never sent to the client); per-task model preferences + backup; model capability registry; search & research options; compaction cutoff; MCP server registry (stdio + HTTP servers, health check, live tool listing); user list (auto-provisioned from Authelia, role from group); memory-job frequency; usage dashboard (tokens/cost by user, task, model); **Promote to Prod / Rollback buttons**; audit log.

9. **System prompts** — per-task, editable in admin, **versioned with history and rollback**. These sit above repo-level `AGENTS.md`/`CLAUDE.md`-style files, which the coding agent still reads inside each repo.

10. **Library** — flat `/data/library/*.md` per spec; list view + CodeMirror markdown editor with preview; uploads converted to markdown; a cached **snippet** per doc (first lines or a one-time model summary) so the on-load digest stays cheap; FTS5 full-text search; docs readable by all agents; agent-authored docs flagged as such.

11. **Memory job** — cron (default 12 h, frequency editable in admin) with an activity **watermark**: only new non-hidden chats, library changes, and coding sessions since last run; skips entirely when idle. Outputs structured `memory_items` (preferences, patterns) and **candidate skills that land in a human-approval queue** — never auto-activated (this is the main defence against prompt-injection poisoning the skill set).

12. **Context bootstrap** — on session start each agent receives: its system prompt + the tool/skill **index** (names + one-line descriptions only — bodies load on demand, progressive disclosure) + MCP/connector inventory + Library snippet digest + relevant memory items.

13. **Skills** — `SKILL.md` template with frontmatter (`name`, `description`, `category`, `version`, `author: agent|user`, triggers), organised into a categorised Skill index with brief descriptions; the skills directory is itself a git repo, so every edit (human or agent) is versioned and revertible.

14. **Theme / UI** — futuristic-minimalist space aesthetic: pre-rendered ASCII-art galaxy as the ambient background (subtle, low-contrast; optional slow canvas shimmer), monospace-accent typography. All theming = CSS custom properties driven from theme JSON: colours, fonts, backgrounds, highlights, button styling, layout density — editable in Theme settings with live preview, per-user selection, exportable presets.

15. **Mobile** — responsive layout from day one + **PWA** (manifest + service worker) so it installs to a phone home screen immediately; APK wrapper (Capacitor/TWA) is a backlog item, not v1.

---

## Deployment & dev → prod flow

- `docker-compose.yml`: `galaxy-prod` (image `:stable`), `galaxy-dev` (image `:dev`), `docker-socket-proxy`, optional `searxng`. Separate data volumes — **nothing is shared between dev and prod**, including secrets: the dev instance (which the coding agent effectively controls) must not be able to read prod's env or volume.
- **CI (GitHub Actions):** push to `main` → build image → run tests → on green, tag `:dev` → dev subdomain auto-redeploys (webhook or watchtower).
- **Promotion:** the **admin-panel button** retags the current `:dev` digest as `:stable` and redeploys prod; the **Rollback button** retags the previous stable digest. Because the app updates itself, DB **migrations run automatically on boot and must be forward-compatible** (expand-migrate-contract pattern) so a prod rollback never meets a broken schema.
- **Backups:** nightly cron — `sqlite3 .backup` + tar of `/data` → restic/borg to a second disk or remote. Documented restore runbook.

---

## What the original spec missed (now folded into the plan)

1. **Sandboxing the coding agent** — it executes arbitrary commands on your server; ephemeral runner containers with no host mounts and scoped tokens are non-negotiable.
2. **Secrets management** — encrypted-at-rest API keys, GitHub via fine-grained PAT (GitHub App later), and the self-hosting twist: dev (agent-controlled) must be firewalled from prod secrets.
3. **Job resilience & streaming** — server-side jobs that survive browser disconnects; a locked phone must not kill a 20-minute coding run.
4. **Cost & usage tracking** — per-request token/cost logging, admin dashboard, monthly budget alert.
5. **Explicit failover semantics** — *when* exactly the backup model kicks in, and visibly.
6. **Prompt-injection surface** — web pages, repo contents, and uploads are untrusted input; hence per-task tool allowlists, human approval for memory-derived skills, and flagged agent-authored Library docs.
7. **Per-chat context management** — now a full feature: automatic conversation compaction (feature #3).
8. **Observability** — now a full feature: the Observatory (feature #7), plus an audit log for admin changes.
9. **Backup/restore** — spec had no data-durability story.
10. **Attachment pipeline details** — size limits, storage location, PDF extraction, image downscaling before vision calls.
11. **Concurrency** — job queue with per-user limits; branch-per-session so two coding runs on one repo can't collide.
12. **Health & status** — `/healthz` per instance; provider + MCP connectivity panel in admin.
13. **Authelia trust boundary** — trust forwarded headers only from the proxy IP; role mapping from groups; sane logout.
14. **Self-updating migrations** — the coding agent will alter the schema of the very app it runs in; auto-migration + forward compatibility is what makes promotion/rollback safe.

---

## Backlog (future considerations, roughly ordered)

- **PWA push notifications** (job finished, research complete) → then the APK wrapper (Capacitor/TWA).
- **E2E promotion gate** — a Playwright smoke suite the dev instance must pass before the Promote button unlocks (self-hosting safety net).
- ~~**SearXNG self-hosted search** as default provider~~ — **shipped**: runs in compose on an internal network, with primary/fallback providers and an admin "Test search" probe.
- **Local model endpoints** (Ollama / llama.cpp) via the OpenAI-compatible adapter.
- **Embeddings + RAG** over Library and past chats (semantic search) once FTS5 stops being enough.
- **GitHub App + PR watching** — review agent, CI auto-fix via webhooks, replacing the PAT.
- **Artifacts pane** — sandboxed iframe rendering of interactive HTML/SVG the agents produce.
- **Image generation providers** + a gallery surface in the Library; deep image analysis (OCR, structured extraction).
- **Generic scheduled tasks** — user-defined cron agents beyond the memory job (morning brief, repo health check).
- **Multi-agent orchestration** — agents spawning subagents; pipelines (research → draft → review).
- **Voice** — dictation input and TTS replies, mobile-first.
- **Per-user spending caps** and model-access policies.
- **Skill eval harness** — A/B test skill versions; pairs naturally with the skill-optimiser agent.
- **Chat export** (markdown/JSON) and full data portability.
- **Chat sharing / collaboration** between Authelia users.
- **Observatory retention controls** — ~~event pruning policies~~ **shipped**: admin-set retention windows for events and usage, trimmed by the scheduler (Admin → Settings → History retention). Export and anomaly summaries still outstanding.
- **Postgres migration path** if it ever outgrows SQLite.

---

## Milestones

Each milestone ends **deployed on the dev subdomain**; promote to prod when stable.

- **M0 — Foundation:** repo scaffold (SvelteKit + Drizzle + SQLite), Authelia header auth + user auto-provisioning, docker-compose (dev/prod/socket-proxy), CI building and deploying `:dev`, `/healthz`.
- **M1 — Chat core + event bus:** provider registry (OpenRouter + OpenAI-compatible adapter, capability flags), engine loop v1, streaming chat with jobs + SSE resume, history pane, Hidden toggle, model dropdown, attachments, web-search tool + toggle, auto-compaction, usage logging, **events table + emission throughout the engine**.
- **M2 — Admin panel + Observatory v1:** task configs + editable system prompts (versioned), API key management, search settings, compaction settings, usage dashboard, audit log, **Observatory panel** (live feed, failure flags, expandable detail view).
- **M3 — Coding mode:** runner containers + socket-proxy, coding toolset (bash, file edit, glob/grep, git), plan/implement permission states, repo dropdown, tool-call trace + diff UI, branch-per-session pushes.
- **M4 — Skills + Library:** SKILL.md template + categorised index, skills git-versioning, Library editor + snippets + FTS5, context bootstrap for all agents.
- **M5 — Memory & optimisation:** memory cron with watermark + editable frequency, memory items, skill candidate approval queue, skill-optimiser task.
- **M6 — Deep research + visual:** research pipeline with progress UI and citations, save-to-Library, Mermaid/HTML artifact rendering.
- **M7 — Theme + mobile polish + promotion + docs:** ASCII-galaxy aesthetic, Theme settings with live preview + presets, PWA install, responsive audit, Promote/Rollback admin buttons, promotion-gate smoke suite, and **`docs/INSTALL.md`** — a start-to-finish Ubuntu server guide (Docker + compose deployment, reverse proxy + Authelia wiring, env vars, backups, dev→prod promotion) written last so it documents the platform as it actually landed.
- **M8 — Self-review & housekeeping:** `ux-audit` task — a weekly agent that reviews aggregated usage telemetry plus the interface source (never conversation content) and files ideas into a **UX backlog** in Admin, where each is Actioned or Discarded and both decisions are replayed to future runs so nothing is proposed twice. Alongside it: the schema's first indexes, admin-set retention windows for events and usage, and a composer that grows with the text it holds.

## Verification

- **Automated:** Vitest unit/integration per milestone; Playwright e2e for the chat and coding happy paths; CI green required before `:dev` tag.
- **Manual per-milestone checklist on dev:** log in as two Authelia users → confirm separate histories/settings; start a coding run, kill the browser, reopen → job still running and stream resumes; primary model key revoked → backup model takes over visibly; run coding with a non-Claude tool-capable model (e.g. GLM via OpenRouter) → session completes; long chat crosses the compaction cutoff → boundary marker appears and the model context shrinks; force a tool failure → Observatory flags it in red with detail on click; hidden chat → absent from DB, logs, Observatory persistence, and next memory run; Promote button → prod updated; Rollback button → previous stable restored with intact data.
- **Security checks:** runner container cannot reach the Docker socket, host filesystem, or prod volume; API keys absent from client bundles and logs; forwarded auth headers rejected when not from the proxy IP.
