# Cortex — the knowledge lattice

> Status: **Phases 1 and 2 shipped.** Store, FTS seeding, spreading activation,
> two agent tools, the retrieval eval, a human write path, the layout sweep and
> the map at `/cortex`. Phases 3–4 are still design. Agent writes ship **off** —
> see "Writes need a gate".

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

## How big is a node?

The first question anyone seeding a lattice hits: is "Australian culture" a
node, or are "multicultural festivals" and "digger mentality" the nodes?

Usually neither reading is quite right. The specifics are nodes, and the
category is a **circuit** — which already exists for exactly this, and is
deliberately not a routing key, so using it as a label costs nothing at
retrieval time.

This has a mechanical answer rather than a matter of taste, because the
traversal does something specific with a node.

### An over-large node is a firehose

`activate` delivers `source × weight × DECAY` along *every* edge, with **no
normalisation by degree**, and `MAX_RESULTS` is 12. So a node with forty edges
pushes full-strength activation to all forty, and a single query landing on it
returns twelve arbitrary things ranked by edge weight. A category node does not
add context — it displaces whatever the question was actually about.

### A node has to be worth reading back

A result carries the node's name, its description and its strongest
associations. "Australian culture" coming back tells the agent nothing it did
not already know. "Digger mentality" with two specific sentences is something
it can use in a reply. If the description could be written by someone who has
never met you, the node is too general to earn its place.

### Three tests

1. **Containment or connection.** An association carries a `description` — why
   these two connect. If the only sentence you can write is "X is an example of
   Y", that is containment, and containment is a circuit. If it is "X and Y
   share Z" or "X shaped how I do Y", both ends are nodes.
2. **Distinctness.** Two concepts earn separate nodes when they would connect
   to *different* things. Two names with the same neighbourhood are one node
   that has not been merged yet.
3. **Degree budget.** Three to seven connections is healthy. Below two, nothing
   reaches it. Above ten, see the firehose above.

### Err specific, because the tooling is asymmetric

`mergeNodes` is a single call and keeps the stronger weight on every edge it
moves. There is no split: separating one node into two means creating them and
redistributing edges by hand. Fine-to-coarse is the reversible direction, so
start finer than feels comfortable and merge when two nodes turn out to be one.

### Abstract is fine. General is not.

The most valuable nodes in the design are abstract — convergence nodes are
through-lines, not things. The distinction is not concreteness:

- A **bridge** names one particular thing and connects a handful of items
  across domains for a stated reason.
- A **category** contains everything beneath it, indiscriminately.

So the shape that works is specifics at the bottom, a few named through-lines
above them, and categories as circuit labels rather than nodes. A node like
"suspicion of self-seriousness" — reaching from a sense of humour to how you
run an event to how you talk about your own work — is worth many times a node
called "Australian culture", because it reaches *out* of its cluster.

### The island check

If no node in a cluster connects to anything outside that cluster, the cluster
is an island, and an island contributes nothing traversal can offer that plain
search would not already find. **A node's value is in its edges out of its own
neighbourhood.** That is the entire bet the lattice makes, and it is the first
thing to look for on the map.

### A caveat

All of the above is reasoned from the retrieval mechanics, not measured against
a real lattice — the eval fixture is fiction. Once there are thirty or forty
real nodes the map will settle it directly: a firehose looks like a hub with
everything hanging off it, and an island looks like an island.

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

`cortex_change_log` ships alongside them — see "Grooming" below. Writes exist
from the first phase, so the first one should already be auditable.

Three tables from the original design do **not** ship yet.
`cortex_activation_log` has no consumer until learning exists, and
`cortex_index_cache` has no purpose at all once seeding goes through FTS5
rather than a maintained keyword map. `cortex_proposals` and `cortex_kinship`
arrive with the grooming agent: adding a table later is a cheap additive
migration, and shipping dead ones now is worse than not shipping them.

### Full-text index

