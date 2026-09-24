# Ivory Tower: the Shelf

This repository is the Shelf for Galaxy's Ivory Tower: theory-only research projects, the notes
read for them, and the claims drawn from those notes. Galaxy reads it through the GitHub API and
its agents write to it as commits, so every change is visible here and can be reverted.

## Layout

```
templates/
  brief.md              project brief
  claim-mapping.md      mapping claim: a mechanism from one field tested in another
  note.md               one note per source
projects/
  <slug>/
    brief.md
    notes/              one file per source, written by the reader agent (ivory-read)
    claims/             claim files, including mapping claims
    synthesis.md        later phases
```

`projects/` is flat. A project belongs to every discipline listed under `disciplines:` in its
brief's frontmatter, so an interdisciplinary project sits under each of them in Galaxy.

Briefs carry no status. Status lives on the board below and nowhere else.

## The board is this repository's Issues

| Label | On | Meaning |
|---|---|---|
| `project:<slug>` | the project issue and every task issue | which project the issue belongs to |
| `discipline:<name>` | the project issue | a discipline the project sits under |
| `agent:<task-name>` | task issues | which Galaxy agent should run the task, e.g. `agent:ivory-read` |

A project is a parent issue labelled `project:<slug>`; the brief's `board:` field holds its URL.
A task is an issue with the same `project:` label, and a sub-issue of the project issue where
GitHub supports it.

Galaxy never closes issues. A person dispatches every agent run from Galaxy's Shelf view, the run
comments on its issue when it finishes, and the owner closes the issue.

Galaxy creates the labels itself: Admin → Settings → Shelf → "Set up Shelf" creates the fixed
`agent:` labels and a `project:` and `discipline:` label for every brief it finds. It can be run
again at any time and changes nothing that is already there.

## The sample project

`projects/sample-pheromone-routing/` is a hand-written sample under two disciplines, there to show
the layout and to check that Galaxy groups a project under each of its disciplines. Delete it
once real projects exist.
