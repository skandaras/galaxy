# Ivory Tower

The owner's brief is `BRIEF.md` in this folder. This file records what was built from it and
where the code disagreed with the brief.

## Where it lives

- `src/lib/server/ivory/`: the GitHub client and its cache (`github.ts`), the Shelf
  (`shelf.ts`), the board (`board.ts`), frontmatter (`frontmatter.ts`), seeding (`setup.ts`) and
  the page view models (`view.ts`).
- `src/routes/ivory/` and `src/routes/api/ivory/`: the pages and their API, all behind
  `requireCoder` except setup, which is admin-only.
- `seed/`: the Shelf's README, templates, the kin-selection example claim and a sample project. Admin → Settings → Shelf →
  "Set up Shelf" writes whichever of these are missing. This folder is the only copy; the build
  reads it.

## Creating a project

`/ivory/new` is a form with one field per section of the brief template. It writes
`projects/<slug>/brief.md`, creates the project issue (labelled `project:<slug>` and each
`discipline:<name>`, and linked from the brief's `board:` field) and sets the first status line.
**Create and plan** also starts the planner. A folder name already on the Shelf is refused.

## Status

Each project has a one- or two-line status, kept in a marked section at the top of its project
issue on GitHub (`ivory/status.ts`); GitHub's edit history is the record of earlier lines. The
agents set it with `set_status`, which only records the line; the runner writes it to the issue
when the run ends, and only if the run finished. Galaxy writes its own line when a project is
created and when a plan is approved or rejected. A project with no project issue gets one on its
first status write. The rest of the issue body is never touched.

## The reader (`ivory-read`)

An open issue labelled `project:<slug>` and `agent:ivory-read` gets a Run button on its project
page. The run opens an ordinary chat (so it streams, survives a closed tab and takes follow-ups)
with the issue and the brief as its first message, fenced as material rather than instructions.

- **Tools:** `paper_search`, `read_paper`, `fetch_url`, `shelf_read`, `shelf_write`, `set_status`,
  and nothing else. Admin → Tools can switch any of them off.
- **Search** (`paper_search`) is OpenAlex, falling back to Semantic Scholar when it fails (or the
  other way round, in Admin → Settings → Shelf). Records with no authors are completed from
  Crossref.
- **Full texts** (`read_paper`, `ivory/fulltext.ts`) come from APIs that hand over the text before
  any publisher site is tried: Europe PMC (PubMed Central's open-access articles), arXiv, CORE
  (university repositories; needs a free key), Semantic Scholar's open-access PDF (needs a free
  key), then every open copy OpenAlex lists, repositories first. A bot-check page counts as a
  failure and the next source is tried; it is never worked around. Long papers come back in
  parts. When nothing is open, the tool lists each source and why it failed, and the note is
  written from the abstract as `access: abstract-only`. Paywalled papers with no open copy stay
  that way.
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

## The planner (`ivory-plan`)

"Plan tasks" on a project page starts `ivory-plan` with the brief, the project's open tasks and
the files already in its folder. Its tools are `paper_search`, `fetch_url`, `shelf_read`,
`propose_tasks` and `set_status`; none of them writes to the board or the Shelf. `propose_tasks` records the plan
(title, body, agent, rationale per task) against the planner's chat, and nothing else.

The plan then waits on the project page, where the owner can edit titles, bodies and agents or
remove tasks. **Approve** is the only thing that creates issues. It re-checks the edited plan,
creates the labels it needs, files each task with `project:<slug>` and its `agent:` label, and
hangs it under the project issue as a sub-issue where GitHub allows. The proposal is removed
before the first issue is made, so a second click creates nothing. **Reject** removes the
proposal and touches nothing on GitHub.

The prompt puts the kill-criteria checks first, starting with whether the idea is already known
in the target field. The model is left empty for the owner to pick; a large one is intended.

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

## What Galaxy stores

No tables were added. Project and task state stays on GitHub. Each run's scope (repository,
project, issue) is a settings row keyed to its chat, like a coding session's state, and a plan
waiting for a decision is another such row, deleted when it is approved or rejected.
