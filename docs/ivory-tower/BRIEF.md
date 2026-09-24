# Ivory Tower: build brief

Suggested location in the repo: `docs/ivory-tower/BRIEF.md`

## What this is

Ivory Tower is a new area of Galaxy for theory-only research. It supports literature synthesis and interdisciplinary "mapping" work, where a mechanism from one field is tested for structural transfer into another. It has two parts:

- **The Shelf** is storage: research projects and their artefacts, grouped by discipline.
- **Actions** are Ivory-specific agents, tools and skills that do the research work.

Most of Ivory Tower should be configuration on top of pieces Galaxy already has or plans. Only a small amount of new code should be needed. Build it in small phases, and stop for review after each one.

## Ground rules

1. **Read before building.** Read `PLAN.md` and the current source before writing any code. This brief was written from `PLAN.md` alone, without seeing the code, so parts of it may not match what has shipped. Where they differ, the code wins. Report the mismatch; don't work around it quietly.
2. **Reuse Galaxy's existing pieces:**
   - `task_configs` for agents
   - skills (`SKILL.md`) for method
   - toolsets for capabilities
   - plan mode for approval
   - jobs and SSE for long runs
   - the event bus and Observatory for tracing
3. **Keep task status in one place.** Task status lives only on the GitHub board. Galaxy may cache board data, but it must not own it. Do not add tables that hold project or task state.
4. **Leave the Library alone.** It stays flat, as the plan requires. The Shelf is a separate GitHub repo.
5. **Don't depend on multi-agent orchestration.** It is still on the backlog. In these phases a human dispatches every agent run.
6. **Treat research content as untrusted input.** Papers, fetched pages and notes are untrusted. Agents only get the tools listed for them. Writes to the Shelf are scoped to a single project folder.
7. **No hardcoded models.** Seed task configs with placeholder models. The owner picks models in the admin panel.
8. **Keep each phase shippable.** Each phase ends deployed on dev with tests passing, followed by a short summary. Then stop and wait for approval.

## Core design decisions (already settled)

- **The Shelf is a GitHub repo.** Its location is configurable, defaulting to `https://github.com/skandaras/ivorytower`. Set it through an admin setting, not a hardcoded value. Agent writes are commits, so every change is visible and revertible.
- **The board is that repo's Issues.**
  - A project is a parent issue labelled `project:<slug>`.
  - A task is an issue labelled `project:<slug>`. If Galaxy's GitHub client supports sub-issues, the task is also a sub-issue of the project issue.
  - A `discipline:<name>` label appears on project issues.
  - An `agent:<task-name>` label says which agent should run the task (for example `agent:ivory-read`).
- **Discipline is a tag, not a folder.** Interdisciplinary projects must be able to sit under several disciplines. `projects/` is flat, and grouping comes from `disciplines:` in each brief's frontmatter.
- **Shelf repo layout:**

```
ivory-tower/
  templates/
    brief.md
    claim-mapping.md
    note.md
    examples/C-example-kin-selection.md
  projects/
    <slug>/
      brief.md
      notes/        # one file per source, written by the reader agent
      claims/       # claim files, including mapping claims
      synthesis.md  # later phases
```

## Phase 0: survey and report (no code)

Read `PLAN.md` and the source, then report back on each of the following:

- Which of these exist and work today:
  - `task_configs`
  - toolsets and allowlists
  - plan mode
  - skills and the skill index
  - the jobs queue
  - the event bus
  - GitHub token handling
  - `fetch_page`
- Where Ivory Tower code should live: routes, toolset module, and admin settings.
- Any conflicts between this brief and the codebase, with a recommendation for each.

Stop after the report.

## Phase 1: Shelf repo and read-only Shelf view

**Seed the Shelf repo.** The owner creates the empty repo first. Then:

- Add the templates from the appendices.
- Add a `README.md` explaining the layout and label conventions.
- Add a script (`scripts/ivory-labels`, or a small TypeScript script in Galaxy) that creates the label set idempotently.
- If you can't push to the Shelf repo, put the seed files under `docs/ivory-tower/seed/` in Galaxy and say so.

