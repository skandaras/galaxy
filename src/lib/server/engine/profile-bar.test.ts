import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { events, profileEntries, profileProposals, usageLog } from '$lib/server/db/schema';
import { addEntry, wipeProfile } from '$lib/server/profile';
import { setSetting, type LearningBar } from '$lib/server/settings';

/**
 * The bar check, with the model stubbed. It exists because nobody approves a
 * learned line, so what the job lets through can only be measured against
 * messages whose answer is known. What is under test is the sorting of the
 * model's reply into kept, missed, let through and watched, and that the check
 * costs a call and leaves nothing behind.
 */

let replies: string[] = [];
let blocked = false;
let prompts: string[] = [];

vi.mock('./budget', () => ({ getBudgetStatus: () => ({ blocked }) }));

vi.mock('./engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./engine')>();
	return {
		...actual,
		pickModel: () => ({
			model: {
				id: 'm-bar',
				modelKey: 'mock/bar',
				displayName: 'Barkeeper',
				supportsReasoning: false,
				reasoningMode: 'auto',
				promptCostPerMTok: null,
				completionCostPerMTok: null
			},
			provider: {},
			adapter: {
				complete: async (req: { messages: { content: string }[] }) => {
					prompts.push(req.messages.map((m) => m.content).join('\n'));
					return { text: replies.shift() ?? '{}', usage: { promptTokens: 10, completionTokens: 5 } };
				}
			}
		})
	};
});

const { BAR_CASES, runBarCheck } = await import('./profile-bar');

const ALICE = 'u-bar-alice';

beforeAll(() => runMigrations());

beforeEach(() => {
	for (const t of [events, usageLog, profileProposals]) db.delete(t).run();
	wipeProfile(ALICE);
	db.run("DELETE FROM settings WHERE key = 'profile'");
	replies = [];
	blocked = false;
	prompts = [];
});

/** What the model would return for a case: its own words quoted, labelled as given. */
const line = (label: string, extra: Record<string, unknown> = {}) => {
	const c = BAR_CASES.find((x) => x.label === label)!;
	return {
		path: 'work/tools',
		kind: 'fact',
		claim: `Says: ${c.text.slice(0, 60)}`,
		quote: c.text.slice(0, 40),
		basis: 'stated',
		span: 'lasting',
		why: 'They said so.',
		...extra
	};
};
const worthKeeping = () => BAR_CASES.filter((c) => c.keep).map((c) => line(c.label));
const reply = (add: Record<string, unknown>[]) => replies.push(JSON.stringify({ add }));
const setBar = (bar: LearningBar) => setSetting('profile', { bar });

describe('the bar check', () => {
	it('reports every worth-keeping case kept, and nothing let through, when only those are returned', async () => {
		reply(worthKeeping());
		const out = await runBarCheck(ALICE);
		expect(out).toMatchObject({ ran: true, bar: 'balanced', kept: 10, worth: 10, missed: [], letThrough: [], watched: [] });
	});

	it('reports a trivia line returned as stated and lasting as let through, by its label', async () => {
		reply([...worthKeeping(), line('a technical question'), line('a mood')]);
		const out = await runBarCheck(ALICE);
		expect(out).toMatchObject({ ran: true, kept: 10 });
		expect(out.ran && out.letThrough.sort()).toEqual(['a mood', 'a technical question']);
	});

	it('reports a worth-keeping case the model left out as missed', async () => {
		reply(worthKeeping().filter((l) => !l.claim.includes('vegetarian')));
		const out = await runBarCheck(ALICE);
		expect(out).toMatchObject({ ran: true, kept: 9, worth: 10, missed: ['a diet'] });
	});

	it('reports what the setting only watches, as watched or missed and not as written', async () => {
		setBar('balanced');
		reply([
			...worthKeeping().filter((l) => !l.claim.includes('vegetarian')),
			line('a diet', { basis: 'implied' }),
			line('a curiosity', { basis: 'implied' })
		]);
		const out = await runBarCheck(ALICE);
		expect(out).toMatchObject({ ran: true, kept: 9, missed: ['a diet'], letThrough: [], watched: ['a curiosity'] });
	});

	it('lets implied trivia through when the bar is open, and drops it when strict', async () => {
		const trivia = [line('an errand', { basis: 'implied' })];
		setBar('open');
		reply(trivia);
		expect(await runBarCheck(ALICE)).toMatchObject({ bar: 'open', letThrough: ['an errand'], watched: [] });
		setBar('strict');
		reply(trivia);
		expect(await runBarCheck(ALICE)).toMatchObject({ bar: 'strict', letThrough: [], watched: [] });
	});

	it('does not count a line the person never said, or one marked as a single occasion', async () => {
		reply([
			line('a mood', { quote: 'I have never said this' }),
			line('an errand', { span: 'once' }),
			...worthKeeping()
		]);
		expect(await runBarCheck(ALICE)).toMatchObject({ kept: 10, letThrough: [], watched: [] });
	});

	it('writes nothing to the profile, reads as if it were empty, and logs the usage', async () => {
		addEntry(ALICE, { domain: 'work', subdomain: 'tools', kind: 'fact', claim: 'Types on a zanzibarkeyboard all day.' }, { source: 'stated' });
		reply([...worthKeeping(), line('a mood', { basis: 'implied' })]);
		await runBarCheck(ALICE);
		expect(db.select().from(profileEntries).all()).toHaveLength(1);
		expect(db.select().from(profileProposals).all()).toEqual([]);
		// The held entry was not shown: the same fixture has to read the same for everyone.
		expect(prompts[0]).not.toContain('zanzibarkeyboard');
		const [row] = db.select().from(usageLog).all();
		expect(row).toMatchObject({ task: 'profile-probe', status: 'ok', userId: ALICE, modelKey: 'mock/bar' });
		expect(db.select().from(events).all().map((e) => e.name)).toContain('profile-bar.run');
	});

	it('refuses when the budget is blocked, without a call or a usage row', async () => {
		blocked = true;
		const out = await runBarCheck(ALICE);
		expect(out).toMatchObject({ ran: false, reason: expect.stringMatching(/spending cap/) });
		expect(prompts).toEqual([]);
		expect(db.select().from(usageLog).all()).toEqual([]);
	});
});
