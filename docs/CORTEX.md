# Cortex — the knowledge lattice

> Status: **design, not built.** This document is the corrected architecture
> after review. Nothing in `src/` implements it yet. Where it names a file, that
> file is where the code should go, not where it is.

Memory, the Library and Boards each hold something Galaxy knows, and none of
them hold how those things relate. Memory is a flat list of facts. The Library
is prose. Boards are work in flight. An agent can retrieve any one of them and
still have no way to get from a fact to the fact next to it.

Cortex is the relational layer: concepts as nodes, weighted associations as
edges, retrieval by traversal rather than by lookup. It does not replace the
other three — it says which of their contents matter for a question, and how
they connect.

## What this is not

**Not a replacement for the model's own knowledge.** The model already knows
that "curation" and "music" co-occur in English. What it cannot know is that
*this person's* interest in one and their work in the other share a value.
That's personal, not linguistic, and it is the only thing Cortex should store.

**Not RAG.** Retrieval-augmented generation finds text that resembles the query
and injects it. Cortex traverses a mesh and returns a subgraph. The Library
already does the RAG-shaped job, with FTS5, and does it well.

**Not a typed graph.** Edges carry a weight, some context tags and a sentence
of prose saying why the two connect. A rigid ontology of edge types was
considered and rejected: the relationships worth recording here don't fall into
a small closed set, and a wrong type label is worse than a sentence.

## Boundary with `memory_items`

Both stores hold facts about a person, so the boundary has to be explicit or
they will drift into disagreement.

- **`memory_items` stays the record of discrete observations** — preferences,
  patterns, single facts. It is written by the memory job and shown to the user
  in Settings → Memory. It is the source of truth for "what is true".
- **Cortex holds concepts and their relationships.** A node is not a fact; it
  is a thing facts can be about. "Prefers dark themes" is a memory item.
  "Visual design" is a node.

A memory item may cite a node. A node never duplicates a memory item's text.
When the two disagree, the memory item wins — it is the one a human curates.

---

## Storage

Cortex tables live in Galaxy's existing SQLite database, declared in
`src/lib/server/db/schema.ts` like everything else and migrated by
`npm run db:generate`.

**Do not hand-write migration SQL.** `src/lib/server/db/migrations.test.ts`
fails CI when a `.sql` file exists that `_journal.json` does not list, and
again when applying the journal produces columns the Drizzle tables don't
declare. A hand-added migration is silently inert at runtime and loud in CI.

