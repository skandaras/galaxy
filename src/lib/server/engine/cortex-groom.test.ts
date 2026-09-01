import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { setSetting } from '$lib/server/settings';
import {
	cortexAssociations,
	cortexChangeLog,
	cortexNodes,
	cortexCircuits,
	cortexProposals,
	events
} from '$lib/server/db/schema';
import {
	listNodes,
	listAssociations,
	listChanges,
	listCircuits,
	saveCircuit,
	circuitIndex,
	cortexDigest,
	deleteNode,
	getNode,
	revertChange,
	revertRun,
	saveAssociation,
	saveNode,
	visibleEdges
} from '$lib/server/cortex';
import {
	buildGroomPrompt,
	decideProposal,
	listProposals,
	recordProposals,
	runCortexGroom,
	setUserGroomEnabled,
	groomStatus,
	applyProposal,
	fingerprint,
	KINDS,
	REQUIRES,
	detect,
	orphans,
	recordDetected,
	nameSimilarity,
	tidy
} from './cortex-groom';

const ANA = 'user-ana';
const BEN = 'user-ben';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(cortexAssociations).run();
	db.delete(cortexChangeLog).run();
	db.delete(cortexProposals).run();
	db.delete(cortexNodes).run();
	// Areas were never cleared, which held only while nothing outside the filing
	// suite made one — a case that leaks into every test after it, and the sort
	// of shared state that shows up as an unrelated suite failing.
	db.delete(cortexCircuits).run();
	db.delete(events).run();
	db.run(`DELETE FROM cortex_fts`);
});

describe('the mechanical pass', () => {
	it('tidies whitespace in a name and records what it was', () => {
		const node = saveNode({ name: 'Tide pools', ownerId: ANA });
		db.update(cortexNodes)
			.set({ name: '  Tide   pools  ' })
			.where(eq(cortexNodes.id, node.id))
			.run();

		expect(tidy(ANA, 'run-1')).toBe(1);
		expect(listNodes(ANA)[0].name).toBe('Tide pools');
		const entry = listChanges(ANA).find((c) => c.event === 'tidied')!;
		expect(entry.actor).toBe('groom');
		expect(entry.runId).toBe('run-1');
	});

	it('leaves the words alone, because words change what a query finds', () => {
		// The whole line the groomer works to: tidying may not alter a result.
		// Changing a name's spelling changes what FTS matches, so it is a
		// proposal, not a tidy.
		saveNode({ name: 'Tide pooles', ownerId: ANA });
		expect(tidy(ANA, 'run-1')).toBe(0);
		expect(listNodes(ANA)[0].name).toBe('Tide pooles');
	});

	it('cannot see an orphaned edge, and leaves it alone rather than reaching', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		const b = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		saveAssociation({ sourceId: a.id, targetId: b.id, userId: ANA });
		db.run(`PRAGMA foreign_keys = OFF`);
		db.delete(cortexNodes).where(eq(cortexNodes.id, b.id)).run();
		db.run(`PRAGMA foreign_keys = ON`);

		// The row survives, and that is fine: bounded by what its owner can see,
		// every read drops it, so it reaches neither traversal nor the map nor an
		// export. Removing it would mean an unscoped query over rows belonging to
		// nobody, and the groomer never touches what the owner-scoped API cannot.
		expect(tidy(ANA, 'run-1')).toBe(0);
		expect(db.select().from(cortexAssociations).all()).toHaveLength(1);
		expect(visibleEdges(ANA)).toHaveLength(0);
	});

	it('does not touch another person’s concepts', () => {
		const node = saveNode({ name: 'Tide pools', ownerId: BEN, visibility: 'shared' });
		db.update(cortexNodes).set({ name: '  Tide  pools ' }).where(eq(cortexNodes.id, node.id)).run();
		expect(tidy(ANA, 'run-1')).toBe(0);
	});
});