**Add the admin setting:** the Shelf repo (owner/name).

**Add the Shelf view** at `/ivory`, read-only:

- **Index page:** projects grouped by discipline, built from `projects/*/brief.md` frontmatter. A project appears under each of its disciplines. Each project shows its title, question and open-task count from the board.
- **Project page:**
  - the rendered brief
  - a list of notes
  - a list of claims, with each claim's `status` taken from its frontmatter
  - the project's open issues, linking to GitHub
- **Caching:** data comes from the GitHub API with short-lived caching.

**Acceptance criteria:**

- A hand-written sample project with two disciplines appears under both on the index.
- Closing an issue on GitHub is reflected in the view after the cache expires.
- No new DB tables hold project or task state.

## Phase 2: `research` toolset and the reader agent

**New toolset `research`:**

| Tool | Purpose |
|---|---|
| `paper_search` | Search scholarly metadata. Build it behind a provider interface in the same style as web search. Start with OpenAlex; Semantic Scholar, arXiv and Europe PMC come later. Return title, authors, year, DOI/URL, abstract, and whether open-access full text is available. |
| `shelf_read` | Read files within one project folder. |
| `shelf_write` | Write or overwrite files within one project folder as a commit. Commit messages name the task and the model. Reject paths outside the project folder. |

**New task config `ivory-read`:**

- Intended for a small or light model.
- Allowlist: `paper_search`, `fetch_page`, `shelf_read`, `shelf_write`.
- System prompt: read the sources the task asks for, and write one note per source using the note template (Appendix C).

**New skill `ivory-tower/write-source-note`:** the note format, plus the rule that every extracted claim needs a short verbatim quote and its location in the source.

**Run button:** on the project page, issues labelled `agent:ivory-read` get a Run button.

- It starts a job with the issue body and the project brief as context, with `shelf_write` scoped to that project.
- When the job finishes, the job runner (not the agent) posts a comment on the issue linking the notes it wrote.
- The issue stays open; the owner closes it.

**Acceptance criteria:**

- Running a sample issue produces notes that pass the note template's frontmatter validation.
- Every claim in a note has a quote.
- Notes record `access: abstract-only` when no full text was read.
- A `shelf_write` call targeting another project's folder is refused, and the refusal shows in the Observatory.

## Phase 3: planner

**New task config `ivory-plan`:**

- Intended for a large model.
- Runs in plan mode with read-only tools: `paper_search`, `fetch_page`, `shelf_read`.
- Input: a project brief.
- Output: a plan artifact listing proposed tasks. Each task has a title, body, an `agent:` label and a rationale.
- Early tasks should include checks against the brief's kill criteria. The first of these checks whether the idea is already known in the target field.

**On approval**, Galaxy's approval handler creates the issues on the board. The agent itself does not create them. The owner can edit or remove tasks before approving.

**Acceptance criteria:**

- Approving a plan creates correctly labelled issues under the project.
- Rejecting a plan creates nothing.
- The agent never holds a tool that writes to the board.

## Out of scope for now (later phases, listed for context)

- `ivory-synthesise` (mid-size model): turns notes into claims.
- `ivory-redteam`: must use a different model family from the claim's author, checked at run time. It gets the kin-selection example as a calibration reference.
- Code enforcement of the claim gates described in the mapping-claim template. For now they live as instructions.
- Auto-dispatch of labelled issues, once Galaxy's multi-agent orchestration exists.
- Additional `paper_search` providers.

---

## Appendix A: `templates/brief.md`

````markdown
---
slug: project-slug                 # folder name under projects/, kebab-case
title: ""
disciplines: []                    # e.g. [marine-biology, aeronautics]. The Shelf groups by these; a project can have several.
board: ""                          # URL of the project's parent issue
validation_tier: reading           # reading | computation | lab: the furthest this project can get without outside help
created: YYYY-MM-DD
---
<!-- No status field. Status lives on the board only. -->

# Title

## Question
<!-- One sentence. If it needs two, it's probably two projects. -->

## Why this might be new
<!-- What you suspect nobody has connected yet, and why. A hunch is fine.
     The planner's first job is to try to disprove it. -->

