# Ivory Tower

The owner's brief is `BRIEF.md` in this folder. This file records what was built from it and
where the code disagreed with the brief.

## Where it lives

- `src/lib/server/ivory/`: the GitHub client and its cache (`github.ts`), the Shelf
  (`shelf.ts`), the board (`board.ts`), frontmatter (`frontmatter.ts`), seeding (`setup.ts`) and
  the page view models (`view.ts`).
- `src/routes/ivory/` and `src/routes/api/ivory/`: the pages and their API, all behind
  `requireCoder` except setup, which is admin-only.
- `seed/`: the Shelf's README, templates and a sample project. Admin → Settings → Shelf →
  "Set up Shelf" writes whichever of these are missing. This folder is the only copy; the build
  reads it.

## Where the brief and the code differ

- **`fetch_page`** does not exist. The tool is `fetch_url`.
- **Task configs have no tool allowlist.** Only chat and coding assembled a toolset. Ivory agents
  get their own entry point that builds exactly the tools the brief lists, and Admin → Tools can
  still switch any of them off.
- **Plan mode is a coding feature**, and its plan is free text. The planner gets no write tools
  and a `propose_tasks` tool that records a structured proposal; Galaxy creates the issues when a
  person approves it.
- **Galaxy already has Boards**, in its own database. Ivory never uses them; its board is the
  Shelf's Issues.
- **The Shelf was not reachable from the session that built this**, so the seed files live in
  `seed/` and Galaxy writes them to the Shelf itself.
- **`templates/examples/C-example-kin-selection.md`** was not supplied with the brief. It is not
  used until the red-team phase; add it to `seed/templates/examples/` when it arrives and run
  "Set up Shelf" again.

## What Galaxy stores

No tables were added. Project and task state stays on GitHub.
