import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { alignmentPrinciples, events } from '$lib/server/db/schema';
import { savePrinciple } from '$lib/server/alignment';
import { appendMessage, createChat } from '$lib/server/chats';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { StreamEvent } from '$lib/server/providers/types';
import { createJob } from '$lib/server/engine/jobs';
import { runAgentLoop } from '$lib/server/engine/loop';
import { bootstrapContext, knowledgeTools } from '$lib/server/engine/tools/knowledge';
import {
	addEntry,
	confirmDraft,
	createEntity,
	listEntries,
	lookup,
	profileBlock,
	PROFILE_SCOPES,
	wipeProfile,
	type Domain
} from './profile';

/**
 * Who sees what of a profile.
 *
 * Every boundary here holds because of a predicate in a query, and a predicate
 * is the easiest thing to drop when a read is rewritten. These fail on the
 * pull request that drops one, rather than in someone's prompt.
 *
 * Distinctive words, so a substring check means something.
 */

const ALICE = 'user-alice';
const BOB = 'user-bob';
const NOW = new Date('2026-10-10T09:00:00Z');

const TOOL = 'zanzibarkeyboard';
const PARTNER = 'quokkalantern';
const PARTNER_FACT = 'narwhalshift';
const ROUTINE = 'pelicanmonday';
const HEALTH = 'axolotlallergy';
const IDENTITY = 'marmosetvillage';
const BOB_SECRET = 'wombatsecret';
const PRINCIPLE = 'zebracrossing-principle-marker';

const ALICE_MARKERS = [PARTNER, PARTNER_FACT, ROUTINE, HEALTH, IDENTITY];

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	wipeProfile(ALICE);
	wipeProfile(BOB);
	db.delete(alignmentPrinciples).run();

	const put = (user: string, domain: Domain, subdomain: string, claim: string, pinned = false) =>
		addEntry(user, { domain, subdomain, kind: 'fact', claim, pinned }, { source: 'stated', now: NOW });

	put(ALICE, 'work', 'tools', `Types on a ${TOOL} all day.`, true);
	const partner = createEntity(ALICE, { kind: 'person', name: PARTNER, relation: 'partner' }, NOW);
	put(ALICE, 'people', partner.id, `Works the ${PARTNER_FACT} at the hospital.`, true);
	addEntry(
		ALICE,
		{ domain: 'life', subdomain: 'routines', kind: 'fact', about: partner.id, claim: `Has a ${ROUTINE} swim with them.`, pinned: true },
		{ source: 'stated', now: NOW }
	);
	put(ALICE, 'life', 'health', `Has an ${HEALTH} to shellfish.`);
	put(ALICE, 'identity', 'background', `Grew up in ${IDENTITY} by the sea.`, true);

	put(BOB, 'work', 'tools', `Keeps a ${BOB_SECRET} in the drawer.`, true);
	createEntity(BOB, { kind: 'person', name: 'Bobpartner', relation: 'partner' }, NOW);

	savePrinciple(ALICE, {
		title: PRINCIPLE,
		statement: 'a marked statement',
		exemplar: 'a marked exemplar',
		counterExemplar: 'a marked counter-exemplar'
	});
});

/** Everything a task could get out of a profile by asking every way it can. */
function everything(user: string, task: string): string {
	const asks = [
		...[TOOL, PARTNER, PARTNER_FACT, ROUTINE, HEALTH, IDENTITY, BOB_SECRET, PRINCIPLE, 'swim shellfish hospital'].map(
			(query) => ({ query })
		),
		...['identity', 'work', 'people', 'life', 'interests', 'now', 'life/health', 'life/routines', `people/${PARTNER}`, 'work/tools'].map(
			(path) => ({ path })
		),
		{ about: PARTNER },
		{ about: 'Bobpartner' }
	];
	return [profileBlock(user, task, NOW), ...asks.map((a) => lookup(user, task, a, NOW).text)].join('\n');
}

describe('one person’s profile', () => {
	it('never reaches another person', () => {
		const bob = everything(BOB, 'chat');
		for (const marker of [...ALICE_MARKERS, TOOL]) expect(bob).not.toContain(marker);
		const alice = everything(ALICE, 'chat');
		expect(alice).not.toContain(BOB_SECRET);
		expect(alice).not.toContain('Bobpartner');
	});

	it('is not even counted in another person’s search', () => {
		// "3 more not shown" for a word only Alice's profile holds would tell Bob
		// it exists, even with none of it shown.
		expect(lookup(BOB, 'chat', { query: `${TOOL} ${PARTNER_FACT} ${ROUTINE}` }, NOW)).toMatchObject({
			lines: [],
			omitted: 0
		});
	});
});

describe('the coding agent', () => {
	it('sees the tools a person works with and nothing of their life', () => {
		const seen = everything(ALICE, 'coding');
		expect(seen).toContain(TOOL);
		for (const marker of ALICE_MARKERS) expect(seen).not.toContain(marker);
	});
});

describe('deep research', () => {
	it('sees nothing about people, a life or a person’s identity', () => {
		const seen = everything(ALICE, 'deep-research');
		for (const marker of ALICE_MARKERS) expect(seen).not.toContain(marker);
	});
});