## Scope
In:
Out:

## Done when
<!-- The artefact that ends the project. Examples:
     - a mapping claim that reaches `survived`
     - a synthesis with a list of testable predictions
     - a `known` verdict showing the idea already exists elsewhere (still a result) -->

## Kill criteria
<!-- What stops the project early. Example: "the target field already has this under another name". -->

## Starting points
<!-- Optional. Papers, authors, datasets, search terms you already know. -->

## Notes for the planner
<!-- Optional. Budget, deadline, sources to avoid, models to use or avoid. -->
````

## Appendix B: `templates/claim-mapping.md`

````markdown
---
id: C-001                          # unique within the project
type: mapping
project: project-slug
source_domain: ""                  # where the mechanism is established
target_domain: ""                  # where we propose it applies
status: draft                      # draft | challenged | survived | known | refuted
authored_by: ""                    # task + model, or the owner's name
reviewed_by: []                    # red-team runs, each as task + model
notes: []                          # notes/ files this claim relies on
---
<!-- Gates (agents must enforce these):
     1. Leaving `draft` needs Formalism, Mapping and at least one Prediction filled in.
     2. Reaching `survived` needs a review by a model from a different family than authored_by,
        no `fatal` objections, and at least one prediction marked "Already known: no".
     3. Every factual statement cites a notes/ file. Every note carries a short quote from its source.

     Statuses:
     draft      being written
     challenged red-team objections are open
     survived   objections answered and a novel prediction stands
     known      the target field already has this (record where; this still counts as a result)
     refuted    the formalism doesn't transfer, or a key assumption fails -->

# C-001: short title

## Claim
<!-- One sentence: "[mechanism] in [source] has the same structure as [mechanism] in [target]." -->

## Formalism in the source domain
<!-- The equations, rules or algorithm as established in the source field, with citations.
     If this can't be written down, the analogy is a metaphor. Say so in Verdict and stop. -->

## Mapping
| Source term | Target term | Measurable in target? | Evidence |
|---|---|---|---|
|  |  |  |  |

## Assumptions carried over
<!-- Conditions the source formalism relies on. "Unknown" rows are where the mapping is most
     likely to break, and each one should become a task on the board. -->
| Assumption in source | Holds in target? (yes / no / unknown) | Evidence |
|---|---|---|
|  |  |  |

## Predictions
<!-- What the formalism says should happen in the target that follows from the mapping.
     If every prediction is already known, set status to `known`. -->

### P1
- Prediction:
- Already known in target? no / partly / yes (cite)
- Test: reading / computation / lab. What specifically would be done:

## Prior art in the target field
<!-- Record the searches run, including synonyms the target field might use, and what came back.
     Logging queries lets someone check a "nothing found" result. -->
| Query | Source searched | Result |
|---|---|---|
|  |  |  |

## Red-team log
### R1: task + model, date
- Objection:
- Response:
- Outcome: resolved / open / fatal

## Verdict
<!-- One paragraph: where the claim stands and what the next step is. -->
````

## Appendix C: `templates/note.md`

````markdown
---
id: N-001                          # unique within the project
project: project-slug
title: ""                          # source title
authors: []
year:
doi_or_url: ""
access: full-text                  # full-text | abstract-only
read_by: ""                        # task + model
task: ""                           # issue URL that produced this note
---

# Short title

## Summary
<!-- 3-5 sentences in your own words. -->

## Claims extracted
<!-- One entry per claim the source makes that matters to this project.
     Every claim needs a verbatim quote (keep it short) and a location. No quote, no claim. -->

### N-001.1
- Claim:
- Quote: ""
- Location: section / page / figure
- Confidence the source supports it: direct / indirect

## Relevance to the project
<!-- One or two sentences linking the source to the brief's question. -->

## Follow-ups
<!-- Optional. Cited works worth reading, open questions. -->
````

## Appendix D: `templates/examples/C-example-kin-selection.md`

Copy this file from the attached `C-example-kin-selection.md` unchanged. It is a calibration example for the red-team agent in later phases. Phases 1–3 don't use it, beyond placing it in the Shelf repo.