describe('proposals', () => {
	const suggest = (over: Record<string, unknown> = {}) => ({
		kind: 'merge',
		title: 'Merge Rockpools into Tide pools',
		rationale: 'Same concept',
		...over
	});

	beforeEach(() => {
		saveNode({ name: 'Tide pools', ownerId: ANA });
		saveNode({ name: 'Rockpools', ownerId: ANA });
	});

	it('files a suggestion for review rather than applying it', () => {
		const { added } = recordProposals(ANA, [suggest({ node: 'tide-pools', target: 'rockpools' })], 10);
		expect(added).toBe(1);
		expect(listProposals(ANA)).toHaveLength(1);
		// The point: nothing changed in the lattice itself.
		expect(listNodes(ANA)).toHaveLength(2);
	});

	it('does not raise something already decided', () => {
		const p = suggest({ node: 'tide-pools', target: 'rockpools' });
		recordProposals(ANA, [p], 10);
		const open = listProposals(ANA)[0];
		expect(decideProposal(open.id, ANA, 'discarded').ok).toBe(true);

		const second = recordProposals(ANA, [p], 10);
		// Re-raising something turned down is how a review queue teaches people
		// to stop reading it.
		expect(second.added).toBe(0);
		expect(second.duplicates).toBe(1);
	});

	it('drops a suggestion naming a concept the person cannot see', () => {
		const bens = saveNode({ name: 'Ben private', ownerId: BEN });
		const { added } = recordProposals(ANA, [suggest({ node: 'tide-pools', target: bens.id })], 10);
		// Either a hallucination or a boundary crossing. Neither is worth filing.
		expect(added).toBe(0);
	});

	it('refuses a decision from someone else', () => {
		recordProposals(ANA, [suggest({ node: 'tide-pools', target: 'rockpools' })], 10);
		const open = listProposals(ANA)[0];
		// Not "could not apply" but "there is no such suggestion", because from
		// where Ben is standing there genuinely is not one.
		expect(decideProposal(open.id, BEN, 'actioned')).toEqual({ ok: false, reason: 'missing' });
	});

	it('honours the per-run cap', () => {
		const many = Array.from({ length: 30 }, (_, i) =>
			suggest({ title: `Suggestion ${i}`, node: 'tide-pools', target: `t-${i}` })
		);
		expect(recordProposals(ANA, many, 5).added).toBeLessThanOrEqual(5);
	});
});

describe('what the prompt costs to build', () => {
	/** A lattice big enough that a per-concept query would show up as one. */
	function wide(count: number) {
		const made = Array.from({ length: count }, (_, i) =>
			saveNode({
				name: `Concept ${i}`,
				description: 'A description of roughly the length a real one would have.',
				ownerId: ANA
			})
		);
		for (let i = 1; i < made.length; i++) {
			saveAssociation({ sourceId: made[0].id, targetId: made[i].id, weight: 0.6, userId: ANA });
		}
		return made;
	}

	it('reads the connections once, not once per concept', () => {
		wide(40);
		// `describeNode` used to call `listAssociations`, which costs a full node
		// select *plus* a full edge select — per concept. Fifty concepts meant
		// about a hundred and fifty full-table reads to produce one string, and
		// it grew as the square of the lattice.
		//
		// Counted rather than timed: a wall-clock assertion passes on a small
		// fixture whatever the shape of the work, which is exactly how this went
		// unnoticed.
		let edgeReads = 0;
		const select = db.select.bind(db);
		// Forwards the projection: `buildGroomPrompt` runs entirely under this
		// spy, and one of its queries selects two named columns. Dropping the
		// argument would quietly turn that into a select-*, which still happens
		// to work and would be a trap for whoever changed it next.
		const spy = vi.spyOn(db, 'select').mockImplementation(((fields?: never) => {
			const builder = fields === undefined ? select() : select(fields);
			const from = builder.from.bind(builder);
			builder.from = (table: never) => {
				if (table === cortexAssociations) edgeReads++;
				return from(table);
			};
			return builder;
		}) as never);

		buildGroomPrompt(ANA, 10);
		spy.mockRestore();
		// Two as it stands — the adjacency map and the orphan check — against
		// roughly forty-two before. The headroom is for an unrelated check added
		// later; what this catches is the read count scaling with the lattice.
		expect(edgeReads).toBeLessThan(6);
	});

	it('keeps a big lattice inside its budget, and still names every concept', () => {
		const made = wide(200);
		const prompt = buildGroomPrompt(ANA, 10);
		// Every concept is visible, so nothing is proposed twice...
		for (const node of made.slice(0, 5)) expect(prompt).toContain(node.id);
		// ...but the descriptions are rationed, so the prompt stops growing with
		// the lattice. A review used to send all two hundred in full.
		expect(prompt).toContain('names only');
		expect(prompt.length).toBeLessThan(60_000);
	});

	it('gives the full description to the concepts a merge is judged from', () => {
		const made = wide(200);
		// The hub, which everything connects to. Merges, bridges and clusters
		// with no way out are all read off connections, so a concept with many is
		// exactly the one worth describing when there is not room for all.
		expect(buildGroomPrompt(ANA, 10)).toContain(`connects to: ${made[1].id}`);
	});
});

