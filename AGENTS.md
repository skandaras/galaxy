# Working in this repository

Galaxy is a self-hosted, model-agnostic AI workspace: SvelteKit 2 + Svelte 5 on Node 22,
Drizzle + better-sqlite3, deployed as one Docker image. `PLAN.md` holds the architecture and
the feature map; `docs/` holds install, accessibility, MCP and Cortex.

It maintains itself. The coding agent running in this app is what edits this repository, so
these are the conventions it is expected to already know.

## Before you commit

```sh
npm run lint && npm run check && npm test
```

All three, every time. `npm run build` too if you touched anything the build resolves.

The **promotion gate** — what decides whether an image reaches prod — is
`bash scripts/smoke-e2e.sh` and `npm run test:ui`. Run both if you touched the agent loop,
SSE, the API surface, or anything a page renders. They start a real server against a mock
provider; they are slow and they are not optional for those areas.

## Comments carry the reason, not the restatement

This is the most distinctive thing about the codebase and the easiest to erode. A comment
here explains *why the code is this shape*, usually by naming the failure that made it that
shape — "this used to be X, which meant Y". A comment that restates what the line does is
noise; a comment that records what went wrong is the only copy of that knowledge.

Match the density of the file you are in. Do not add a header comment to every function
because some functions have one.

## Structure

- `src/lib/server/engine/` — the agent loop (`loop.ts`), the task entry points (`engine.ts` chat, `coding/session.ts`, `research.ts`), background agents, and `tools/`.
- `src/lib/server/` — domain modules: `chats`, `boards`, `library`, `cortex`, `alignment`, `skills`, `settings`, `auth`, `api`.
- `src/routes/api/**/+server.ts` — 106 endpoints, thin. Logic belongs in the domain module.
- `src/lib/components/`, `src/routes/**/+page.svelte` — the UI.

Prefer extending an existing module to adding one. Two files worth knowing before you write
anything new: `src/lib/server/api.ts` (auth guards, `sseResponse`) and
`src/lib/server/engine/tools/registry.ts` (the tool catalogue builds itself from the tool
factories — a new tool appears in Admin without being registered twice).

## Rules that are not style

**Every route guards.** All 106 call `requireUser`, `requireAdmin`, `requireCoder` or
`requireAlignment` from `$lib/server/api`. A new route with no guard is a bug, not an
omission.

**Ownership lives in the SQL predicate**, not in the route — `visibleTo(userId)`,
`eq(table.userId, userId)`, `boardRole(...)`. A route that filters in JS after an unscoped
read is a leak waiting to happen. "Exists but not yours" answers 404, not 403.

**Migrations must be forward-compatible.** This app updates itself and can be rolled back to
the previous image, so the old code must still boot against the new schema. Additive only —
new nullable columns, new tables, new indexes. Never rename or drop in the same release as
the code that stops using it. `npm run db:generate` after a schema change; commit the
generated SQL.

**Every model call logs usage.** `logUsage` in `engine/usage.ts`, with the `ModelChoice` so
the call can be priced — `getBudgetStatus()` sums `cost_usd`, and a call that reaches a
provider without reaching `logUsage` is spend the cap cannot see.

**Hidden chats.** A hidden chat is never written to the DB, never reaches the memory job, and
its id must not survive in `usage_log` or in stored `events`. The spend still counts; the
identifier does not. Alignment and Cortex have their own boundaries, asserted in
`*-privacy.test.ts` — read those before touching either.

**Untrusted input.** Web pages, repo contents, uploads and memory items are attacker-controlled.
They are fenced and labelled as data, never as instructions, wherever they enter a prompt.

**Secrets** are encrypted at rest through `$lib/server/crypto` and never sent to the client.

**No unhandled promises.** `no-floating-promises` is on for a reason: a rejection nobody is
holding ends the process. Background work started with `void` needs a `.catch()`.

## Tests

Vitest, in node, with **no DOM** — `vite.config.ts` sets no environment on purpose. Tests sit
beside what they test (`x.ts` → `x.test.ts`). Each worker gets its own `DATA_DIR`, so suites
may write to the database freely.

Because there is no DOM, logic that needs testing is extracted out of `.svelte` into
`$lib/*.ts` and tested there — see `run-timeline.ts`, `theme.ts`, `resizable-pane.svelte.ts`.
Rendered UI is covered by `scripts/smoke-ui.mjs` alone. There is no component test harness;
do not add one without agreeing it first.

A test that asserts a *behaviour* survives refactoring. A test that asserts an object's shape
or key order does not — `scripts/smoke-e2e.sh` matches raw SSE text, which is why key order in
one emitted chunk is pinned in `loop.ts`. Do not add more of that coupling.

## Style

Tabs. Single quotes. Semicolons. There is no formatter, so match the file you are in.

Svelte 5 runes only: `$state`, `$derived`, `$effect`, `$props`. No `export let`, no `$:`, no
`svelte/store`, no `on:click`, no `<slot>` — the tree has zero of each and should keep it.

Colours, fonts, spacing and radii come from the theme tokens in `src/lib/theme.ts`. Contrast
is a tested constraint, not a preference: `theme.test.ts` asserts AA for every preset. See
`docs/ACCESSIBILITY.md`.

A leading underscore means deliberately unused, and the linter is configured to agree.

## Dependencies

Nine runtime dependencies, deliberately. Adding one needs a reason better than convenience,
and pinning where the version matters (Typst and the Figma MCP server are both pinned in the
`Dockerfile`, with the reason written next to them).

## Commits

Prose. A sentence that says what changed and why, not a conventional-commit prefix. The body
is where the reasoning goes — several commits here are the only record of an incident.
