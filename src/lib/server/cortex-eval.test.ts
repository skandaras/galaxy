import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { cortexAssociations, cortexChangeLog, cortexNodes } from '$lib/server/db/schema';
import { activate } from '$lib/server/cortex';
import { EVAL_QUERIES, seedFixtureLattice, type EvalQuery } from '$lib/server/cortex-fixture';
import { setSetting } from '$lib/server/settings';

/**
 * How good is retrieval, and did a change make it worse?
 *
 * Every constant in the traversal is a guess. Without something that can tell
 * better from worse they stay guesses forever, and any change to them is a
 * matter of taste — which is precisely the state this file exists to end.
 *
 * What it is *not* is a source of truth about anyone's real lattice. The
 * fixture is fiction, so a score here says the algorithm behaves sensibly on a
 * graph shaped the way the design assumes. That is worth knowing and it is not
 * the same as being right. The floors below are therefore set as a regression
 * guard — comfortably under what is measured today, so an honest change has
 * room to move and a bad one still trips.
 */

const USER = 'user-eval';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(cortexAssociations).run();
	db.delete(cortexChangeLog).run();
	db.delete(cortexNodes).run();
	db.run(`DELETE FROM cortex_fts`);
	setSetting('cortex', {});
	seedFixtureLattice(USER);
});

interface Score {
	query: EvalQuery;
	returned: string[];
	/** Of what should have surfaced, how much did. */
	recall: number;
	/**
	 * Precision at the size of the expected set, not over the whole return.
	 * A traversal deliberately returns a neighbourhood, so scoring precision
	 * across all of it would punish the behaviour we asked for; what matters is
	 * whether the *top* of the list is the part a person named.
	 */
	precisionAtK: number;
}

interface EvalOpts {
	gating?: boolean;
	convergenceBoost?: boolean;
}

function score(opts: EvalOpts = {}): Score[] {
	return EVAL_QUERIES.map((q) => {
		const returned = activate({ userId: USER, query: q.query, ...opts }).nodes.map(
			(n) => n.node.id
		);
		if (!q.expect.length) {
			return { query: q, returned, recall: returned.length ? 0 : 1, precisionAtK: returned.length ? 0 : 1 };
		}
		const expected = new Set(q.expect);
		const hit = returned.filter((id) => expected.has(id)).length;
		const topK = returned.slice(0, q.expect.length);
		return {
			query: q,
			returned,
			recall: hit / q.expect.length,
			precisionAtK: topK.filter((id) => expected.has(id)).length / q.expect.length
		};
	});
}

const mean = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);

function summarise(scores: Score[]) {
	return {
		recall: mean(scores.map((s) => s.recall)),
		precisionAtK: mean(scores.map((s) => s.precisionAtK))
	};
}

function byKind(scores: Score[], kind: EvalQuery['kind']) {
	return summarise(scores.filter((s) => s.query.kind === kind));
}

/** The table. Printed on every run, because a guard nobody can read is useless. */
function report(scores: Score[]): string {
	const lines = [
		'',
		'  cortex retrieval eval',
		'  ─────────────────────────────────────────────────────────────────',
		'  kind         recall   p@k   query',
		'  ─────────────────────────────────────────────────────────────────'
	];
	for (const s of scores) {
		lines.push(
			`  ${s.query.kind.padEnd(11)}  ${s.recall.toFixed(2)}   ${s.precisionAtK.toFixed(2)}  ` +
				`${s.query.query.slice(0, 40)}`
		);
	}
	lines.push('  ─────────────────────────────────────────────────────────────────');
	for (const kind of ['search', 'traversal', 'convergence', 'negative'] as const) {
		const m = byKind(scores, kind);
		lines.push(
			`  ${kind.padEnd(11)}  ${m.recall.toFixed(2)}   ${m.precisionAtK.toFixed(2)}`
		);
	}
	const overall = summarise(scores);
	lines.push(
		`  ${'OVERALL'.padEnd(11)}  ${overall.recall.toFixed(2)}   ${overall.precisionAtK.toFixed(2)}`,
		''
	);
	return lines.join('\n');
}