```ts
export const cortexNodes = sqliteTable(
	'cortex_nodes',
	{
		id: text('id').primaryKey(),
		/**
		 * Owner. Nullable for the same expand-migrate-contract reason as
		 * memory_items: the column can be added without breaking a rollback.
		 * Every read filters by owner, so a null row is simply invisible.
		 */
		ownerId: text('owner_id'),
		/**
		 * 'shared' reaches every user's traversals; 'personal' only the owner's.
		 * New nodes start personal. See "Scoping" below — this is the whole
		 * privacy model and it is not a later refinement.
		 */
		visibility: text('visibility', { enum: ['personal', 'shared'] })
			.notNull()
			.default('personal'),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		/** JSON array. Cosmetic grouping and filtering, never access control. */
		modalities: text('modalities', { mode: 'json' }).$type<string[]>(),
		/** JSON array of circuit ids. A label, not a routing key — see "Circuits". */
		circuits: text('circuits', { mode: 'json' }).$type<string[]>(),
		/** 0.0–1.0. How readily this node earns a place in a result. */
		activationPriority: real('activation_priority').notNull().default(0.5),
		isConvergence: integer('is_convergence', { mode: 'boolean' })
			.notNull()
			.default(false),
		/**
		 * Precomputed map coordinates. Written by the layout sweep, never at
		 * request time — see "The Cortex map".
		 */
		x: real('x'),
		y: real('y'),
		z: real('z'),
		lastVerifiedAt: integer('last_verified_at', { mode: 'timestamp_ms' }),
		lastActivatedAt: integer('last_activated_at', { mode: 'timestamp_ms' }),
		activationCount: integer('activation_count').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Every read is "what may this user see", exactly as the library does it.
	(t) => [index('cortex_nodes_owner_idx').on(t.ownerId, t.visibility)]
);

export const cortexAssociations = sqliteTable(
	'cortex_associations',
	{
		sourceId: text('source_id')
			.notNull()
			.references(() => cortexNodes.id),
		targetId: text('target_id')
			.notNull()
			.references(() => cortexNodes.id),
		/** 0.0–1.0. How strongly the two co-activate. */
		weight: real('weight').notNull(),
		/** JSON array. Which conversational domains make this edge relevant. */
		contextTags: text('context_tags', { mode: 'json' }).$type<string[]>(),
		/** Why they connect, in a sentence. More useful than a type label. */
		description: text('description').notNull().default(''),
		directionality: text('directionality', { enum: ['symmetric', 'asymmetric'] })
			.notNull()
			.default('symmetric'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		lastTraversedAt: integer('last_traversed_at', { mode: 'timestamp_ms' }),
		traversalCount: integer('traversal_count').notNull().default(0)
	},
	(t) => [
		primaryKey({ columns: [t.sourceId, t.targetId] }),
		// The primary key serves outbound traversal only. Symmetric spreading
		// activation walks inbound too, and without this it table-scans.
		index('cortex_assoc_target_idx').on(t.targetId)
	]
);

export const cortexCircuits = sqliteTable('cortex_circuits', {
	id: text('id').primaryKey(),
	ownerId: text('owner_id'),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});
```

`cortex_activation_log` and `cortex_index_cache` from the original design are
**deferred**. The log has no consumer until learning exists (see "Learning"),
and the index cache has no purpose once seeding goes through FTS5 rather than a
maintained keyword map.

### Full-text index