Seed selection uses FTS5, following the Library exactly. `library_fts` is
already created in `runMigrations()` (`src/lib/server/db/index.ts:42`) because
virtual tables sit outside Drizzle's schema management; `cortex_fts` joins it
there:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS cortex_fts USING fts5(id UNINDEXED, name, description)
```

`ftsQuery()` is exported from `src/lib/server/library.ts` and reused rather than
re-derived — it quotes terms so user input cannot break FTS5 syntax, a real
hazard worth solving once rather than in every module that opens an index.

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
remembered to add. Seeds come from `cortex_fts`, ranked by bm25 and nudged by
`activationPriority`, filtered to what the reader may see.

**Seeds start at the strength they earned.** Every seed used to begin at full
activation whether it matched five query terms or one, so a question could be
answered by whichever cluster happened to share an incidental word: "people
learning the press across a year" seeded one teaching concept and three
letterpress ones (on "press" and "across"), gave all four the same push, and the
letterpress side crowded out the answer. `seedNodesScored` returns the relevance
it computes rather than discarding it, normalised against the best match of that
query — what decides whose neighbourhood gets explored is how far ahead the
front-runner is. Overall recall went 0.98 → 1.00 and precision 0.80 → 0.82.

**Match any term, not all of them.** The first version ANDed the query's terms,
which is what FTS5 does with a bare space, and the eval found the consequence on
its first run: a question is almost never a term-for-term subset of the text it
should match — "cliff edge retreating" misses a node that says "retreats" — so a
quarter of the eval's questions produced no seed at all. With no seed there is
nothing to spread from, so the traversal returned nothing and gave no hint why,
which is the same silent failure the keyword map was rejected for. Library
search keeps AND, because it is handed deliberate keywords; Cortex is handed a
sentence someone said.

This also removes a scheduling problem in the original: its stated fallback for
a keyword miss was semantic similarity, but embeddings were not due until Phase
4, and Galaxy has no embedding infrastructure at all today — nothing in
`src/lib/server/providers/`, and `PLAN.md`'s backlog still lists "Embeddings +
RAG … once FTS5 stops being enough" as future work. The MVP had a fallback it
could not implement. FTS has no such gap, and when embeddings do arrive they
drop into this same step.

### Spreading activation

Seeds start at 1.0. Each iteration propagates
`source_activation × edge_weight × decay` to visible neighbours, context tags
modulate strength, and nodes below a floor are pruned. Two iterations by
default. Activation accumulates where two paths meet, which is how a concept
the question never mentioned ends up in the answer.

**Contextual gating is on; the convergence boost is off.** Both were built and
both were measured against the eval rather than adopted because the design
named them.

Gating takes the active context from the *seed* nodes' modalities — nothing new
has to be passed in, and it says something true: these are the domains the
question turned out to be about. An edge whose `contextTags` intersect that set
propagates at full strength, one whose tags miss entirely is attenuated to 0.6,
and an untagged edge is neutral. It measured as a small gain in recall at no
cost in precision, so it ships on.

The convergence boost measured as no gain at a small cost: bridge recall is
identical with and without it, and turning it on loses about two points of
precision by reordering answers that were already right. It ships off, opt-in.
The honest caveat is that the fixture cannot show the case it was designed for
— bridges already surface there, so there is no headroom — and a denser lattice
might say otherwise. Flipping the default means showing it reaches something,
not citing this document.

The remaining constants — decay, floor, iteration count — are still the first
plausible values. The eval is a regression guard on them, not a tuner: fitting
numbers to a fiction would be fitting them to assumptions. Real tuning waits for
a real lattice.

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

## Does it actually help?

The oldest weakness in this design is that everything it claims about itself is
unfalsifiable — "richer context", "understands how things connect". The eval
fixture answers half: whether retrieval returns the right concepts. The
comparison pane answers the half that matters.

`/cortex` → **Effect**: one prompt, two answers from the same model, one with
the activated subgraph injected and one with nothing.

**What varies is the context, not the agent.** The lattice side is *given* the
subgraph rather than left to call `cortex_query` itself. That isolates one
variable — mixing them would leave a poor answer ambiguous between "the lattice
had nothing useful" and "the agent never looked", and the second question is
what the context digest exists to answer.

**It shows the cost.** Prompt size for both runs, and the concepts that
activated with their scores. A comparison that only showed upside would be a
rigged one: the lattice run is longer by construction, and the question is
whether it buys enough to be worth that. Size is reported in characters as well
as tokens, because characters are measured here and always available while
tokens depend on the provider reporting them — running this against the mock
provider, which returns a fixed usage number, is what made that gap obvious.

Ephemeral rather than stored: the useful artifact is the judgement you form
looking at the two, and a saved transcript is only meaningful against the
lattice as it was on the day.

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

### Two passes, and `z` is computed now

Position is never captured when a node or a relation is created. It cannot be:
a coordinate fixed at creation would be wrong the moment anything else
connected to either end. Position is a rendering of the whole graph, derived
after the fact — so nothing about depth is *lost* by computing it late.

What is lost by computing it late is stability. A native 2D layout and a native
3D layout place nodes differently, so adding depth later would move every node,
discarding the spatial memory that was the reason to precompute coordinates at
all — at exactly the point the lattice is finally big enough for that memory to
be worth something.

So `src/lib/server/cortex-layout.ts` runs a true 2D Fruchterman-Reingold for
`x`/`y`, then a constrained pass that relaxes **only** `z` with `x`/`y` frozen:
repulsion measured in three dimensions, only its depth component applied. A pair
the flat layout could not give room to pushes apart into depth; a pair with room
barely moves.

Turning on a 3D view will therefore *lift* the nodes out of the plane rather
than reshuffle them, and `z` means something specific — how much a node's
placement was compromised by flattening, which is where the flat map is lying to
you. That the depth pass leaves `x`/`y` bit-identical is the property the whole
argument rests on, so it is asserted in `cortex-layout.test.ts` rather than
assumed; the `depth: false` option exists for that test.

The trade: a 3D layout anchored to a 2D one, not a native 3D layout, which might
pack marginally better. Not worth a reshuffle.

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

**Tier 1 — 2D canvas, no new dependency. Shipped.** Precomputed coordinates,
one `<canvas>` in `src/lib/components/LatticeMap.svelte`, pan and zoom by
transform, click-to-select by distance against the visible set. Zero bundle
cost, and all five diagnostics above work in 2D.

Nothing animates. Positions come from the sweep, so there is no simulation to
run in the browser and no idle loop — the canvas redraws on pan, zoom, select
and resize, and otherwise sits still. That makes `prefers-reduced-motion` a
non-question rather than a special case.

Depth is hinted rather than drawn: a node the flat layout had to squeeze sits
slightly back. Same information the 3D tier will show properly, without
pretending this one is 3D.

Follow `GalaxyBackdrop.svelte` exactly on the mechanics: `requestAnimationFrame`
rather than `setInterval` "so the browser suspends this on a hidden tab", a
capped frame rate, and an explicit `prefers-reduced-motion` bail-out.

**Tier 2 — 3D, later, only if tier 1 proves it earns the weight.** Dynamically
imported so it never enters the initial bundle — `MermaidBlock.svelte` shows
the pattern with `(await import('mermaid')).default` — offered as a toggle
rather than the default, and off by default on phones and under reduced motion.

### Two requirements that are not optional

- **Accessibility.** A canvas is opaque to a screen reader, and this repo holds
  itself to `docs/ACCESSIBILITY.md`. The canvas is `aria-hidden`, and the
  searchable list beside it is the real interface for anyone not looking at
  pixels — and the same list a sighted person clicks. Not a hidden parallel
  view, which is a thing that rots; this one cannot, because everyone uses it.
- **Scoping.** The map is a view over the lattice and inherits the rules above
  in full. A visualisation is the easiest place in the world to accidentally
  render the whole table, so its endpoint belongs in the privacy test's case
  list, not just in review.

---

## Phases

**P1 — Foundation. Shipped.** Drizzle tables with owner and visibility
(`cortex_nodes`, `cortex_associations`, `cortex_circuits`, `cortex_change_log`),
generated migration, `cortex_fts`, the store in `src/lib/server/cortex.ts`, two
tools registered in the catalogue and reporting counts to the Observatory, one
bootstrap line, `cortex.test.ts` and `cortex-privacy.test.ts`, JSON export.
Agent writes ship off.

**P2 — Retrieval and sight. Shipped.** The eval (`cortex-eval.test.ts`) with a
fictional fixture lattice; the seeding fix it immediately found; contextual
gating on and the convergence boost off, each decided by measurement; a human
write path (API routes plus the panel on `/cortex`); the two-pass layout in the
scheduler; and the tier-1 map. Doing the map here was deliberate — it is most
useful while the lattice is still small enough to shape by hand, and it makes
P3 observable before P3 starts.

**P3 — Grooming and being consulted. Shipped.** The circuit-indexed context
digest (see "Retrieval"), areas made real with an editor and cluster labels on
the map, the grooming agent with its apply/propose line, the review queue, undo,
and change-log retention.

**P3.5 — Learning.** Only once P2's eval can say whether a change helped.
Strengthening paired with decay or per-node normalisation — the original
"+0.01 per co-activation with no decay and no cap" drifts monotonically toward
a fully connected mesh, where activation spreads everywhere, which is the same
as spreading nowhere. Reinforce on whether a turn actually *used* the retrieved
context (`events`, `usageLog`, `messages.trace` all record enough), not on
co-retrieval, which just teaches the lattice to confirm itself. Connection
suggestions, cluster proposals and staleness flagging go through a review queue.

**P4 — Usable and fillable. Shipped.** Every setting reachable (Admin → Cortex
for the schedule and the lattice caps, Settings → Cortex for a person's own
opt-out, and the change-history window beside the other retention controls), and
the file round trip: export what you have, draft a lattice in a file, import it.

**The groomer's cadence** lives in Admin → Cortex: weekly by default
(`intervalHours: 168`), per user, off until switched on, ten suggestions a run.
`tidy` runs on every pass whether or not a model is configured for the
`cortex-groom` task, because that half needs none.

**Still deferred, with reasons rather than silence.** *Embeddings* — FTS scores
0.98 recall on the fixture, and replacing it needs new provider surface plus an
answer for when no embedding model is configured, to chase a gain nothing has
demonstrated. *Tier-2 3D* — the z coordinates are computed and stable so this is
mostly a lazily-imported renderer, but the stated bar was that tier 1 earn it,
and tier 1 has had no real lattice to prove anything on. *Kinship* — still needs
a second populated lattice; design intact above.

---

## Kinship — overlap across an ownership boundary

The default holds: an association is visible only when both endpoints are, and
activation never traverses into a node the reader cannot see. `cortex.test.ts`
and `cortex-privacy.test.ts` enforce it, including the case that actually
matters — a hidden node used as a *conduit* between two visible ones, where
filtering the result set is not enough and only the edge bound saves you.

On top of that, the grooming agent may record **kinship**: a note on two nodes
with different owners that the same concept lives in both lattices, *without*
connecting them. It draws in the positive overlaps rather than exposing the
gaps.

What makes it safe is that **kinship carries no weight and activation never
traverses it.** It is an annotation, not an edge. Nothing can flow from one
person's lattice into another's, which is the property the tests above defend
and the one kinship must not quietly undo.

The consent model, since two people are involved:

- Per-user `cortex.kinship` setting, **default off**. Only nodes whose owner
  opted in are ever eligible.
- Candidate pairs are found by a **deterministic SQL/FTS pass**. No agent reads
  anything to produce the shortlist.
- Within that shortlist the agent **does see both descriptions**. Judging a
  match on names alone would mean confident, wrong merges, and a little
  disclosure inside an already-narrow, opted-in set buys a lot of accuracy.
- A kinship link is **always high risk**: it needs both node owners to approve
  before either of them sees it.

One rule falls out of this and applies to the whole module: **node names and
descriptions never reach an Observatory event detail.** The Observatory is
shared with admins. `engine/alignment.ts` already holds itself to exactly this
("no quoted evidence ever reaches an event detail"), and
`cortex-privacy.test.ts` asserts the `report(...)` payload carries counts only.

## How a conversation becomes a concept

The chain, end to end, now that it runs:

```
chat / coding session
  → the scheduled harvest reads what is new since its watermark
  → proposes concepts, with the connections that make them reachable
  → you accept in the Cortex tab
  → applyProposal writes them through the ordinary path, under one runId
  → they surface in cortex_query, and in the context digest's area index
