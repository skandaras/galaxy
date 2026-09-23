import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { events, models, providers } from '$lib/server/db/schema';
import { pickModel } from './engine';

/**
 * What happens when the model a task was configured with is gone.
 *
 * The fallback itself is wanted — a background agent whose model was disabled
 * is better off running on something than not running at all. What was wrong is
 * that it happened in silence, and `listEnabledModels()` has no ORDER BY, so the
 * substitute is whichever row SQLite returned first. Disable the model the
 * memory job points at and its output quietly gets worse, with nothing anywhere
 * recording that it is no longer running on what somebody chose.
 *
 * These assert the event, because the event is the fix.
 */

beforeAll(() => runMigrations());

beforeEach(() => {
	db.delete(events).run();
	db.delete(models).run();
	db.delete(providers).run();
	db.insert(providers)
		.values({
			id: 'p-pick',
			name: 'mock',
			kind: 'openai-compatible',
			baseUrl: 'http://127.0.0.1:1/v1',
			apiKeyEnc: null,
			enabled: true,
			createdAt: new Date()
		})
		.run();
	db.insert(models)
		.values({
			id: 'm-pick',
			providerId: 'p-pick',
			modelKey: 'mock-one',
			displayName: 'Mock One',
			contextWindow: 8000,
			supportsTools: true,
			supportsVision: false,
			promptCostPerMTok: null,
			completionCostPerMTok: null,
			cacheMode: 'auto',
			enabled: true
		})
		.run();
});

const substitutions = () =>
	db.select().from(events).where(eq(events.type, 'failover')).all();

describe('pickModel', () => {
	it('returns the model that was asked for, and says nothing', () => {
		expect(pickModel('m-pick', 'memory')?.model.modelKey).toBe('mock-one');
		expect(substitutions()).toHaveLength(0);
	});

	it('substitutes when the configured model is gone, and records that it did', () => {
		const choice = pickModel('m-deleted', 'memory');
		expect(choice?.model.modelKey).toBe('mock-one');

		const [event] = substitutions();
		expect(event).toBeTruthy();
		// The task is the whole point of the row: "something was substituted" is
		// not actionable, "the memory job is not running on your model" is.
		expect(event.task).toBe('memory');
		expect(event.status).toBe('error');
		expect(event.name).toContain('m-deleted');
		expect(event.name).toContain('mock-one');
	});

	it('stays quiet when no model was ever configured', () => {
		// An unconfigured task is not a broken one, and a platform that has not
		// been set up yet must not fill the feed with red rows saying so.
		expect(pickModel(null, 'memory')?.model.modelKey).toBe('mock-one');
		expect(substitutions()).toHaveLength(0);
	});

	it('never falls back onto a coding-only provider for another task', () => {
		// Sorted ahead of the configured model, so a fallback that ignored the
		// flag would take it. This is the path by which a chat asking for a model
		// it may not use would otherwise end up on it.
		db.insert(providers)
			.values({
				id: 'p-coding',
				name: 'coding',
				kind: 'openai',
				baseUrl: 'http://127.0.0.1:1/v1',
				apiKeyEnc: null,
				enabled: true,
				codingOnly: true,
				createdAt: new Date()
			})
			.run();
		db.insert(models)
			.values({
				id: 'm-coding',
				providerId: 'p-coding',
				modelKey: 'coding-one',
				displayName: 'A Coding Model',
				supportsTools: true,
				cacheMode: 'auto',
				enabled: true
			})
			.run();
		expect(pickModel('m-coding', 'chat')?.model.modelKey).toBe('mock-one');
		expect(substitutions()[0]?.name).toContain('m-coding');
		expect(pickModel(null, 'chat')?.model.modelKey).toBe('mock-one');
		expect(pickModel('m-coding', 'coding')?.model.modelKey).toBe('coding-one');
	});

	it('has nothing to substitute when no model is enabled', () => {
		db.update(models).set({ enabled: false }).run();
		expect(pickModel('m-deleted', 'memory')).toBeNull();
		// No fallback happened, so there is nothing to report — the caller's own
		// "no model configured" path is what speaks here.
		expect(substitutions()).toHaveLength(0);
	});
});
