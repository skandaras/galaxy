import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { dataDir, db, runMigrations } from '$lib/server/db';
import {
	chats,
	events,
	mcpServers,
	messages,
	skillCandidates,
	skills,
	taskConfigs,
	toolSettings
} from '$lib/server/db/schema';
import { removeIvoryTower, seedTaskConfigs } from './bootstrap';
import { appendMessage, createChat } from './chats';
import { saveSkill } from './skills';
import { getSetting, setSetting } from './settings';

/**
 * Ivory Tower was switched off with its data, and the half of that removal
 * which needs files (the seeded skill's folder, a chat's uploads) runs at boot.
 * These pin that it takes what was Ivory's, leaves what was not, and never
 * widens a skill that named an Ivory agent to every task.
 */

const USER = 'ivory-owner';

const candidate = (name: string, tasks: string) =>
	db
		.insert(skillCandidates)
		.values({
			id: randomUUID(),
			userId: USER,
			name,
			category: 'general',
			description: 'd',
			triggers: '',
			tasks,
			body: 'b',
			rationale: 'r',
			status: 'pending',
			createdAt: new Date()
		})
		.run();

beforeAll(() => {
	runMigrations();
});

describe('switching off Ivory Tower', () => {
	it('removes its skill, chats and events, and narrows shared scopes without widening them', () => {
		saveSkill({
			name: 'write-source-note',
			category: 'ivory-tower',
			description: 'Ivory notes',
			triggers: '',
			author: 'user',
			tasks: 'ivory-read',
			body: 'How to write a note.'
		});
		const folder = join(dataDir, 'skills', 'ivory-tower', 'write-source-note');
		expect(existsSync(folder)).toBe(true);
		saveSkill({
			name: 'mixed-scope',
			category: 'general',
			description: 'Both',
			triggers: '',
			author: 'user',
			tasks: 'chat, ivory-plan',
			body: 'b'
		});
		saveSkill({
			name: 'ivory-only',
			category: 'general',
			description: 'Ivory only',
			triggers: '',
			author: 'user',
			tasks: 'ivory-redteam',
			body: 'b'
		});
		candidate('write-source-note', 'ivory-read');
		candidate('pending-ivory', 'ivory-plan');
		candidate('pending-chat', 'chat');

		const ivoryChat = createChat({ userId: USER, title: 'Read sources', agentTask: 'ivory-read' });
		appendMessage(ivoryChat.id, { role: 'user', content: 'read these' });
		const ordinary = createChat({ userId: USER, title: 'Ordinary' });
		appendMessage(ordinary.id, { role: 'user', content: 'hello' });
		const now = new Date();
		db.insert(toolSettings)
			.values([
				{ name: 'fetch_url', enabled: true, tasks: ['chat', 'ivory-read'], updatedAt: now },
				{ name: 'web_search', enabled: true, tasks: ['ivory-read'], updatedAt: now }
			])
			.run();
		db.insert(mcpServers)
			.values({ id: 'mcp-ivory', name: 'scholar', tasks: ['ivory-plan'], createdAt: now })
			.run();
		db.insert(events)
			.values({
				id: randomUUID(),
				ts: new Date(),
				userId: USER,
				task: null,
				type: 'admin',
				name: 'ivory.setup',
				status: 'ok'
			})
			.run();

		removeIvoryTower();

		const names = db.select({ name: skills.name }).from(skills).all().map((r) => r.name);
		expect(names).not.toContain('write-source-note');
		expect(existsSync(folder)).toBe(false);

		const mixed = db.select().from(skills).where(eq(skills.name, 'mixed-scope')).get()!;
		expect(mixed.tasks).toBe('chat');
		expect(mixed.enabled).toBe(true);
		// Empty would mean every task, so it is switched off instead.
		const only = db.select().from(skills).where(eq(skills.name, 'ivory-only')).get()!;
		expect(only.tasks).toBe('');
		expect(only.enabled).toBe(false);

		const left = db.select({ name: skillCandidates.name }).from(skillCandidates).all();
		expect(left.map((c) => c.name)).toEqual(['pending-chat']);

		expect(db.select().from(chats).where(eq(chats.id, ivoryChat.id)).get()).toBeUndefined();
		expect(db.select().from(messages).where(eq(messages.chatId, ivoryChat.id)).all()).toEqual([]);
		expect(db.select().from(chats).where(eq(chats.id, ordinary.id)).get()?.title).toBe('Ordinary');
		expect(db.select().from(events).where(eq(events.name, 'ivory.setup')).all()).toEqual([]);
		const tool = (name: string) =>
			db.select().from(toolSettings).where(eq(toolSettings.name, name)).get()!;
		expect(tool('fetch_url').tasks).toEqual(['chat']);
		// An empty list would allow nothing while Admin drew it as unrestricted.
		expect(tool('web_search')).toMatchObject({ tasks: null, enabled: false });
		expect(db.select().from(mcpServers).where(eq(mcpServers.id, 'mcp-ivory')).get()).toMatchObject(
			{ tasks: null, enabled: false }
		);
	});

	it('clears what an older image recreates after a rollback, on the next boot', () => {
		// The image before the switch-off seeds these on boot, and its pages can
		// start Ivory runs while it is live.
		db.insert(taskConfigs).values({ task: 'ivory-read', systemPrompt: '' }).run();
		setSetting('ivory', { shelfRepo: 'me/shelf' });
		saveSkill({
			name: 'write-source-note',
			category: 'ivory-tower',
			description: 'Ivory notes',
			triggers: '',
			author: 'user',
			tasks: 'ivory-read',
			body: 'b'
		});
		const run = createChat({ userId: USER, title: 'During rollback', agentTask: 'ivory-plan' });

		removeIvoryTower();

		expect(db.select().from(taskConfigs).where(eq(taskConfigs.task, 'ivory-read')).get()).toBeUndefined();
		expect(getSetting<object | null>('ivory', null)).toBeNull();
		expect(db.select().from(skills).where(eq(skills.name, 'write-source-note')).get()).toBeUndefined();
		expect(db.select().from(chats).where(eq(chats.id, run.id)).get()).toBeUndefined();
		// And the ordinary seed does not bring any of it back.
		seedTaskConfigs();
		expect(
			db.select().from(taskConfigs).all().filter((r) => r.task.startsWith('ivory-'))
		).toEqual([]);
	});
});