describe('the prompt', () => {
	it('shows the concepts, their connections and what was already decided', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		const b = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		saveAssociation({ sourceId: a.id, targetId: b.id, userId: ANA });
		recordProposals(ANA, [{ kind: 'merge', title: 'An old idea', node: a.id, target: b.id }], 10);

		const prompt = buildGroomPrompt(ANA, 10);
		expect(prompt).toContain('Tide pools');
		expect(prompt).toContain('connects to: coastal-ecology');
		expect(prompt).toContain('An old idea');
	});

	it('never shows another person’s lattice', () => {
		saveNode({ name: 'Tide pools', ownerId: ANA });
		saveNode({ name: 'Ben private concept', ownerId: BEN });
		expect(buildGroomPrompt(ANA, 10)).not.toContain('Ben private concept');
	});
});

describe('undo', () => {
	it('puts a tidied name back, and says that it did', () => {
		const node = saveNode({ name: 'Tide pools', ownerId: ANA });
		db.update(cortexNodes).set({ name: ' Tide  pools ' }).where(eq(cortexNodes.id, node.id)).run();
		tidy(ANA, 'run-1');

		const entry = listChanges(ANA).find((c) => c.event === 'tidied')!;
		expect(revertChange(entry.id, ANA)).toBe(true);
		expect(listNodes(ANA)[0].name).toBe(' Tide  pools ');
		// History records what happened rather than quietly rewriting itself.
		expect(listChanges(ANA).some((c) => c.event === 'reverted')).toBe(true);
	});

	it('undoes a whole run at once', () => {
		for (const name of ['Tide pools', 'Storm logs']) {
			const n = saveNode({ name, ownerId: ANA });
			db.update(cortexNodes).set({ name: `  ${name}  ` }).where(eq(cortexNodes.id, n.id)).run();
		}
		tidy(ANA, 'run-7');
		expect(revertRun('run-7', ANA)).toBe(2);
	});

	it('refuses to undo someone else’s change', () => {
		const node = saveNode({ name: 'Tide pools', ownerId: ANA });
		db.update(cortexNodes).set({ name: ' Tide  pools ' }).where(eq(cortexNodes.id, node.id)).run();
		tidy(ANA, 'run-1');
		const entry = listChanges(ANA).find((c) => c.event === 'tidied')!;
		expect(revertChange(entry.id, BEN)).toBe(false);
	});
});

describe('a run with nothing configured', () => {
	it('still tidies, because that half needs no model', () => {
		const node = saveNode({ name: 'Tide pools', ownerId: ANA });
		saveNode({ name: 'Storm logs', ownerId: ANA });
		saveNode({ name: 'Seabird counts', ownerId: ANA });
		db.update(cortexNodes).set({ name: '  Tide pools ' }).where(eq(cortexNodes.id, node.id)).run();

		return runCortexGroom('manual', ANA).then((res) => {
			expect(res.tidied).toBe(1);
			// No provider in tests, so the thinking half stands down and says so.
			expect(res.ran).toBe(false);
			expect(res.reason).toBe('no model configured');
		});
	});

	it('reports counts to the Observatory, never concepts', async () => {
		saveNode({ name: 'A distinctive marker concept', ownerId: ANA });
		saveNode({ name: 'Storm logs', ownerId: ANA });
		saveNode({ name: 'Seabird counts', ownerId: ANA });
		await runCortexGroom('manual', ANA);
		const serialised = JSON.stringify(db.select().from(events).all());
		expect(serialised).toContain('cortex.groom');
		expect(serialised).not.toContain('distinctive marker');
	});
});

describe('retention', () => {
	it('trims old change history, on prod as well', async () => {
		const { prune } = await import('./scheduler');
		const node = saveNode({ name: 'Tide pools', ownerId: ANA });
		db.update(cortexNodes).set({ name: ' Tide  pools ' }).where(eq(cortexNodes.id, node.id)).run();
		tidy(ANA, 'run-old');
		// A `before` snapshot is a whole node, so this is the fastest-growing
		// thing Cortex owns. Unlike the UX backlog it prunes everywhere: nothing
		// here suppresses a future suggestion, it is a record read within days.
		db.update(cortexChangeLog)
			.set({ createdAt: new Date(Date.now() - 200 * 86_400_000) })
			.run();
		expect(prune(Date.now(), true).cortexChanges).toBeGreaterThan(0);
		expect(listChanges(ANA)).toHaveLength(0);
	});
});

