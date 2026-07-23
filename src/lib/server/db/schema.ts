import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	email: text('email'),
	displayName: text('display_name'),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull()
});

// Key/value settings. scope is 'global' or a user id, so per-user
// overrides live beside platform-wide defaults.
export const settings = sqliteTable(
	'settings',
	{
		scope: text('scope').notNull(),
		key: text('key').notNull(),
		value: text('value', { mode: 'json' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [primaryKey({ columns: [t.scope, t.key] })]
);

// Observatory feed. Written by the engine from M1 on; events belonging to
// hidden chats are streamed live but never inserted here.
export const events = sqliteTable('events', {
	id: text('id').primaryKey(),
	ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
	userId: text('user_id'),
	chatId: text('chat_id'),
	task: text('task'),
	type: text('type').notNull(),
	name: text('name').notNull(),
	status: text('status', { enum: ['ok', 'error', 'running'] }).notNull(),
	durationMs: integer('duration_ms'),
	detail: text('detail', { mode: 'json' })
});
