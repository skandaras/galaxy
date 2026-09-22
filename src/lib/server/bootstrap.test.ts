import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { taskConfigs, CORE_TASKS } from '$lib/server/db/schema';
import { migrateSettings, migrateToPromptOverrides, seedTaskConfigs } from './bootstrap';
import { DEFAULT_PROMPTS } from './engine/prompts';
import { OUTPUT_FORMAT } from './engine/voice';
import { taskPrompt } from './engine/engine';
import {
	deleteSetting,
	getSetting,
	setSetting,
	type ResearchSettings,
	type WebSearchSettings
} from './settings';

/**
 * That a shipped prompt reaches an install that already exists, and that it
 * never treads on one somebody has made their own.
 *
 * Defaults used to be seeded into `system_prompt` at first boot, so changing one
 * reached only installs that had never booted, which is none of them. They
 * resolve from DEFAULT_PROMPTS now, and the column holds only what an owner
 * wrote. These cover the one-shot that moves an existing install across.
 */

/** What a turn would actually run on. */
const prompt = (task: string) => taskPrompt(task);

/** What the rollback column holds, which is not what a turn reads. */
const stored = (task: string) =>
	db.select().from(taskConfigs).where(eq(taskConfigs.task, task)).get()?.systemPrompt ?? '';

const override = (task: string) =>
	db.select().from(taskConfigs).where(eq(taskConfigs.task, task)).get()?.promptOverride ?? null;

const OLD_MEMORY =
	'You are the memory agent of Galaxy. Audit recent activity for durable patterns, preferences and candidate skills. Extract only what is clearly supported.';

const OVERRIDE_KEY = 'tasks.promptOverrideVersion';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(taskConfigs).run();
	deleteSetting(OVERRIDE_KEY);
	seedTaskConfigs();
});

describe('resolving a task prompt', () => {
	it('uses the shipped default when nobody has overridden it', () => {
		expect(override('memory')).toBeNull();
		expect(prompt('memory')).toBe(DEFAULT_PROMPTS.memory);
	});

	it('uses the override when there is one', () => {
		const mine = 'You are the memory agent. Only ever record things about cheese.';
		db.update(taskConfigs)
			.set({ promptOverride: mine })
			.where(eq(taskConfigs.task, 'memory'))
			.run();
		expect(prompt('memory')).toBe(mine);
	});

	it('tracks a reworded default without any migration at all', () => {
		// The whole point of the column. An unedited install reads the constant,
		// so changing the constant is the entire delivery mechanism: no snapshot
		// of the old text, no matching, nothing to keep in step.
		expect(prompt('chat')).toBe(DEFAULT_PROMPTS.chat);
		expect(prompt('chat')).not.toContain('one query at a time');
		expect(prompt('chat')).toContain('fetch_url');
	});

	it('ships no default with the house style baked in', () => {
		// The style block is composed at call time by systemPromptFor. A default
		// that also contained it would hand the model two copies.
		for (const [task, text] of Object.entries(DEFAULT_PROMPTS)) {
			expect(text, `${task} embeds the injected style block`).not.toContain('[House style');
			expect(text, `${task} embeds the layout block`).not.toContain(OUTPUT_FORMAT);
		}
	});
});

describe('moving an install onto overrides', () => {
	it('keeps a prompt somebody edited', () => {
		const mine = 'You are the memory agent. Only ever record things about cheese.';
		db.update(taskConfigs)
			.set({ systemPrompt: mine, promptOverride: null })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		migrateToPromptOverrides();
		expect(override('memory')).toBe(mine);
		expect(prompt('memory')).toBe(mine);
	});

	it('claims nothing for a row still holding the current default', () => {
		migrateToPromptOverrides();
		expect(override('memory')).toBeNull();
		expect(prompt('memory')).toBe(DEFAULT_PROMPTS.memory);
	});

	it('claims nothing for a row holding a default an older release shipped', () => {
		// The case the old SUPERSEDED_PROMPTS table existed for, and the only
		// reason this function carries a frozen list at all. Getting it wrong
		// would pin every long-running install to a prompt from two rewrites ago,
		// looking exactly like an owner's edit.
		db.update(taskConfigs)
			.set({ systemPrompt: OLD_MEMORY, promptOverride: null })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		migrateToPromptOverrides();
		expect(override('memory')).toBeNull();
		expect(prompt('memory')).toBe(DEFAULT_PROMPTS.memory);
		expect(prompt('memory')).toContain('six months');
	});

	it('runs on one boot and never again', () => {
		migrateToPromptOverrides();
		const mine = 'Written after the migration had already run.';
		db.update(taskConfigs)
			.set({ systemPrompt: mine, promptOverride: null })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		migrateToPromptOverrides();
		expect(override('memory')).toBeNull();
	});

	it('survives a table with nothing in it', () => {
		db.delete(taskConfigs).run();
		expect(() => migrateToPromptOverrides()).not.toThrow();
	});
});