Seed selection uses FTS5, following the Library exactly. `library_fts` is
already created in `runMigrations()` (`src/lib/server/db/index.ts:42`) because
virtual tables sit outside Drizzle's schema management; `cortex_fts` joins it
there:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS cortex_fts USING fts5(id UNINDEXED, name, description)
```

Reuse `ftsQuery()` from `src/lib/server/library.ts` — it quotes terms so user
input cannot break FTS5 syntax, which is a real hazard and already solved.

---

## Scoping — the part that is not optional

Galaxy is multi-user. Every store that can reach an agent's context is scoped
by owner in the schema, and the codebase is unusually direct about why:

- `library.ts` — "The library is the one store that feeds *another* user's
  prompt, so an unscoped query here is a privacy bug, not a cosmetic one."
- `memory.ts` — "Never call this without an owner for user-facing output."
- `boards.ts` — "there is no admin override here: running the platform is not
  the same as being on someone's board."

Cortex is a fourth such store and gets the same treatment from the first
migration, not as a later "multi-user gating" feature. Scoping the lattice
after Hebbian learning has been strengthening edges across an ownership
boundary is not a migration anyone wants to write: there is no good answer to
what a mixed-ownership edge means, or which half of it survives.

**The visibility rule.** A node is visible to a user when it is `shared`, owned
by them, or has no owner (the legacy case, as in the Library).

**The edge rule.** An association is visible only when *both* endpoints are
visible to the reader, and **activation never traverses into a node the reader
cannot see** — not even transiently, and not even to reach a node they can.
A shared node must not become a bridge between two people's private ones.

**The test.** `src/lib/server/cortex-privacy.test.ts`, modelled on
`src/lib/server/alignment-privacy.test.ts`, which exists for precisely this
class of mistake: "That promise currently holds because of what the other
modules *don't* do, which is exactly the kind of guarantee that evaporates the
day somebody adds a table to a digest without realising what is in it." Seed
two users with distinctive marker strings, then assert no marker of one appears
in the other's traversal, bootstrap line, map payload or tool result.

### Encryption and backups — what is actually true

Galaxy encrypts **secrets**: provider API keys, the GitHub PAT and MCP headers,
with a master key from `SECRET_KEY` (`docs/INSTALL.md`). That is
application-level field encryption.

The **database itself is not encrypted**. `src/lib/server/db/index.ts` opens a
plain `better-sqlite3` file. Cortex therefore has exactly the protection every
other Galaxy table has: filesystem permissions on the data volume, and the
reverse proxy plus Authelia in front of the app. Adding SQLCipher would mean a
different `better-sqlite3` build, a re-key path and changes to the backup
script; it is a real project, not a property Cortex can inherit.

Backups are the host `cron.daily` script in `docs/INSTALL.md`, installed by the
admin, retaining **14 days**. Cortex tables are inside `galaxy.db`, so they are
covered the moment the tables exist, with nothing further to configure.

If some nodes are genuinely too sensitive for that, the honest control is a
`sensitive` modality that excludes them from exports and from any digest —
cheap, legible, and it does not pretend to be cryptography.

---

## Retrieval

### Seeding: FTS, not a keyword map

The original design routed queries through a hand-maintained keyword→circuit
map. That map is the weakest link in the system: nothing makes it grow with the
lattice, somebody has to write every entry, and when its coverage falls behind
the failure is silent — queries stop reaching the right region and no signal
says so.

FTS5 is already in the project, already handles the quoting hazard, and matches
on the node's own name and description rather than on a mapping someone
remembered to add. Seeds come from `cortex_fts`, scored by FTS rank and
`activationPriority`, filtered to what the reader may see.

This also removes a scheduling problem in the original: its stated fallback for
a keyword miss was semantic similarity, but embeddings were not due until Phase
4, and Galaxy has no embedding infrastructure at all today — nothing in
`src/lib/server/providers/`, and `PLAN.md`'s backlog still lists "Embeddings +
RAG … once FTS5 stops being enough" as future work. The MVP had a fallback it
could not implement. FTS has no such gap, and when embeddings do arrive they
drop into this same step.

### Spreading activation

Seeds start at 1.0. Each iteration propagates
`source_activation × edge_weight × decay^hops` to visible neighbours,
convergence nodes take a boost, context tags modulate strength, and nodes below
a floor are pruned. Two to three iterations. Return the top nodes with their
strongest visible associations.

Every constant here — the decay base, the convergence boost, the floor, the
iteration count — is **a guess until the eval exists**. See "Knowing whether it
works". Do not tune them by feel; there will be nothing to tune against.

### Circuits are labels, not routing

The original design used circuits as the routing key *and* planned to discover
them from association density later. Those two roles conflict: a routing key
has to be stable, and a derived cluster is not.

Circuits are curated labels, used for grouping, filtering and the map's cluster
titles. Routing goes through FTS. If cluster detection is added later it
proposes labels, and nothing about retrieval depends on the answer.

---

## Tools

**Two tools, not seven.** A chat turn already offers around nineteen builtin
tools, every definition of which sits in the system prompt on every turn, and
models choose worse as the list grows. Most of the original seven were the same
operation behind different names: query, activate and traverse all mean
"activate and return a subgraph", and read is traverse at depth zero.

| Tool | Purpose |
|---|---|
| `cortex_query` | Text in, activated subgraph out. Optional `from_node` and `depth` cover deep-dive and neighbourhood walks. |
| `cortex_write` | Upsert a node *and* its edges in one call, so recording a concept and its connections isn't two round trips. |

Both go in `src/lib/server/engine/tools/cortex.ts` and **must be added to
`builtinDescriptors()`** in `src/lib/server/engine/tools/registry.ts`. That is
what puts a tool in Admin → Tools where it can be disabled, re-described or
scoped to a task; a tool that skips it is invisible and cannot be turned off.

Both should also `report(...)` structured detail — seeds chosen, nodes
activated, subgraph size — to the Observatory event. `PLAN.md` calls the event
bus "built into the engine from day one, not bolted on", and without it there
is no way to see why a query surfaced something strange.

### Context cost: one line in the bootstrap

`bootstrapContext()` gets **one line** saying a lattice exists, roughly how
big it is, and to query it with `cortex_query` — the same treatment boards and
the Library get. Everything else loads on demand.

The original design injected 5–15KB of activated subgraph at conversation
start. Galaxy has already made and fixed that mistake twice, and both fixes
left comments:

- `src/lib/server/engine/context.ts` — the coding agent's session state was
  concatenated into the system message, so "three legs of one turn therefore
  missed the cache three times over". The `tail` parameter exists so volatile
  context cannot invalidate the cacheable prefix.
- `src/lib/server/library.ts` — a per-doc snippet was removed from the digest
  because it was "around 5,000 characters of body text per turn at thirty docs,
  almost none of it relevant to the question being asked, and it grew with the
  shelf."

Anything Cortex adds per turn must go in `tail`, never the system prompt, and
it should be small enough that the question of where to put it barely matters.

### Writes need a gate and a merge

An agent free to mint nodes will produce near-duplicates — "Music discovery",
"music curation", "discovering music" — with confident-looking weights, and any
later learning will reinforce that noise. Galaxy's existing pattern for durable
agent-authored knowledge is the opposite of free: skill candidates go to a
human (`decideCandidate()` — "Never auto-activated"), and board writes sit
behind an `agentWrites` setting.

So: a `cortex.agentWrites` setting mirroring `boards`; `cortex_write` resolves
against existing node names before creating anything; and a merge operation
exists from the start. Optionally route new nodes through a candidate queue —
there is UI precedent at `/api/admin/memory/candidates`.

---

## Knowing whether it works

The hardest problem with this design is not building it; it is that every claim
it makes about itself is unfalsifiable as stated. "Richer context" and
"understands how things connect" cannot be measured, and the retrieval
constants above cannot be tuned without something to tune against.

**Before any learning engine: write the eval.** Around twenty real questions,
each with the nodes a human says should surface, as a Vitest fixture scored on
precision and recall. It is cheap, it makes every constant in the traversal a
decision rather than a leftover, and `PLAN.md`'s backlog already wants
something of this shape for skills.

The Cortex map (below) is the other half: the eval measures retrieval quality,
the map shows lattice health. Neither substitutes for the other.

---

## The Cortex map

A read-only star chart at `/cortex`, nav-level beside Chat, Boards, Library and
Alignment. Pan, zoom, click a node for a summary panel, cluster labels at low
zoom, filter by topic.

It is on-brand to the point of inevitability — `PLAN.md` M7 commits to an
"ASCII-galaxy aesthetic" and `GalaxyBackdrop.svelte` already turns a spiral
galaxy behind every page — but it earns its place on diagnostics, not looks.
Structural pathologies that no retrieval metric reports are obvious at a glance:

- **Near-duplicates** — two dots on top of each other.
- **A mesh drifting toward fully connected** — the chart going uniformly
  bright over weeks. The failure becomes something you watch rather than infer.
- **Orphans** — nodes nothing connects to, dead weight in every query.
- **Circuits that aren't separable** — if they don't visually separate, the
  labels are fiction.
- **Convergence nodes that bridge nothing** — the design's highest-value
  claimed element, immediately checkable.

### Precompute the layout. This is the whole performance story.

Force-directed layout is the expensive part of any graph visualisation —
O(n log n) per iteration with Barnes-Hut, a few hundred iterations to settle.
Run it per request and it is the difference between free and the fan coming on,
whether it runs on the droplet or the phone.

So `x`, `y`, `z` live on the node row, refreshed by a sweep in
`src/lib/server/engine/scheduler.ts` (five-minute tick, already home to the
memory and UX-audit sweeps) and only when the graph has actually changed. The
endpoint is then a plain scoped `SELECT` with no computation in it.

That is a correctness win as much as a performance one: **a stable layout means
the map has the same shape every time you open it.** A chart that re-randomises
per visit can never become spatial memory, which is most of the point.

### What it costs

**Server: effectively nothing.** A read-only select over two tables. At early
scale the payload is a few KB; even at several thousand nodes, a projection of
just what the chart draws is well under 200KB gzipped, and SQLite serves it in
milliseconds. No new container, port or service.

**Client: this is the real constraint**, because Galaxy is a PWA people install
on phones (`docs/MOBILE.md`), so the target is a mid-range handset rather than
a desktop. A 3D library would be by far the heaviest dependency in the project —
three.js is on the order of 150KB gzipped for the core alone, and a force-graph
wrapper on top puts a realistic all-in figure several times higher than
anything currently shipped.

### Two tiers

**Tier 1 — 2D canvas, no new dependency.** Precomputed coordinates, one
`<canvas>`, pan and zoom by transform, click-to-select by distance against the
visible set. Comfortably smooth at a few thousand nodes on a phone, zero bundle
cost, and all five diagnostics above work in 2D.

Follow `GalaxyBackdrop.svelte` exactly on the mechanics: `requestAnimationFrame`
rather than `setInterval` "so the browser suspends this on a hidden tab", a
capped frame rate, and an explicit `prefers-reduced-motion` bail-out.

**Tier 2 — 3D, later, only if tier 1 proves it earns the weight.** Dynamically
imported so it never enters the initial bundle — `MermaidBlock.svelte` shows
the pattern with `(await import('mermaid')).default` — offered as a toggle
rather than the default, and off by default on phones and under reduced motion.

### Two requirements that are not optional

- **Accessibility.** A canvas is opaque to a screen reader, and this repo holds
  itself to `docs/ACCESSIBILITY.md`. The route needs a parallel non-visual
  representation: a plain searchable list of nodes and their connections, same
  data, same page.
- **Scoping.** The map is a view over the lattice and inherits the rules above
  in full. A visualisation is the easiest place in the world to accidentally
  render the whole table, so its endpoint belongs in the privacy test's case
  list, not just in review.

---

## Phases

**P1 — Foundation.** Drizzle tables with owner and visibility, generated
migration, `cortex_fts`, the store in `src/lib/server/cortex.ts`, two tools
registered in the catalogue and emitting events, one bootstrap line,
`cortex-privacy.test.ts`, YAML export.

**P2 — Retrieval and sight.** The eval fixture first, then spreading activation
tuned against it: contextual gating, convergence boost, re-entrant iterations.
Then the tier-1 map, plus the layout sweep. Doing the map here is deliberate —
it is most useful while the lattice is still small enough to shape by hand, and
it makes P3 observable before P3 starts.

**P3 — Learning.** Only once P2's eval can say whether a change helped.
Strengthening paired with decay or per-node normalisation — the original
"+0.01 per co-activation with no decay and no cap" drifts monotonically toward
a fully connected mesh, where activation spreads everywhere, which is the same
as spreading nowhere. Reinforce on whether a turn actually *used* the retrieved
context (`events`, `usageLog`, `messages.trace` all record enough), not on
co-retrieval, which just teaches the lattice to confirm itself. Connection
suggestions, cluster proposals and staleness flagging go through a review queue.

**P4 — Growth.** Embeddings for seeding, replacing FTS in the same step. YAML
round-trip. Tier-2 3D map. Expanded node set.

---

## Open questions

1. **Edges across an ownership boundary.** The rule above (visible only when
   both endpoints are) is the safe default, but it means a shared node cannot
   carry a connection between two people's private ones. Is that right, or
   should shared nodes be able to hold edges that each owner sees only their
   own half of?
2. **Deduplication.** Name resolution on write catches the obvious cases. What
   catches "Music discovery" versus "Discovering new music" — a similarity
   check, a periodic review queue, or accepting the drift and merging by hand?
3. **The memory boundary.** The split above is clean in principle. In practice,
   should the memory job be able to *propose* nodes from what it observes, or
   does that couple two stores that are better kept independent?