describe('per-user opt-out', () => {
	it('defaults to letting the groomer look', () => {
		expect(groomStatus(ANA).enabled).toBe(true);
	});

	it('remembers a decision, and only that person’s', () => {
		setUserGroomEnabled(ANA, false);
		// The cadence is the platform's; whether it touches *your* concepts is
		// yours, the same split the memory job uses.
		expect(groomStatus(ANA).enabled).toBe(false);
		expect(groomStatus(BEN).enabled).toBe(true);
	});
});

describe('accepting a suggestion', () => {
	/** File one proposal and hand back its id. */
	function file(p: Record<string, unknown>): string {
		expect(recordProposals(ANA, [p], 10).added).toBe(1);
		return listProposals(ANA)[0].id;
	}

	it('creates the concept and its connections', () => {
		// The assertion this whole phase exists for. Accepting used to flip a
		// status flag and change no lattice — a button that looked like it worked.
		const anchor = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		const id = file({
			kind: 'create',
			title: 'Add "Tide pools"',
			payload: {
				name: 'Tide pools',
				description: 'Rockpool surveying at low water',
				connect: [{ node: anchor.id, weight: 0.8, why: 'a place it is practised' }]
			}
		});

		expect(applyProposal(id, ANA).ok).toBe(true);
		const made = listNodes(ANA).find((n) => n.name === 'Tide pools')!;
		expect(made).toBeTruthy();
		expect(made.description).toContain('Rockpool');
		// Connections are part of the suggestion: an unconnected concept can
		// never surface, so creating one without them would be a null change.
		expect(listAssociations(made.id, ANA)).toHaveLength(1);
		expect(listProposals(ANA)).toHaveLength(0);
	});

	it('folds one concept into another on a merge', () => {
		const keep = saveNode({ name: 'Tide pools', ownerId: ANA });
		const dupe = saveNode({ name: 'Rockpools', ownerId: ANA });
		const id = file({ kind: 'merge', title: 'Merge', node: keep.id, target: dupe.id });

		expect(applyProposal(id, ANA).ok).toBe(true);
		expect(listNodes(ANA).map((n) => n.name)).toEqual(['Tide pools']);
	});

	it('lands in the history as one run, and reverts as one', () => {
		const anchor = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		const id = file({
			kind: 'create',
			title: 'Add "Tide pools"',
			payload: { name: 'Tide pools', connect: [{ node: anchor.id }] }
		});
		applyProposal(id, ANA);

		const entry = listChanges(ANA).find((c) => c.actor === 'groom' && c.event === 'created')!;
		expect(entry.runId).toBeTruthy();
		expect(revertRun(entry.runId!, ANA)).toBeGreaterThan(0);
		expect(listNodes(ANA).map((n) => n.name)).toEqual(['Coastal ecology']);
	});

	it('fails cleanly and stays open when the concept has since gone', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		const b = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		const id = file({ kind: 'connect', title: 'Connect', node: a.id, target: b.id });
		deleteNode(b.id, ANA);

		// A half-applied change nobody was told about is worse than one that
		// plainly did not happen — and it has to say *why*, or the person who
		// pressed Accept is told the suggestion never existed.
		const failed = applyProposal(id, ANA);
		expect(failed.ok).toBe(false);
		expect(failed.reason).toBeTruthy();
		expect(failed.reason).not.toBe('missing');
		expect(listProposals(ANA)).toHaveLength(1);
	});

	it('is still just a decision when dismissed', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		const b = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		const id = file({ kind: 'connect', title: 'Connect', node: a.id, target: b.id });

		expect(decideProposal(id, ANA, 'discarded').ok).toBe(true);
		expect(listAssociations(a.id, ANA)).toHaveLength(0);
	});

	it('will not apply someone else’s suggestion', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		const id = file({ kind: 'delete', title: 'Delete', node: a.id });
		expect(applyProposal(id, BEN).ok).toBe(false);
		expect(listNodes(ANA)).toHaveLength(1);
	});
});

