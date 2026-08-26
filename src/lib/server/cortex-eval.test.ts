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

function score(): Score[] {
	return EVAL_QUERIES.map((q) => {
		const returned = activate({ userId: USER, query: q.query }).nodes.map((n) => n.node.id);
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
 * Set from a measured run, then lowered. These are a floor to fall through,
 * not a target to hit: a change that moves a number a little should not turn
 * the suite red, and one that halves recall should.
 */
const FLOOR = {
	search: 0.9,
	traversal: 0.6,
	convergence: 0.4,
	precisionAtK: 0.55
};
