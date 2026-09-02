import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { taskConfigs } from '$lib/server/db/schema';
import { SUPERSEDED_PROMPTS, migrateSettings, migrateTaskPrompts, seedTaskConfigs } from './bootstrap';
import {
	deleteSetting,
	getSetting,
	setSetting,
	type ResearchSettings,
	type WebSearchSettings
} from './settings';

/**
 * That improving a shipped prompt actually reaches an install that already
 * exists — and that it never treads on one somebody has made their own.
 *
 * `seedTaskConfigs` writes a task's prompt once and never again, which is right:
 * a prompt you edited in Admin -> Tasks is yours. The consequence nobody had
 * accounted for is that changing a default reaches only installs that have never
 * booted, i.e. none of them — so a rewritten prompt shipped as dead text while
 * the behaviour it was written to fix carried on unchanged.
 */

const prompt = (task: string) =>
	db.select().from(taskConfigs).where(eq(taskConfigs.task, task)).get()?.systemPrompt ?? '';

const OLD_MEMORY =
	'You are the memory agent of Galaxy. Audit recent activity for durable patterns, preferences and candidate skills. Extract only what is clearly supported.';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(taskConfigs).run();
	seedTaskConfigs();
});

describe('bringing a stored prompt up to date', () => {
	it('replaces one that is still the shipped default', () => {
		db.update(taskConfigs)
			.set({ systemPrompt: OLD_MEMORY })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		migrateTaskPrompts();
		expect(prompt('memory')).not.toBe(OLD_MEMORY);
		// The point of the rewrite: a test the model can fail, and the class of
		// thing it should stop recording.
		expect(prompt('memory')).toContain('six months');
		expect(prompt('memory')).toContain('asked about');
	});

	it.each(Object.entries(SUPERSEDED_PROMPTS))('upgrades every superseded %s prompt', (task, olds) => {
		// Generic on purpose. An entry that no longer matches anything the app ever
		// shipped, or one for a task with no current default, is dead text that
		// looks exactly like a working migration — and the only symptom is that
		// nothing improves.
		for (const old of olds) {
			db.update(taskConfigs).set({ systemPrompt: old }).where(eq(taskConfigs.task, task)).run();
			migrateTaskPrompts();
			expect(prompt(task), `${task} did not move off a superseded prompt`).not.toBe(old);
			expect(prompt(task).length).toBeGreaterThan(0);
		}
	});

	it('carries the method into the two prompts this release rewrote', () => {
		// The chat prompt already asked for a deliberate search and was losing to
		// the loop's batching advice; research was one sentence naming the job and
		// nothing about how to do it.
		expect(prompt('chat')).toContain('one query at a time');
		expect(prompt('chat')).toContain('fetch_url');
		expect(prompt('deep-research')).toContain('rounds');
		expect(prompt('deep-research')).toContain('guess');
	});

	it('leaves a prompt somebody has edited exactly alone', () => {
		const mine = 'You are the memory agent. Only ever record things about cheese.';
		db.update(taskConfigs)
			.set({ systemPrompt: mine })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		migrateTaskPrompts();
		expect(prompt('memory')).toBe(mine);
	});

	it('runs on every boot and changes nothing after the first', () => {
		db.update(taskConfigs)
			.set({ systemPrompt: OLD_MEMORY })
			.where(eq(taskConfigs.task, 'memory'))
			.run();

		migrateTaskPrompts();
		const after = prompt('memory');
		migrateTaskPrompts();
		migrateTaskPrompts();
		expect(prompt('memory')).toBe(after);
	});

	it('does nothing for a task that is not there', () => {
		db.delete(taskConfigs).run();
		expect(() => migrateTaskPrompts()).not.toThrow();
		expect(prompt('memory')).toBe('');
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