describe('every kind of suggestion, applied', () => {
	/**
	 * The rule, held for all nine kinds at once rather than for whichever one
	 * somebody last noticed was broken: **a suggestion that reaches the queue can
	 * be carried out.**
	 *
	 * Two kinds shipped violating it, found weeks apart — an orphan `connect`
	 * with only one end, then a `circuit` with no concept at all — and each was
	 * fixed where it was found. Both were the same fault: nothing said what a
	 * kind needed, so the half that files and the half that applies disagreed,
	 * and the disagreement surfaced as a button that did nothing. Driving this
	 * off `REQUIRES` means a kind added later without a rule fails here instead
	 * of shipping a dead row.
	 */

	/** A complete, applicable suggestion of every kind, against a real lattice. */
	function wellFormed(kind: string, a: string, b: string): Record<string, unknown> {
		const base = { kind, title: `A ${kind} suggestion`, rationale: 'because' };
		const payload: Record<string, unknown> = {};
		if (kind === 'create') {
			Object.assign(payload, { name: 'A new concept', connect: [{ node: a }] });
			return { ...base, payload };
		}
		if (kind === 'weight') payload.weight = 0.7;
		if (kind === 'circuit') payload.areas = ['Somewhere'];
		if (kind === 'rename') payload.name = 'A different name';
		if (kind === 'convergence') payload.isConvergence = true;
		return {
			...base,
			node: a,
			...(REQUIRES[kind as keyof typeof REQUIRES].target ? { target: b } : {}),
			payload
		};
	}

	function lattice() {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		const b = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		saveAssociation({ sourceId: a.id, targetId: b.id, weight: 0.5, userId: ANA });
		return { a: a.id, b: b.id };
	}

	for (const kind of KINDS) {
		it(`files a complete ${kind} and can carry it out`, () => {
			const { a, b } = lattice();
			expect(recordProposals(ANA, [wellFormed(kind, a, b)], 10).added).toBe(1);
			const open = listProposals(ANA)[0];
			const done = applyProposal(open.id, ANA);
			expect(done.reason ?? '').toBe('');
			expect(done.ok).toBe(true);
		});

		it(`never files a ${kind} that could not be carried out`, () => {
			const { a, b } = lattice();
			const needs = REQUIRES[kind];
			// Every way this kind can arrive unusable: no concept, no second
			// concept, or missing a field without which applying is a no-op.
			const broken: Record<string, unknown>[] = [];
			const full = wellFormed(kind, a, b) as Record<string, unknown>;
			if (needs.node) broken.push({ ...full, node: undefined });
			if (needs.target) broken.push({ ...full, target: undefined });
			for (const key of needs.payload) {
				const payload = { ...(full.payload as Record<string, unknown>) };
				delete payload[key];
				broken.push({ ...full, payload });
			}
			if (!broken.length) return; // `create` needs nothing, by definition

			const res = recordProposals(ANA, broken, 20);
			expect(res.added).toBe(0);
			expect(res.dropped.incomplete).toBe(broken.length);
			expect(listProposals(ANA)).toHaveLength(0);
		});
	}
});

describe('where the model put it', () => {
	it('takes a concept nested inside payload, and applies it', () => {
		const area = saveCircuit({ name: 'Geographic connection', ownerId: ANA });
		const node = saveNode({ name: 'Life in Norway', ownerId: ANA });
		// What a model actually sent. The prompt read `circuit — "node", payload
		// {…}`, which compresses two nesting levels into one comma, so the node
		// went inside the payload — a right answer in the wrong envelope, filed
		// with no concept and dead on arrival.
		expect(
			recordProposals(
				ANA,
				[
					{
						kind: 'circuit',
						title: 'File life-in-norway under geographic-connection',
						rationale: 'it is explicitly about living in a country',
						payload: { node: node.id, areas: [area.id] }
					}
				],
				10
			).added
		).toBe(1);
		const open = listProposals(ANA)[0];
		expect(open.nodeId).toBe(node.id);
		expect(applyProposal(open.id, ANA).ok).toBe(true);
		expect(getNode(node.id, ANA)?.circuits).toEqual([area.id]);
	});

	it('recovers a row filed before the queue enforced its own shape', () => {
		const area = saveCircuit({ name: 'Geographic connection', ownerId: ANA });
		const node = saveNode({ name: 'Life in Norway', ownerId: ANA });
		// Straight to the table, because this is the row that is already sitting
		// in somebody's queue: no nodeId, and the reference one level down.
		db.insert(cortexProposals)
			.values({
				id: 'stuck',
				userId: ANA,
				kind: 'circuit',
				title: 'File life-in-norway under geographic-connection',
				rationale: 'raised before the check existed',
				nodeId: null,
				targetId: null,
				payload: { node: node.id, areas: [area.id] },
				fingerprint: 'circuit|stuck',
				status: 'open',
				createdAt: new Date()
			})
			.run();
		expect(applyProposal('stuck', ANA).ok).toBe(true);
		expect(getNode(node.id, ANA)?.circuits).toEqual([area.id]);
	});

	it('says what to do when nothing names the concept at all', () => {
		saveNode({ name: 'Life in Norway', ownerId: ANA });
		db.insert(cortexProposals)
			.values({
				id: 'hopeless',
				userId: ANA,
				kind: 'circuit',
				title: 'File it somewhere',
				rationale: 'named the concept only in the title',
				nodeId: null,
				targetId: null,
				payload: { areas: ['somewhere'] },
				fingerprint: 'circuit|hopeless',
				status: 'open',
				createdAt: new Date()
			})
			.run();
		const failed = applyProposal('hopeless', ANA);
		expect(failed.ok).toBe(false);
		// Actionable rather than a restatement of the schema, and it stays open
		// so the person decides — nothing auto-dismisses somebody's queue.
		expect(failed.reason).toContain('dismiss it');
		expect(listProposals(ANA)).toHaveLength(1);
	});
});

