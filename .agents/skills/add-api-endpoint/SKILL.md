---
name: add-api-endpoint
description: Adding or changing a route under src/routes/api: the guard, ownership in the query, what a stranger's id answers, and the tests that go with it.
tasks: coding
---

## When to use

Any new `src/routes/api/**/+server.ts`, or a new method on an existing one.

## Steps

1. **Put the logic in the domain module first** (`src/lib/server/chats.ts`, `boards.ts`,
   `library.ts`, `engine/memory.ts`, …). The route parses the request, calls one function and
   shapes the answer. If you are writing a query in the route, it belongs in the module.
2. **Guard the route as its first line.** `requireUser`, `requireAdmin`, `requireCoder` or
   `requireAlignment` from `$lib/server/api`. A route with no guard is a bug, whatever it reads.
3. **Scope ownership in the SQL**, in the module function: `eq(table.userId, userId)`,
   `visibleTo(userId)`, `boardRole(...)`. Never read unscoped and filter in JS.
4. **A row that exists but is not theirs answers 404**, worded like a missing one. Not 403: a
   403 tells them it exists. The usual shape is a module function returning `null` or `false`,
   and the route calling `error(404, '… not found')`.
5. **Validate the body by hand** with `request.json().catch(() => ({}))` and explicit type
   checks, answering 400 with what was wrong.
6. **Streams** go through `sseResponse` in `$lib/server/api`.
7. **A model call** made on the route's behalf goes through `logUsage` with the `ModelChoice`,
   so the budget cap can see it.
8. **Hidden chats**: if the route touches a chat, a hidden one is never written down, and its
   id never reaches `events` or `usage_log`.

## Tests

- A unit test beside the module function (`x.ts` → `x.test.ts`) covering the owner, a
  stranger (the 404 path) and bad input.
- If the route is reached from a page or is part of the agent loop, add a check to
  `scripts/smoke-e2e.sh` (API) or `scripts/smoke-ui.mjs` (rendered), and run both.
- `npm run lint && npm run check && npm test`. The repository's pre-push hook runs these too,
  and a push is refused until they pass.
