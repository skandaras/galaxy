import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { CORE_TASKS, taskConfigs } from '$lib/server/db/schema';
import { seedTaskConfigs } from '$lib/server/bootstrap';
import { DEFAULT_PROMPTS } from './prompts';
import { deleteSetting, normaliseStyleSettings, setSetting } from '$lib/server/settings';
import { systemPromptFor } from './engine';
import { HOUSE_VOICE, houseStyle, LAYOUT_TASKS, OUTPUT_FORMAT, PROSE_TASKS } from './voice';

/**
 * Which agents the house style governs, and which it deliberately does not.
 *
 * The set is the whole point of the feature, so it is asserted rather than
 * described: a task added to CORE_TASKS without a decision about its voice shows
 * up here as a task the table has no row for, instead of quietly inheriting
 * whichever behaviour the last edit happened to leave.
 */

const LABEL = '[House style';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(taskConfigs).run();
	seedTaskConfigs();
	deleteSetting('style');
});

describe('the house style block', () => {
	it('is framed as rules rather than as background', () => {
		const out = houseStyle('chat');
		expect(out).toContain(LABEL);
		expect(out).toContain('These are rules');
		expect(out).toContain(HOUSE_VOICE);
	});

	it('opens on a blank line, because a single newline collapses', () => {
		// The reason OUTPUT_FORMAT exists in the first place. This is concatenated
		// onto the end of a prompt that does not know it is coming.
		expect(houseStyle('chat').startsWith('\n\n')).toBe(true);
	});

	it('adds no second label when the owner has written nothing', () => {
		expect(houseStyle('chat').match(/\[House style/g)).toHaveLength(1);
		expect(houseStyle('chat')).not.toContain('Added by the owner');
	});

	it("puts the owner's additions last and tells the model they win", () => {
		setSetting('style', { text: 'British spelling throughout.' });
		const out = houseStyle('chat');
		expect(out).toContain('British spelling throughout.');
		expect(out.indexOf('British spelling')).toBeGreaterThan(out.indexOf(HOUSE_VOICE));
		expect(out).toContain('follow this');
	});

	it('carries no layout rules, which is what makes it safe for the JSON tasks', () => {
		// ux-audit and skill-optimiser answer with an object. The moment a
		// paragraphs-and-bullets rule appears here, both have to leave PROSE_TASKS.
		expect(HOUSE_VOICE).not.toContain('bulleted list');
		expect(HOUSE_VOICE).not.toContain('blank line');
		expect(HOUSE_VOICE).not.toContain('heading');
		expect(HOUSE_VOICE).not.toContain(OUTPUT_FORMAT);
	});
});

describe('which tasks it reaches', () => {
	it.each([...PROSE_TASKS])('governs %s', (task) => {
		expect(systemPromptFor(task)).toContain(LABEL);
	});

	it.each(CORE_TASKS.filter((t) => !PROSE_TASKS.has(t)))('leaves %s alone', (task) => {
		expect(systemPromptFor(task)).not.toContain(LABEL);
	});

	it('still returns the stored prompt for a task it does not govern', () => {
		// The block is additive. A task outside the set must be unchanged, not empty.
		expect(systemPromptFor('chat-title')).toContain('You name conversations');
	});

	it('appends the board prompt to chat without composing the style twice', () => {
		// How a board hand-off gets the board register: chat is in the set, board is
		// deliberately not, so the supplement cannot bring a second copy with it.
		const out = systemPromptFor('chat', 'board');
		expect(out).toContain('task boards in Galaxy');
		expect(out).toContain('chat agent of Galaxy');
		expect(out.match(/\[House style/g)).toHaveLength(1);
	});

	it('ignores a supplement that has no stored prompt', () => {
		expect(systemPromptFor('chat', 'not-a-task')).toContain('chat agent of Galaxy');
	});
});

describe('which tasks also get the layout rules', () => {
	it.each([...LAYOUT_TASKS])('shapes %s', (task) => {
		expect(systemPromptFor(task)).toContain(OUTPUT_FORMAT);
	});

	it.each([...PROSE_TASKS].filter((t) => !LAYOUT_TASKS.has(t)))(
		'leaves the shape of %s alone',
		(task) => {
			// These answer with a JSON object, or in a few sentences to another
			// agent. A paragraphs-and-bullets rule would fight the reply contract.
			expect(systemPromptFor(task)).not.toContain(OUTPUT_FORMAT);
		}
	);

	it('is a subset of the tasks the voice reaches', () => {
		// Layout without diction would be a task shaped but not governed, which no
		// call site asks for: systemPromptFor only composes anything for PROSE_TASKS.
		for (const task of LAYOUT_TASKS) expect(PROSE_TASKS.has(task)).toBe(true);
	});

	it('puts the shape after the voice and before the owner', () => {
		setSetting('style', { text: 'British spelling throughout.' });
		const out = houseStyle('chat');
		expect(out.indexOf(OUTPUT_FORMAT)).toBeGreaterThan(out.indexOf(HOUSE_VOICE));
		expect(out.indexOf('British spelling')).toBeGreaterThan(out.indexOf(OUTPUT_FORMAT));
	});

	it('is composed at call time, so no stored prompt carries it', () => {
		// The failure this set exists to fix: OUTPUT_FORMAT was inlined into the
		// seeded chat and coding prompts, so it froze in the database at install
		// time and needed a verbatim snapshot before it could ever be reworded.
		for (const [task, text] of Object.entries(DEFAULT_PROMPTS)) {
			expect(text, `${task} has the layout block baked in`).not.toContain(OUTPUT_FORMAT);
		}
	});
});

describe('the owner override', () => {
	it('caps what one turn can carry', () => {
		const out = normaliseStyleSettings({ text: 'x'.repeat(1_400) });
		expect(out.text).toHaveLength(1_000);
	});

	it('keeps nothing but the text', () => {
		// The GET route attaches the house style read-only so the editor can show
		// it. Were that field to survive a save, the constant would be frozen into
		// the database and stop tracking the code.
		const out: Record<string, unknown> = {
			...normaliseStyleSettings({ text: 'mine', house: 'injected' })
		};
		expect(out.house).toBeUndefined();
		expect(out.text).toBe('mine');
	});

	it('survives a value written before the key existed', () => {
		expect(normaliseStyleSettings({}).text).toBe('');
	});

	it('caps on the way out as well as in', () => {
		// The route is the only writer today. A value that arrived some other way
		// would otherwise be paid for on every prose turn with nothing to stop it.
		setSetting('style', { text: 'y'.repeat(1_400) });
		expect(houseStyle('chat')).toContain('y'.repeat(1_000));
		expect(houseStyle('chat')).not.toContain('y'.repeat(1_001));
	});
});