describe('fingerprints', () => {
	it('reads a merge the same way round or not', () => {
		// A detector finding one and a model proposing the other are the same
		// conversation to have, and would otherwise both sit in the queue.
		expect(fingerprint('merge', 'tide-pools', 'rockpools')).toBe(
			fingerprint('merge', 'rockpools', 'tide-pools')
		);
	});

	it('keeps direction where direction means something', () => {
		expect(fingerprint('rename', 'tide-pools', 'a')).not.toBe(
			fingerprint('rename', 'a', 'tide-pools')
		);
	});
});

describe('the free half', () => {
	it('pairs an orphan with the nearest concept, so accepting it does something', () => {
		saveNode({ name: 'Tide pools', description: 'Rockpool surveying', ownerId: ANA });
		saveNode({ name: 'Rockpool photography', description: 'Photographing tide pools', ownerId: ANA });
		const found = detect(ANA).filter((d) => d.kind === 'connect');
		expect(found.length).toBeGreaterThan(0);
		// The whole point of the pairing. A `connect` with one end is a row
		// `applyProposal` cannot carry out, which is what every orphan finding
		// used to be — Accept failed, and the API said "no such suggestion".
		for (const d of found) expect(d.target).toBeTruthy();
	});

	it('an orphan finding can actually be accepted, and makes the connection', () => {
		const a = saveNode({ name: 'Tide pools', description: 'Rockpool surveying', ownerId: ANA });
		saveNode({ name: 'Rockpool photography', description: 'Photographing tide pools', ownerId: ANA });
		recordDetected(ANA, detect(ANA), 20);
		const orphanFix = listProposals(ANA).find((p) => p.kind === 'connect')!;
		expect(orphanFix).toBeTruthy();
		expect(applyProposal(orphanFix.id, ANA).ok).toBe(true);
		expect(listAssociations(a.id, ANA).length).toBeGreaterThan(0);
	});

	it('never offers to connect two concepts it also calls one concept', () => {
		saveNode({ name: 'Storm logs', description: 'Notes on coastal storms', ownerId: ANA });
		saveNode({ name: 'The storm logs', description: 'Notes on coastal storms', ownerId: ANA });
		const found = detect(ANA);
		// FTS ranks a near-duplicate first by construction, so without a guard the
		// orphan check pairs exactly the two the merge check is asking to fold
		// together — two suggestions contradicting each other in one queue.
		expect(found.some((d) => d.kind === 'merge')).toBe(true);
		expect(found.some((d) => d.kind === 'connect')).toBe(false);
	});

	it('files nothing for an orphan it cannot pair, and hands it to the prompt', () => {
		saveNode({ name: 'Bicycle repair', ownerId: ANA });
		// Nothing to pair it with, and inventing a neighbour would be worse than
		// admitting there isn't one. It goes to the model instead, which can read
		// two descriptions and see what a string match cannot.
		expect(detect(ANA).some((d) => d.kind === 'connect')).toBe(false);
		expect(orphans(ANA).map((n) => n.name)).toEqual(['Bicycle repair']);
		expect(buildGroomPrompt(ANA, 5)).toContain('CONNECTS TO NOTHING');
	});

	it('flags two names that look like one concept', () => {
		saveNode({ name: 'Tide pools', ownerId: ANA });
		saveNode({ name: 'The tide pools', ownerId: ANA });
		expect(detect(ANA).some((d) => d.kind === 'merge')).toBe(true);
	});

	it('tells a near-duplicate from a different concept', () => {
		expect(nameSimilarity('Tide pools', 'Letterpress printing')).toBe(0);
		// Singular and plural are the same word to a person, and this is the pair
		// the check exists for.
		expect(nameSimilarity('Tide pools', 'Tide pool surveying')).toBeGreaterThan(0.6);
		expect(nameSimilarity('Tide pools', 'The tide pools')).toBe(1);
	});

	it('does not flag an unfiled concept, because that is now where they start', () => {
		saveNode({ name: 'Tide pools', ownerId: ANA });
		// Nothing else can file a concept, so arriving unfiled is normal rather
		// than a fault, and one complaint per concept would drown the queue.
		// Filing is a job of the groom pass, which can name a specific area.
		expect(detect(ANA).some((d) => d.kind === 'circuit')).toBe(false);
	});

	it('looks at nobody else’s concepts', () => {
		saveNode({ name: 'Ben orphan', ownerId: BEN, visibility: 'shared' });
		expect(detect(ANA).some((d) => d.title.includes('Ben orphan'))).toBe(false);
	});

	it('runs with no model configured, and files what it found', async () => {
		// A near-duplicate pair: something the free half can find on its own, and
		// a finding that does not depend on a model being configured.
		saveNode({ name: 'Tide pools', ownerId: ANA });
		saveNode({ name: 'The tide pools', ownerId: ANA });
		saveNode({ name: 'Seabird counts', ownerId: ANA });
		const res = await runCortexGroom('manual', ANA);
		// The half that needs a model stands down; the half that does not still
		// did its work.
		expect(res.ran).toBe(false);
		expect(res.detected).toBeGreaterThan(0);
		expect(listProposals(ANA).length).toBeGreaterThan(0);
	});

	it('does not raise the same finding twice', async () => {
		saveNode({ name: 'Tide pools', ownerId: ANA });
		saveNode({ name: 'The tide pools', ownerId: ANA });
		saveNode({ name: 'Seabird counts', ownerId: ANA });
		await runCortexGroom('manual', ANA);
		const first = listProposals(ANA).length;
		const second = await runCortexGroom('manual', ANA);
		expect(second.detected).toBe(0);
		expect(listProposals(ANA)).toHaveLength(first);
	});
});

