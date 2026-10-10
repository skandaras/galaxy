import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { events, usageLog } from '$lib/server/db/schema';
import { createEntity, ProfileError, wipeProfile } from '$lib/server/profile';

/**
 * The parse call, with the model stubbed: what it returns is only ever a
 * draft, and code keeps only what it can stand behind.
 */

let reply = '{}';
let thrown: Error | null = null;
let blocked = false;
let calls = 0;
let prompts: string[] = [];

vi.mock('./budget', () => ({ getBudgetStatus: () => ({ blocked }) }));

vi.mock('./engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./engine')>();
	return {
		...actual,
		pickModel: () => ({
			model: {
				id: 'm-parse',
				modelKey: 'mock/parse',
				displayName: 'Parse',
				supportsReasoning: false,
				reasoningMode: 'auto',
				promptCostPerMTok: null,
				completionCostPerMTok: null
			},
			provider: {},
			adapter: {
				complete: async (req: { messages: { role: string; content: string }[] }) => {
					calls++;
					prompts.push(req.messages.map((m) => m.content).join('\n'));
					if (thrown) throw thrown;
					return { text: reply, usage: { promptTokens: 10, completionTokens: 5 } };
				}
			}
		})
	};
});

const { parseIntoDraft, PARSE_MAX_CHARS } = await import('./profile-parse');

const ALICE = 'u-parse-alice';
const NOW = new Date('2026-10-10T09:00:00Z');
const TEXT =
	'I live in Grey Lynn with Aroha and our son Nikau. Aroha swims on Mondays. My brother Jo builds boats. ' +
	'I am coeliac. Please keep replies short and use bullet points. quetzalmarker';
const part = (text = TEXT) => [{ label: 'About you', about: 'life', text }];

beforeAll(() => runMigrations());

beforeEach(() => {
	wipeProfile(ALICE);
	db.delete(events).run();
	db.delete(usageLog).run();
	reply = '{}';
	thrown = null;
	blocked = false;
	calls = 0;
	prompts = [];
});

describe('parseIntoDraft', () => {
	it('keeps what the text says, filed where the profile has room for it', async () => {
		createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'partner' });
		reply = JSON.stringify({
			people: [
				{ name: 'Nikau', kind: 'person', relation: 'son' },
				{ name: 'Aroha', kind: 'person', relation: 'partner' },
				{ name: 'Hemi', kind: 'person', relation: 'brother' },
				{ name: 'Jo', kind: 'person', relation: 'brother' }
			],
			entries: [
				{ path: 'life/home', kind: 'fact', claim: 'Lives in Grey Lynn.', quote: 'I live in Grey Lynn' },
				{ path: 'people/Aroha', kind: 'fact', claim: 'Swims on Mondays.', quote: 'Aroha swims on Mondays' },
				{ path: 'life/routines', kind: 'fact', claim: 'Takes Nikau to school.', quote: 'our son nikau', about: 'nikau' },
				{ path: 'life/health', kind: 'constraint', claim: 'Coeliac.', quote: 'I am  coeliac' },
				{ path: 'life/hobbies', kind: 'fact', claim: 'Plays chess.', quote: 'I live in Grey Lynn' },
				{ path: 'work/role', kind: 'fact', claim: 'Is a surgeon.', quote: 'I am a surgeon' },
				{ path: 'people/Hemi', kind: 'fact', claim: 'Is a builder.', quote: 'I live' }
			],
			not_carried: ['Keep replies short and use bullet points.', { text: 'Wants British spelling.' }, 7]
		});
		const draft = await parseIntoDraft(ALICE, part(), NOW);

		// Hemi is named nowhere in the text; Aroha is already in the profile.
		expect(draft.people).toEqual([
			{ name: 'Nikau', kind: 'person', relation: 'son', aka: [] },
			{ name: 'Jo', kind: 'person', relation: 'brother', aka: [] }
		]);
		expect(draft.entries.map((e) => [e.path, e.claim, e.about])).toEqual([
			['life/home', 'Lives in Grey Lynn.', null],
			['people/Aroha', 'Swims on Mondays.', null],
			['life/routines', 'Takes Nikau to school.', 'Nikau'],
			['life/health', 'Coeliac.', null]
		]);
		expect(draft.notCarried).toEqual(['Keep replies short and use bullet points.', 'Wants British spelling.']);
		expect(draft.leftOut).toEqual([
			'Left out 2 lines that were not in what you wrote.',
			'Left out 2 lines filed somewhere your profile does not have.'
		]);
	});

	it('tells the model who is in this person’s profile and nobody else’s', async () => {
		createEntity(ALICE, { kind: 'person', name: 'Quokkalantern', relation: 'partner' });
		await parseIntoDraft('u-parse-bob', part(), NOW);
		await parseIntoDraft(ALICE, part(), NOW);
		expect(prompts[0]).not.toContain('Quokkalantern');
		expect(prompts[1]).toContain('Quokkalantern (person, partner)');
	});

	it('never pins, never decides privacy, and keeps only a date still to come', async () => {
		reply = JSON.stringify({
			entries: [
				{ path: 'life/home', kind: 'nonsense', claim: 'Lives in Grey Lynn.', quote: 'Grey Lynn', pinned: true, sensitivity: 'normal', until: '2026-12-01' },
				{ path: 'life/health', kind: 'constraint', claim: 'Coeliac.', quote: 'coeliac', until: '2020-01-01' }
			]
		});
		const draft = await parseIntoDraft(ALICE, part(), NOW);
		expect(draft.entries.map((e) => [e.kind, e.pinned, e.sensitivity, e.until])).toEqual([
			['fact', false, null, '2026-12-01'],
			['constraint', false, null, null]
		]);
	});

	it('logs what it spent and records counts, never the text', async () => {
		reply = JSON.stringify({ entries: [{ path: 'life/home', claim: 'Has a quetzalmarker.', quote: 'quetzalmarker' }] });
		await parseIntoDraft(ALICE, part(), NOW);
		expect(db.select().from(usageLog).where(eq(usageLog.task, 'profile-parse')).all()).toHaveLength(1);
		const rows = db.select().from(events).all();
		expect(rows.map((r) => r.name)).toEqual(['profile-parse.run']);
		expect(JSON.stringify(rows)).not.toMatch(/quetzal|coeliac|Grey Lynn/i);
	});

	it('refuses before calling when the cap is reached or the text is too long', async () => {
		blocked = true;
		await expect(parseIntoDraft(ALICE, part(), NOW)).rejects.toThrow(/spending cap/);
		blocked = false;
		await expect(parseIntoDraft(ALICE, part('x'.repeat(PARSE_MAX_CHARS + 1)), NOW)).rejects.toThrow(ProfileError);
		expect(calls).toBe(0);
	});

	it('says nothing was saved when the call fails or its answer cannot be read', async () => {
		thrown = Object.assign(new Error('upstream said quetzalmarker'), { name: 'TimeoutError' });
		await expect(parseIntoDraft(ALICE, part(), NOW)).rejects.toThrow(/did not answer within/);
		thrown = null;
		reply = 'not json at all';
		await expect(parseIntoDraft(ALICE, part(), NOW)).rejects.toThrow(/could not be read/);
		const statuses = db.select().from(usageLog).all().map((r) => r.status);
		expect(statuses.sort()).toEqual(['error', 'ok']);
		expect(JSON.stringify(db.select().from(events).all())).not.toContain('quetzal');
	});
});