describe('the rollback copy', () => {
	it('is never empty for any task', () => {
		// The rollback hazard in one assertion. The previous image reads this
		// column and has no default to fall back on, so a task left holding ''
		// is an agent booting with no system prompt at all.
		for (const task of CORE_TASKS) {
			expect(stored(task).length, `${task} would roll back onto an empty prompt`).toBeGreaterThan(
				0
			);
		}
	});

	it('is rewritten on every boot, so the previous image reads real text', () => {
		// AGENTS.md: this app can be rolled back to the previous image, and that
		// image reads `system_prompt` directly. A task left holding text this
		// release stopped shipping is an agent running on a prompt nobody chose.
		db.update(taskConfigs)
			.set({ systemPrompt: 'stale' })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		seedTaskConfigs();
		expect(stored('memory')).toBe(DEFAULT_PROMPTS.memory);
	});

	it('follows the override rather than the default', () => {
		const mine = 'Only ever record things about cheese.';
		db.update(taskConfigs)
			.set({ promptOverride: mine })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		seedTaskConfigs();
		expect(stored('memory')).toBe(mine);
	});

	it('never clears an override', () => {
		const mine = 'Only ever record things about cheese.';
		db.update(taskConfigs)
			.set({ promptOverride: mine })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		seedTaskConfigs();
		seedTaskConfigs();
		expect(override('memory')).toBe(mine);
	});
});

/**
 * The boot path itself, rather than the pure functions under it.
 *
 * `migrateSettings` is what actually runs on startup, and it is the half that
 * can be wrong without any of the migration tests noticing: reading the wrong
 * key, or writing the result back somewhere nothing reads it from, leaves every
 * unit test passing and every install unchanged.
 */
describe('migrating stored settings on boot', () => {
	beforeEach(() => {
		deleteSetting('websearch');
		deleteSetting('research');
	});

	it('moves an install still holding the old defaults, and reads back what it wrote', () => {
		setSetting('websearch', { provider: 'brave', maxResults: 5, maxSearchesPerTurn: 4 });
		setSetting('research', { maxQueries: 4, maxRounds: 4, maxSearchesPerRun: 16, maxPages: 6 });

		migrateSettings();

		expect(getSetting<WebSearchSettings>('websearch', {} as WebSearchSettings)).toMatchObject({
			provider: 'brave',
			maxResults: 20,
			maxSearchesPerTurn: 6,
			searchesPerStep: 1
		});
		expect(getSetting<ResearchSettings>('research', {} as ResearchSettings)).toMatchObject({
			maxQueries: 2,
			maxRounds: 6,
			maxSearchesPerRun: 20,
			maxPages: 10,
			modelTriage: true
		});
	});

	it('is a no-op on the second boot', () => {
		setSetting('websearch', { provider: 'brave', maxResults: 5 });
		setSetting('research', { maxQueries: 4 });
		migrateSettings();
		const after = {
			websearch: getSetting<WebSearchSettings>('websearch', {} as WebSearchSettings),
			research: getSetting<ResearchSettings>('research', {} as ResearchSettings)
		};

		migrateSettings();
		expect(getSetting('websearch', {})).toEqual(after.websearch);
		expect(getSetting('research', {})).toEqual(after.research);
	});

	it('leaves an install that never saved anything to the defaults', () => {
		migrateSettings();
		expect(getSetting('websearch', null)).toBeNull();
		expect(getSetting('research', null)).toBeNull();
	});
});