describe('the two modes', () => {
	beforeEach(() => {
		saveNode({ name: 'Tide pools', description: 'rockpool surveying', ownerId: ANA });
		saveNode({ name: 'Storm logs', ownerId: ANA });
		saveNode({ name: 'Seabird counts', ownerId: ANA });
	});

	it('a review reads the whole lattice, with its connections', () => {
		const prompt = buildGroomPrompt(ANA, 10, 'review');
		expect(prompt).toContain('A FULL REVIEW');
		expect(prompt).toContain('connects to:');
		expect(prompt).toContain('Seabird counts');
	});

	it('a harvest reads what was said, and only a slice of the lattice', () => {
		const prompt = buildGroomPrompt(ANA, 10, 'harvest', 'we talked about rockpool surveying');
		expect(prompt).toContain('SINCE THE LAST PASS');
		expect(prompt).toContain('rockpool surveying');
		// Names for the rest is all that is needed to avoid proposing a duplicate.
		expect(prompt).toContain('names only');
	});

	it('asks for concepts on a harvest and consolidation on a review', () => {
		expect(buildGroomPrompt(ANA, 10, 'harvest', 'x')).toContain('worth adding');
		expect(buildGroomPrompt(ANA, 10, 'review')).toContain('near-duplicate concepts');
	});

	it('a manual run is a review, a scheduled one is a harvest', async () => {
		expect((await runCortexGroom('manual', ANA)).mode).toBe('review');
		expect((await runCortexGroom('schedule', ANA)).mode).toBe('harvest');
	});

	/**
	 * The mark is only written by a pass that actually reached a model, so with
	 * none configured it never gets set — correct, since nothing has been read,
	 * but it means the skip has to be set up rather than arrived at.
	 */
	function markAsSeen() {
		const nodes = listNodes(ANA);
		setSetting(
			'cortex.groom.latticeMark',
			`${nodes.length}:${visibleEdges(ANA).length}:${nodes.reduce(
				(m, n) => Math.max(m, n.updatedAt?.getTime() ?? 0),
				0
			)}`,
			ANA
		);
	}

	it('a quiet scheduled pass makes no model call at all', async () => {
		// The lever that makes a daily — or hourly — cadence affordable. A harvest
		// reads conversation, so with none there is nothing to read whatever the
		// lattice has been doing: the signature used to be ANDed into this, which
		// meant a first pass with nothing to say still spent a call.
		markAsSeen();
		const res = await runCortexGroom('schedule', ANA);
		expect(res.ran).toBe(false);
		expect(res.reason).toBe('no new conversation in the window');
		expect(res.activityChars).toBe(0);
	});

	it('skips a scheduled review when the lattice has not moved', async () => {
		// The signature is the review side's question, and only its question.
		markAsSeen();
		const res = await runCortexGroom('schedule', ANA, 'review');
		expect(res.ran).toBe(false);
		expect(res.reason).toBe('nothing has changed since the last review');
	});

	it('runs a review somebody asked for, whatever the signature says', async () => {
		// The signature is a cost control on a pass nobody asked for. Applied to
		// the button it meant that rejecting everything in the queue left the
		// button saying "nothing has changed" forever, which is most of how the
		// groomer came to look broken.
		markAsSeen();
		const res = await runCortexGroom('manual', ANA);
		expect(res.reason).not.toBe('nothing has changed since the last review');
	});

	it('picks a review back up when the lattice changes', async () => {
		markAsSeen();
		saveNode({ name: 'Kelp forests', ownerId: ANA });
		const next = await runCortexGroom('schedule', ANA, 'review');
		expect(next.reason).not.toBe('nothing has changed since the last review');
	});
});

