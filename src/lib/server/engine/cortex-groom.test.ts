import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import {
	cortexAssociations,
	cortexChangeLog,
	cortexNodes,
	cortexProposals,
	events
} from '$lib/server/db/schema';
import {
	listNodes,
	listChanges,
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
		expect(decideProposal(open.id, ANA, 'discarded')).toBe(true);

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
		recordProposals(ANA, [suggest({ node: 'tide-pools' })], 10);
		const open = listProposals(ANA)[0];
		expect(decideProposal(open.id, BEN, 'actioned')).toBe(false);
	});

	it('honours the per-run cap', () => {
		const many = Array.from({ length: 30 }, (_, i) =>
			suggest({ title: `Suggestion ${i}`, node: 'tide-pools', target: `t-${i}` })
		);
		expect(recordProposals(ANA, many, 5).added).toBeLessThanOrEqual(5);
	});
});

describe('the prompt', () => {
	it('shows the concepts, their connections and what was already decided', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		const b = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		saveAssociation({ sourceId: a.id, targetId: b.id, userId: ANA });
		recordProposals(ANA, [{ kind: 'merge', title: 'An old idea', node: a.id }], 10);

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
