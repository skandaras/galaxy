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

## The reader (`ivory-read`)

An open issue labelled `project:<slug>` and `agent:ivory-read` gets a Run button on its project
page. The run opens an ordinary chat (so it streams, survives a closed tab and takes follow-ups)
with the issue and the brief as its first message, fenced as material rather than instructions.

- **Tools:** `paper_search` (OpenAlex; Admin → Settings → Shelf), `fetch_url`, `shelf_read`,
  `shelf_write`, and nothing else. Admin → Tools can switch any of them off.
- **Scope:** `shelf_read` reaches only `projects/<slug>/`; `shelf_write` only
  `projects/<slug>/notes/*.md`. Anything else throws, and shows red in the Observatory.
- **What a note must be before it is written** (`ivory/notes.ts`): the template's frontmatter,
  every claim with a quote and a location, and each quote found word for word in something the
  run actually read. `access: full-text` is refused unless `fetch_url` returned a page.
  `project`, `read_by` and `task` are filled in by Galaxy. A rejected note goes back to the model
  as a list of problems.
- **Method:** the `ivory-tower/write-source-note` skill, placed in the reader's prompt at the
  start of each turn. The run refuses to start if the skill is switched off.
- **Commits** read `ivory-read (<model>): add notes/<file> for #<issue>`.
- **When it ends**, Galaxy (not the agent) comments on the issue with links to the notes. The
  issue stays open.
- **Model:** left empty for the owner to pick in Admin → Tasks. A small model is enough.

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

No tables were added. Project and task state stays on GitHub. Each run's scope (repository,
project, issue) is a settings row keyed to its chat, like a coding session's state.
