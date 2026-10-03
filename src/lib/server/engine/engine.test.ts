import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { CORE_TASKS, taskConfigs } from '$lib/server/db/schema';
import { migrateStyleToLanguage, seedTaskConfigs } from '$lib/server/bootstrap';
import { DEFAULT_PROMPTS } from './prompts';
import {
	DEFAULT_LANGUAGE,
	deleteSetting,
	getSetting,
	LANGUAGE_MAX_CHARS,
	normaliseLanguageSettings,
	setSetting
} from '$lib/server/settings';
import { languageBlock, LAYOUT_TASKS, PROSE_TASKS, systemPromptFor } from './engine';

/**
 * Which agents the Language text governs, and which it deliberately does not.
 *
 * The set is the whole point of the feature, so it is asserted rather than
 * described: a task added to CORE_TASKS without a decision about its voice shows
 * up here as a task with no row, instead of inheriting whichever behaviour the
 * last edit happened to leave.
 */

const LABEL = '[How to write';
const { voice: VOICE, layout: LAYOUT } = DEFAULT_LANGUAGE;

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(taskConfigs).run();
	seedTaskConfigs();
	deleteSetting('language');
	deleteSetting('style');
});

describe('the Language block', () => {
	it('is framed as rules, and starts from the shipped text on a fresh install', () => {
		const out = languageBlock('chat');
		expect(out).toContain(LABEL);
		expect(out).toContain('These are rules');
		expect(out).toContain(VOICE);
	});

	it('opens on a blank line, because a single newline collapses', () => {
		expect(languageBlock('chat').startsWith('\n\n')).toBe(true);
	});

	it('is one block with one wording, whatever the owner has written', () => {
		setSetting('language', { voice: 'British spelling throughout.', layout: LAYOUT });
		const out = systemPromptFor('chat');
		expect(out.match(/\[How to write/g)).toHaveLength(1);
		expect(out).toContain('British spelling throughout.');
		expect(out).not.toContain(VOICE);
	});

	it('adds nothing for a field the owner cleared, and no label when both are clear', () => {
		setSetting('language', { voice: '', layout: LAYOUT });
		expect(languageBlock('ux-audit')).toBe('');
		expect(languageBlock('chat')).toContain(LAYOUT);
		setSetting('language', { voice: '', layout: '' });
		expect(languageBlock('chat')).toBe('');
	});

	it('ships a voice with no layout rules, which is what makes it safe for the JSON tasks', () => {
		// ux-audit and skill-optimiser answer with an object. The moment a
		// paragraphs-and-bullets rule appears here, both have to leave PROSE_TASKS.
		expect(VOICE).not.toContain('bulleted list');
		expect(VOICE).not.toContain('blank line');
		expect(VOICE).not.toContain('heading');
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
		expect(systemPromptFor('chat-title')).toContain('You name conversations');
	});

	it('appends the board prompt to chat without composing the block twice', () => {
		const out = systemPromptFor('chat', 'board');
		expect(out).toContain('task boards in Galaxy');
		expect(out).toContain('chat agent of Galaxy');
		expect(out.match(/\[How to write/g)).toHaveLength(1);
	});

	it('ignores a supplement that has no stored prompt', () => {
		expect(systemPromptFor('chat', 'not-a-task')).toContain('chat agent of Galaxy');
	});
});

describe('which tasks also get the layout', () => {
	it.each([...LAYOUT_TASKS])('shapes %s', (task) => {
		expect(systemPromptFor(task)).toContain(LAYOUT);
	});

	it.each([...PROSE_TASKS].filter((t) => !LAYOUT_TASKS.has(t)))(
		'leaves the shape of %s alone',
		(task) => {
			// These answer with a JSON object, or in a few sentences to another
			// agent. A paragraphs-and-bullets rule would fight the reply contract.
			expect(systemPromptFor(task)).not.toContain(LAYOUT);
		}
	);

	it('is a subset of the tasks the voice reaches', () => {
		for (const task of LAYOUT_TASKS) expect(PROSE_TASKS.has(task)).toBe(true);
	});

	it('puts the shape after the voice', () => {
		const out = languageBlock('chat');
		expect(out.indexOf(LAYOUT)).toBeGreaterThan(out.indexOf(VOICE));
	});

	it('is composed at call time, so no shipped task prompt carries any of it', () => {
		for (const [task, text] of Object.entries(DEFAULT_PROMPTS)) {
			expect(text, `${task} has the layout baked in`).not.toContain(LAYOUT);
			expect(text, `${task} has a voice rule baked in`).not.toContain('em dash');
		}
	});
});

describe('the stored text', () => {
	it('is capped on the way in and on the way out', () => {
		expect(normaliseLanguageSettings({ voice: 'x'.repeat(LANGUAGE_MAX_CHARS + 50) }).voice).toHaveLength(
			LANGUAGE_MAX_CHARS
		);
		setSetting('language', { voice: 'y'.repeat(LANGUAGE_MAX_CHARS + 50), layout: '' });
		expect(languageBlock('chat')).toContain('y'.repeat(LANGUAGE_MAX_CHARS));
		expect(languageBlock('chat')).not.toContain('y'.repeat(LANGUAGE_MAX_CHARS + 1));
	});

	it('keeps nothing but its two fields', () => {
		// The GET route attaches the defaults read-only for the reset buttons. Were
		// that to survive a save, the shipped text would be frozen into the row.
		const out: Record<string, unknown> = {
			...normaliseLanguageSettings({ voice: 'mine', layout: 'shape', defaults: { voice: 'x' } })
		};
		expect(out).toEqual({ voice: 'mine', layout: 'shape' });
	});
});

describe('moving off the old house style', () => {
	it("appends the owner's additions to the list that used to be built in, and drops the old row", () => {
		setSetting('style', { text: 'British spelling throughout.' });
		migrateStyleToLanguage();
		const moved = getSetting<{ voice: string; layout: string }>('language', DEFAULT_LANGUAGE);
		expect(moved.voice.startsWith(VOICE)).toBe(true);
		expect(moved.voice.endsWith('British spelling throughout.')).toBe(true);
		expect(moved.layout).toBe(LAYOUT);
		expect(getSetting('style', null)).toBeNull();
	});

	it('leaves a Language text already saved alone', () => {
		setSetting('language', { voice: 'Mine.', layout: '' });
		setSetting('style', { text: 'Old addition.' });
		migrateStyleToLanguage();
		expect(getSetting<{ voice: string }>('language', DEFAULT_LANGUAGE).voice).toBe('Mine.');
		expect(getSetting('style', null)).toBeNull();
	});

	it('writes nothing for an install that never had the old row', () => {
		migrateStyleToLanguage();
		expect(getSetting('language', null)).toBeNull();
	});
});