describe('a private entry', () => {
	it('is never in a block, only in a chat agent’s lookup', () => {
		for (const task of Object.keys(PROFILE_SCOPES)) {
			expect(profileBlock(ALICE, task, NOW)).not.toContain(HEALTH);
		}
		expect(lookup(ALICE, 'chat', { query: HEALTH }, NOW).text).toContain(HEALTH);
		expect(lookup(ALICE, 'coding', { query: HEALTH }, NOW).text).not.toContain(HEALTH);
	});
});

describe('a task with no scope', () => {
	it('gets nothing at all', () => {
		for (const task of ['visual', 'memory', 'subagent', 'board', 'ivory-read', 'ux-audit']) {
			const seen = everything(ALICE, task);
			for (const marker of [...ALICE_MARKERS, TOOL]) expect(seen).not.toContain(marker);
		}
	});
});

describe('Alignment', () => {
	it('never reaches a profile block or lookup', () => {
		for (const task of Object.keys(PROFILE_SCOPES)) {
			expect(everything(ALICE, task)).not.toContain(PRINCIPLE);
		}
	});
});

describe('the Observatory', () => {
	it('records that the profile tools ran without recording what they were given', async () => {
		// Admins read the Observatory. The loop writes an event for every tool
		// call, with its summary, its error and, for arguments it cannot parse, a
		// snippet of them: for these tools that would be a person's own words.
		const CLAIM = 'ocelotclaim';
		const QUOTE = 'ocelotquote';
		const chat = createChat({ userId: ALICE });
		appendMessage(chat.id, { role: 'user', content: `I want to say ${QUOTE} plainly.` });
		db.delete(events).run();

		const calls = [
			{ name: 'profile_note', arguments: JSON.stringify({ path: 'interests/pursuits', kind: 'fact', claim: `Has an ${CLAIM} habit.`, quote: QUOTE }) },
			{ name: 'profile_note', arguments: `{"claim": "Has an ${CLAIM} habit", "quote": "${QUOTE}` },
			{ name: 'profile_note', arguments: JSON.stringify({ path: `people/${PARTNER}`, kind: 'fact', claim: `Not said ${CLAIM}.`, quote: 'never written by them' }) },
			{ name: 'profile_lookup', arguments: JSON.stringify({ query: `${CLAIM} ${HEALTH}` }) },
			{ name: 'profile_lookup', arguments: JSON.stringify({ about: PARTNER }) }
		].map((c, i) => ({ id: `c${i}`, ...c }));
		let round = 0;
		const choice = {
			model: {
				modelKey: 'mock',
				displayName: 'Mock',
				supportsTools: true,
				supportsVision: false,
				supportsReasoning: false,
				reasoningMode: 'auto',
				promptCostPerMTok: null,
				completionCostPerMTok: null
			},
			provider: {},
			adapter: {
				async *stream(): AsyncGenerator<StreamEvent> {
					if (round++ === 0) {
						yield { type: 'tool_calls', calls };
						yield { type: 'done', finishReason: 'tool_calls' };
						return;
					}
					yield { type: 'text', delta: 'Done.' };
					yield { type: 'done', finishReason: 'stop' };
				},
				complete: async () => ({ text: '', usage: null }),
				listModels: async () => []
			}
		} as unknown as ModelChoice;
		const job = createJob({ chatId: chat.id, userId: ALICE, task: 'chat', persist: true });
		await runAgentLoop({
			job,
			task: 'chat',
			userId: ALICE,
			chatId: chat.id,
			persist: true,
			primary: choice,
			backup: null,
			tools: knowledgeTools(ALICE, { task: 'chat', chatId: chat.id }),
			maxIterations: 4,
			buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
			onDone: () => {}
		});

		// The note went in, so the calls really ran.
		expect(listEntries(ALICE).some((e) => e.claim.includes(CLAIM))).toBe(true);
		const rows = db.select().from(events).all();
		const toolEvents = rows.filter((r) => r.type === 'tool.call');
		expect(toolEvents).toHaveLength(calls.length);
		const stored = JSON.stringify(rows);
		for (const marker of [CLAIM, QUOTE, PARTNER, HEALTH]) expect(stored).not.toContain(marker);
	});
});

describe('a draft', () => {
	it('names people only from the profile of the person saving it', () => {
		// A draft carries names, not ids. Resolved against anyone's profile but
		// the saver's, it would file a line on someone else's card.
		const line = { kind: 'fact' as const, pinned: false, until: null, sensitivity: null };
		const result = confirmDraft(
			BOB,
			{
				people: [],
				entries: [
					{ ...line, path: `people/${PARTNER}`, claim: 'Was told about by Bob.', about: null },
					{ ...line, path: 'life/routines', claim: 'Swims with them on Fridays.', about: PARTNER }
				],
				notCarried: [],
				leftOut: []
			},
			'imported',
			NOW
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.refusals).toHaveLength(2);
		expect(everything(ALICE, 'chat')).not.toContain('Bob');
	});
});

describe('the bootstrap', () => {
	it('opens with the profile for a task that has one, and carries none for a task that does not', () => {
		const chat = bootstrapContext(ALICE, 'chat');
		expect(chat.trimStart().startsWith('[Profile:')).toBe(true);
		expect(chat).toContain(PARTNER);
		expect(bootstrapContext(ALICE, 'coding')).not.toContain(PARTNER);
		for (const task of [undefined, 'visual', 'subagent']) {
			expect(bootstrapContext(ALICE, task)).not.toContain('[Profile:');
		}
	});
});
