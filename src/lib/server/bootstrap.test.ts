import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { taskConfigs } from '$lib/server/db/schema';
import { migrateTaskPrompts, seedTaskConfigs } from './bootstrap';

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