describe('retrieval quality', () => {
	it('scores the fixture and prints the table', () => {
		const scores = score();
		console.log(report(scores));
		expect(scores).toHaveLength(EVAL_QUERIES.length);
	});

	it('finds what plain search should find', () => {
		expect(byKind(score(), 'search').recall).toBeGreaterThanOrEqual(FLOOR.search);
	});

	it('reaches the neighbourhood, not just the match', () => {
		expect(byKind(score(), 'traversal').recall).toBeGreaterThanOrEqual(FLOOR.traversal);
	});

	it('pulls both sides of a bridge', () => {
		expect(byKind(score(), 'convergence').recall).toBeGreaterThanOrEqual(FLOOR.convergence);
	});

	it('answers nothing when there is nothing to answer', () => {
		// A lattice that responds to every question is as useless as one that
		// responds to none, and this is the cheaper failure to introduce.
		expect(byKind(score(), 'negative').recall).toBe(1);
	});

	it('puts the named nodes at the top, not merely in the list', () => {
		expect(summarise(score()).precisionAtK).toBeGreaterThanOrEqual(FLOOR.precisionAtK);
	});

	it('leaves an unconnected node unconnected', () => {
		const returned = activate({ userId: USER, query: 'bicycle weekend habit' }).nodes.map(
			(n) => n.node.id
		);
		expect(returned).toEqual(['bicycle-repair']);
	});
});

/**
 * Contextual gating and the convergence boost are the two mechanisms the design
 * argued for and never tested. Adding a mechanism because the design mentions it
 * is how a system fills up with knobs that do nothing, or worse.
 *
 * So each one is A/B'd against the same fixture: on must be no worse than off.
 * That is a deliberately weak bar. These constants are not tuned — the fixture
 * is fiction, and fitting numbers to it would be fitting them to assumptions
 * rather than to a real lattice. The bar is "this does not hurt", and real
 * tuning waits for real data.
 */
describe('the two mechanisms, held to account', () => {
	const overall = (o: EvalOpts) => summarise(score(o));

	it('gating earns its place', () => {
		const on = overall({ gating: true });
		const off = overall({ gating: false });
		console.log(
			`\n  gating   on: recall ${on.recall.toFixed(3)} p@k ${on.precisionAtK.toFixed(3)}` +
				`  |  off: recall ${off.recall.toFixed(3)} p@k ${off.precisionAtK.toFixed(3)}`
		);
		// Ships on because both of these hold, not because the design mentioned it.
		expect(on.recall).toBeGreaterThanOrEqual(off.recall);
		expect(on.precisionAtK).toBeGreaterThanOrEqual(off.precisionAtK);
	});

	it('the convergence boost does not, so it ships off', () => {
		const on = overall({ convergenceBoost: true });
		const off = overall({ convergenceBoost: false });
		console.log(
			`  boost    on: recall ${on.recall.toFixed(3)} p@k ${on.precisionAtK.toFixed(3)}` +
				`  |  off: recall ${off.recall.toFixed(3)} p@k ${off.precisionAtK.toFixed(3)}\n`
		);
		// Written to defend the shipped default rather than the design's
		// preference. Bridges already surface on this fixture without any help, so
		// the boost only reorders — and reorders slightly worse. Flipping the
		// default means making this assertion fail honestly, by finding a lattice
		// where the boost actually reaches something.
		expect(off.precisionAtK).toBeGreaterThanOrEqual(on.precisionAtK);
		expect(off.recall).toBeGreaterThanOrEqual(on.recall);
	});

	it('still changes an answer, so it is a real switch and not dead code', () => {
		const withBoost = score({ convergenceBoost: true });
		const without = score({ convergenceBoost: false });
		expect(
			withBoost.some((s, i) => s.returned.join() !== without[i].returned.join())
		).toBe(true);
	});
});

/**
 * Set from a measured run, then lowered. These are a floor to fall through,
 * not a target to hit: a change that moves a number a little should not turn
 * the suite red, and one that halves recall should.
 */
const FLOOR = {
	search: 0.95,
	traversal: 0.9,
	convergence: 0.9,
	precisionAtK: 0.75
};