```

For a long time this stopped dead at "you accept": `decideProposal` flipped a
status flag and changed no lattice, there was no `create` kind to propose a
concept in the first place, and the prompt asked for a payload with no schema
to put in it. Three gaps, each hiding the next, and the button looked like it
worked throughout.

**Memory is a separate input, not the route.** The memory job records *facts*
("prefers dark themes"); the lattice holds *concepts* ("visual design"). The
groomer reads recorded observations as one more thing to notice, but a concept
whose fact the memory job had no reason to write down would never arrive if
that were the only path — which is why the harvest reads conversation directly.

## Grooming — one line, not a scale

The three-band model this document originally carried is gone. "Low risk"
invited argument about where a given change sat, and the first thing filed under
it — merging near-identical nodes — turned out to be the most consequential
thing the groomer can do: a merge destroys a node, and restoring one from a log
snapshot means rebuilding its edges by hand.

One test replaces it, and it can be settled by looking rather than argued:

| Question | Answer |
|---|---|
| **Would this change what a query returns?** | Propose it. Merges, weights, new connections, deletions, areas, bridge flags. |
| **No?** | Apply it, and log it. Whitespace in a name — which is close to the whole list, and that is the point. |

### Two jobs, split by who asked

The groomer was doing two things at one cadence, and they do not want the same
one. **Adding is incremental** — a concept from this morning should land soon,
and each pass only needs what is new. **Consolidating is holistic** — merges and
structure need the whole lattice in view, and are most useful when someone is
already looking at the map.

| | Scheduled — *harvest* | Manual — *review* |
|---|---|---|
| tidy + detectors | yes | yes |
| model reads new activity → proposes concepts | yes | yes |
| model reads the **whole lattice** → merges, structure | — | yes |

Manual is a superset, so the expensive whole-lattice prompt only ever fires
because a person asked for it. That is a stronger cost control than any
heuristic, and it is what lets the cadence be daily rather than weekly.

### Who may file a concept under an area

**Only the reviewed pass.** `cortex_write` has no way to name an area, so a
concept an agent writes arrives unfiled; the groomer's `create` and `circuit`
proposals carry areas, and a person reads them first.

That is not agent-versus-agent, it is reviewed-versus-not — the same line drawn
everywhere else here. But the reasoning is worth keeping, because it is not only
about trust:

- **The two agents are not equally placed.** A chat agent sees area *names* in
  its digest line and nothing else — no counts, no contents, no view of the
  lattice. The groomer sees the whole index and the whole lattice.
- **Filing early forecloses.** A concept the chat agent puts under "Coastal
  fieldwork" because that is what exists is one the groomer never gets to
  consider recutting as fieldwork-versus-lab. Exact name matching would also
  have drifted — "Coastal fieldwork" against "Coastal field work" — but fuzzy
  matching answers only the smaller half of the problem.

So **unfiled is the normal arrival state**, not a fault: the detector no longer
flags it (one complaint per concept would be fifty rows saying nothing), and the
groom prompt *lists* what is waiting to be filed rather than counting it, so it
comes back as an actionable proposal naming an area.

The cost is smaller than it sounds. `seedNodes` matches name and description
through FTS and never consults areas — circuits were kept out of the routing
path deliberately — so an unfiled concept is retrievable the moment it exists.
What it lacks is a line in the digest's summary.

### What never needed a model

Orphans, near-duplicate names and unfiled concepts are graph properties, not
language ones. `detect()` finds them in code for no tokens, on both modes, so
nobody has to remember to go looking — and the model is left the one job it is
uniquely good at: reading what somebody said and proposing a concept from it.

Duplicate detection is Jaccard overlap on name tokens with a crude plural strip
— not real stemming, and worth saying so. Without the strip, "Tide pools" and
"Tide pool surveying" share one token in four and score 0.25, which is exactly
the pair a person would call the same concept twice.

Both halves file through the same queue and the same fingerprint dedupe, and
**fingerprints are orientation-free where the two ends are interchangeable**: a
merge of A into B and of B into A are the same conversation to have, and
without sorting the ids the detector and the model would duplicate each other
precisely where they overlap most.

### The first pass looks back three days, not forever

The harvest watermark starts unset, and an unset watermark used to mean *every
conversation ever had*. The first live run timed out on exactly that. The UX
audit guards its watermark with a first-run window; this copied the watermark
and not the guard.

Two fixes, and the second helps the memory job too: a three-day window on a
first harvest, and `gatherActivity` ordering chats newest-first. Without the
ordering the twenty it keeps are whichever twenty the database returned, so a
wide window summarised twenty arbitrary old conversations — slow, and the wrong
input for a job whose whole purpose is what is new.

### Telling the model when, not just what

`cortex_write`'s description used to say what the tool was and what belonged in
it, and never when to reach for it. A model went a whole conversation without
using it and, asked why, gave the right answer: no behavioural trigger, unlike
every skill description it carries. Compare the coding prompt's "read it with
the fetch_url tool — never search for a page whose address you already have",
which tells an agent what to *do*.

It now says to use it unprompted, names the occasions (a position argued for, a
synthesis, an interest that keeps resurfacing, an idea developed over several
turns), and calibrates the concept-versus-fact line with examples — the test
being whether the thing has *edges*. Examples are generic on purpose: the ones
that prompted this came from a real conversation, and nothing personal belongs
in the repo.

### When a run finds nothing, say which nothing

Three different outcomes used to look identical in the Observatory — a window
with no conversation in it, a model that answered with nothing, and a model that
spent its whole budget reasoning and never began an answer. The last is a
failure this codebase already names (`openai-compatible.ts` sets `reasonedOnly`,
`research.ts` reports "spent its whole token budget reasoning"); the groomer
ignored both that flag and `finishReason`.

A run now reports `activityChars` and `windowHours` — how much conversation it
read and how far back it looked — alongside `replyChars`, `finishReason` and
`reasonedOnly`. Sizes and flags only; no message text reaches an event detail.
The groom's token budget also went up, because a reasoning model spends part of
it before it starts answering.

### The skip

A harvest with no new conversation **makes no model call**, full stop. Those
were two conditions ANDed together, which meant a first pass — with no stored
signature — still asked a model about nothing and got a correct empty answer
back. A harvest reads conversation; the lattice signature is the *review* side's
question and now only gates that. Tidy and the detectors still run, because they are free. That is the
single biggest lever on cost, and what makes a short cadence sane: a quiet day
costs nothing.

The watermark only advances on a pass that actually reached a model, so a failed
run does not silently skip a day of conversation.

Tidying is deterministic and model-free, so it runs whether or not a provider is
configured and is testable without one. The thinking half reads the owner's
lattice and, read-only, their `memory_items` — the groomer may notice that a
recorded observation implies a concept, and never writes back to memory. One
direction, one place, the same shape as the UX audit reading telemetry.

`cortex_proposals` is modelled on `ux_ideas`, fingerprint included: a decision is
replayed to later runs, because re-raising something already turned down is how
a review queue teaches people to stop reading it. Reviewed in the Cortex tab
rather than Admin — it is somebody's own lattice, not a platform setting.

**Accepting carries out the change**, through the ordinary write path under one
`runId`, so an accepted suggestion is logged like a hand edit and undone the
same way. A proposal whose concepts have gone since it was raised fails and
stays open: a half-applied change nobody was told about is worse than one that
plainly did not happen. Dismissing is still only a decision.

**Undo covers creation as well as change.** Restoring a `before` snapshot only
answers for things that were modified; anything newly *made* — every concept in
an import, every connection the groomer adds — is undone by removing it. The
first version knew only the first half, so a whole-run revert could report
success having done nothing.

**Undo is what makes applying anything defensible.** A change you cannot undo is
a decision taken on your behalf; one you can is a suggestion you did not have to
accept. `revertChange` restores from the log's `before` snapshot, `revertRun`
undoes a whole pass, and the revert is itself logged rather than quietly
rewriting history.

**The log has a ceiling.** A `before` snapshot is a whole node, so at a thousand
concepts with a weekly groomer this is the fastest-growing thing Cortex owns.
`runId` collapses a run into one line in the UI, and `cortexChangeDays`
(default 90) is trimmed by the same `prune()` sweep that trims events and usage.
It prunes on prod as well as dev, unlike the UX backlog: nothing here suppresses
a future suggestion, it is a record read within days of being written.

**Hard rule regardless: the groomer never writes across an ownership boundary,
and never touches a row the owner-scoped API cannot reach.** The first version
carried a sweep for edges whose far end no longer exists. It was unreachable
code dressed as diligence — a scoped read cannot see such an edge in the first
place, and cleaning it would take an unscoped query over rows belonging to
nobody. A wasted row is much the cheaper problem.

## The file round trip

`exportPayload` and `importLattice` in `src/lib/server/cortex.ts`, reachable
from the File tab on `/cortex`. Concepts, connections and areas — areas
included, or a round trip silently drops every one and the context digest comes
back with nothing to group by.

A file is a new way into the store, so it is a new way to get the ownership
model wrong. Two rules keep it honest, and both are tested in
`cortex-privacy.test.ts`:

- **The owner is the person importing, never the file.** A payload naming
  somebody else is ignored rather than refused — there is nothing to negotiate.
- **Ids in a file are hints, not claims.** Concepts resolve by *name* through
  the ordinary write path, so importing over an existing lattice updates it
  instead of duplicating, and guessing an id reaches nothing.

Everything goes through `saveNode`/`saveAssociation`, so an import obeys the
concept cap, lands in the change log, and is undone as one run. A file that is
not a lattice, or one that exceeds the cap, returns a count of what did not fit
rather than a stack trace over a half-imported lattice.

## Still open

1. **Dedup beyond name resolution.** `cortex_write` resolves an exact name
   before creating, which catches "Tide pools" vs "tide POOLS". What catches
   "Music discovery" vs "Discovering new music"? Probably an FTS similarity
   pass in the groomer, banded low risk — but the threshold is a guess until
   the eval exists.
2. **Whether kinship should ever become an edge.** If two people repeatedly
   work in the same concept, a note may stop being enough. Any answer has to
   survive the conduit test above, which is a high bar and probably the right
   one.
3. **When `agentWrites` flips on.** Currently gated on the groomer existing.
   Whether that is the right trigger, or whether it wants a period of
   supervised writing first, is worth revisiting once P2's map makes the
   duplicate rate visible.
