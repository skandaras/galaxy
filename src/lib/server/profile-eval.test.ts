import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import { createEntity, listEntries, lookup, profileBlock, setPinned, wipeProfile } from './profile';
import { EVAL_QUERIES, FIXTURE_NOW, seedFixtureProfile, type EvalQuery } from './profile-fixture';

/**
 * Does a lookup find what an agent asked for, and nothing when there is nothing?
 *
 * The constants behind search (any-match, stopwords, stemming, the bm25 column
 * weights) are guesses until something can tell better from worse. The floors
 * sit a little under what is measured today, so an improvement has room to
 * move and a regression trips. They say nothing about real profiles: the
 * fixture is fiction.
 */

const USER = 'user-eval';
let ids = new Map<string, string>();

beforeAll(() => {
	runMigrations();
	wipeProfile(USER);
	ids = seedFixtureProfile(USER);
});

interface Score {
	query: EvalQuery;
	returned: string[];
	recall: number;
	/** Precision over as many results as were expected: is the top the part asked for? */
	precisionAtK: number;
}

function score(): Score[] {
	return EVAL_QUERIES.map((q) => {
		const returned = lookup(USER, 'chat', { query: q.query }, FIXTURE_NOW).lines.map(
			(l) => l.slice(1, 9)
		);
		if (!q.expect.length) {
			const clean = returned.length ? 0 : 1;
			return { query: q, returned, recall: clean, precisionAtK: clean };
		}
		const expected = new Set(
			q.expect.map((c) => {
				const id = ids.get(c);
				if (!id) throw new Error(`Not in the fixture: ${c}`);
				return id;
			})
		);
		const hit = returned.filter((id) => expected.has(id)).length;
		const topK = returned.slice(0, expected.size);
		return {
			query: q,
			returned,
			recall: hit / expected.size,
			precisionAtK: topK.filter((id) => expected.has(id)).length / expected.size
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

const byKind = (scores: Score[], kind: EvalQuery['kind']) =>
	summarise(scores.filter((s) => s.query.kind === kind));

/** Printed on every run, because a guard nobody can read is useless. */
function report(scores: Score[]): string {
	const rule = '  ' + '─'.repeat(66);
	const lines = ['', '  profile lookup eval', rule, '  kind     recall   p@k   returned  query', rule];
	for (const s of scores) {
		lines.push(
			`  ${s.query.kind.padEnd(7)}  ${s.recall.toFixed(2)}     ${s.precisionAtK.toFixed(2)}  ` +
				`${String(s.returned.length).padStart(4)}      ${s.query.query}`
		);
	}
	lines.push(rule);
	for (const kind of ['direct', 'buried', 'absent'] as const) {
		const m = byKind(scores, kind);
		lines.push(`  ${kind.padEnd(7)}  ${m.recall.toFixed(2)}     ${m.precisionAtK.toFixed(2)}`);
	}
	const all = summarise(scores);
	lines.push(`  ${'OVERALL'.padEnd(7)}  ${all.recall.toFixed(2)}     ${all.precisionAtK.toFixed(2)}`, '');
	return lines.join('\n');
}

/**
 * Measured at 1.00 / 1.00 for direct and buried and 0.67 for absent when set.
 *
 * Absent is the low one by choice. Prefix matching is what lets "Postgres" find
 * "PostgreSQL", and it is also why "electric" finds the brother who is an
 * electrician. A missed fact makes a wrong answer; a stray line costs a few
 * tokens the block already tells the agent to ignore unless it changes the
 * answer.
 */
const FLOOR = {
	direct: { recall: 0.9, precisionAtK: 0.9 },
	buried: { recall: 0.9, precisionAtK: 0.85 },
	absent: 0.5
};

describe('the fixture', () => {
	it('is a full-size profile', () => {
		expect(listEntries(USER, FIXTURE_NOW)).toHaveLength(400);
		expect(EVAL_QUERIES.length).toBeGreaterThanOrEqual(30);
	});

	it('gives a chat agent a block that stays small at 400 entries', () => {
		const block = profileBlock(USER, 'chat', FIXTURE_NOW);
		console.log(`\n  chat block at 400 entries: ${block.length} chars\n${block}\n`);
		expect(block.length).toBeLessThanOrEqual(3_200);
	});
});

describe('lookup quality', () => {
	it('scores the fixture and prints the table', () => {
		const scores = score();
		console.log(report(scores));
		expect(scores).toHaveLength(EVAL_QUERIES.length);
	});

	it('finds what the words name', () => {
		const m = byKind(score(), 'direct');
		expect(m.recall).toBeGreaterThanOrEqual(FLOOR.direct.recall);
		expect(m.precisionAtK).toBeGreaterThanOrEqual(FLOOR.direct.precisionAtK);
	});

	it('finds one fact among four hundred', () => {
		const m = byKind(score(), 'buried');
		expect(m.recall).toBeGreaterThanOrEqual(FLOOR.buried.recall);
		expect(m.precisionAtK).toBeGreaterThanOrEqual(FLOOR.buried.precisionAtK);
	});

	it('answers nothing when there is nothing to answer', () => {
		expect(byKind(score(), 'absent').recall).toBeGreaterThanOrEqual(FLOOR.absent);
	});
});

describe('the block at its worst', () => {
	it('stays inside its parts’ budgets with the brief and the names line full', () => {
		// Last in the file, because it changes the fixture. The fixture pins six
		// things; the ceiling is what every budget allows at once: a full brief,
		// twelve names, every subdomain on the map.
		for (const e of listEntries(USER, FIXTURE_NOW)) {
			if (e.sensitivity === 'private' || e.pinned) continue;
			try {
				setPinned(USER, e.id, true, FIXTURE_NOW);
			} catch {
				break;
			}
		}
		for (let i = 0; i < 5; i++) {
			createEntity(USER, { kind: 'person', name: `Cousin number ${i}`, relation: 'cousin' }, FIXTURE_NOW);
		}
		const block = profileBlock(USER, 'chat', FIXTURE_NOW);
		console.log(`\n  chat block with every budget full: ${block.length} chars\n`);
		expect(block.length).toBeLessThanOrEqual(4_000);
	});
});
