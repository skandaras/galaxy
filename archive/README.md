# Archive

Features that are switched off but kept in the tree so they can be read or
restored. Nothing here is built, linted, type-checked or tested: the lint
config and `.dockerignore` exclude `archive/`, and Vitest, svelte-check and
Vite only look under `src/`.

That also means none of it is kept up to date. Every file was moved as it
stood on the day it was switched off, and the shared modules it imports
(`engine.ts`, `loop.ts`, `chats.ts`, `settings.ts`, `fetch-url.ts`) carry on
changing without it. Expect to repair it before it runs again.

## ivory-tower

Theory-only research: a Shelf repository of project briefs, source notes and
mapping claims, a board made of that repository's Issues, and four agents
(`ivory-read`, `ivory-plan`, `ivory-synthesise`, `ivory-redteam`) with the
research tools (`paper_search`, `read_paper`, `shelf_read`, `shelf_write`,
`set_status`, `propose_tasks`). Switched off on 31 October 2026.

Paths under `ivory-tower/` mirror where each file lived. The removal took out
more than these files; `git show` on the commit that created this folder lists
every shared file it touched. To bring it back:

1. Move each folder back to the path it mirrors (`docs/ivory-tower/` included:
   `setup.ts` reads its seed templates through `import.meta.glob`).
2. Restore the four tasks in `CORE_TASKS` and `PROSE_TASKS` and their
   `DEFAULT_PROMPTS`, the research group in `tools/registry.ts`, the Ivory
   settings in `settings.ts` and the admin settings route, the Admin section and
   Shelf card, the rail and phone-nav entries, the chat route's Ivory branch,
   and the write-source-note seed, from that commit's diff.
3. Delete `src/routes/ivory/+page.ts`, the redirect that replaced the pages.
4. Re-enter the Shelf repository and the CORE and Semantic Scholar keys in
   Admin: the switch-off deleted them, along with every Ivory chat.