describe('filing', () => {
	function file(p: Record<string, unknown>): string {
		expect(recordProposals(ANA, [p], 10).added).toBe(1);
		return listProposals(ANA)[0].id;
	}

	it('files a created concept under an existing area, matched by id', () => {
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		const id = file({
			kind: 'create',
			title: 'Add "Tide pools"',
			payload: { name: 'Tide pools', areas: [area.id] }
		});
		expect(applyProposal(id, ANA).ok).toBe(true);
		// Asserted through the digest, because being in the index is the thing
		// filing is *for*.
		expect(cortexDigest(ANA)).toContain('Coastal fieldwork (1)');
	});

	it('takes the display name too, since a model will sometimes answer with it', () => {
		saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		const id = file({
			kind: 'create',
			title: 'Add "Tide pools"',
			payload: { name: 'Tide pools', areas: ['coastal FIELDWORK'] }
		});
		applyProposal(id, ANA);
		expect(listCircuits(ANA)).toHaveLength(1);
		expect(cortexDigest(ANA)).toContain('Coastal fieldwork (1)');
	});

	it('may name an area that does not exist yet, because a person read it first', () => {
		const id = file({
			kind: 'create',
			title: 'Add "Tide pools"',
			payload: { name: 'Tide pools', areas: ['Coastal fieldwork'] }
		});
		applyProposal(id, ANA);
		expect(listCircuits(ANA).map((c) => c.name)).toEqual(['Coastal fieldwork']);
	});

	it('files an existing concept through a circuit proposal', () => {
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		const node = saveNode({ name: 'Tide pools', ownerId: ANA });
		const id = file({
			kind: 'circuit',
			title: 'File under Coastal fieldwork',
			node: node.id,
			payload: { areas: [area.id] }
		});
		expect(applyProposal(id, ANA).ok).toBe(true);
		expect(cortexDigest(ANA)).toContain('Coastal fieldwork (1)');
	});

	it('lists what is waiting to be filed rather than counting it', () => {
		saveNode({ name: 'Tide pools', description: 'rockpool surveying', ownerId: ANA });
		saveNode({ name: 'Storm logs', ownerId: ANA });
		saveNode({ name: 'Seabird counts', ownerId: ANA });
		const prompt = buildGroomPrompt(ANA, 10, 'review');
		// A count tells a model there is work without telling it what the work is.
		expect(prompt).toContain('NOT YET FILED');
		expect(prompt).toContain('Tide pools');
		expect(prompt).toContain('rockpool surveying');
	});
});

describe('the write tool cannot file', () => {
	it('offers no way to name an area', async () => {
		const { cortexTools } = await import('$lib/server/engine/tools/cortex');
		const write = cortexTools(ANA).find((t) => t.def.name === 'cortex_write')!;
		const params = JSON.stringify(write.def.parameters);
		// Filing is a taxonomy decision, and this agent sees area names in a
		// digest line and nothing else. It also writes unreviewed.
		expect(params).not.toContain('area');
		expect(params).not.toContain('circuit');
	});

	it('leaves what it writes unfiled, and says so in the index', async () => {
		const { cortexTools } = await import('$lib/server/engine/tools/cortex');
		const write = cortexTools(ANA).find((t) => t.def.name === 'cortex_write')!;
		await write.execute({ name: 'Tide pools', description: 'rockpool surveying' });
		expect(circuitIndex(ANA).unfiled).toBe(1);
	});
});
