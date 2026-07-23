import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

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

// Hidden chats never appear here — they live only in the in-memory store
// (see $lib/server/chats.ts) and vanish on restart.
export const chats = sqliteTable('chats', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	mode: text('mode', { enum: ['chat', 'code'] }).notNull().default('chat'),
	title: text('title').notNull().default('New chat'),
	compactSummary: text('compact_summary'),
	compactedUpTo: integer('compacted_up_to').notNull().default(0),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

export const messages = sqliteTable('messages', {
	id: text('id').primaryKey(),
	chatId: text('chat_id').notNull(),
	seq: integer('seq').notNull(),
	role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
	content: text('content').notNull(),
	attachments: text('attachments', { mode: 'json' }).$type<AttachmentRef[] | null>(),
	modelKey: text('model_key'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

export interface AttachmentRef {
	id: string;
	name: string;
	mime: string;
}

export const attachments = sqliteTable('attachments', {
	id: text('id').primaryKey(),
	chatId: text('chat_id').notNull(),
	name: text('name').notNull(),
	mime: text('mime').notNull(),
	size: integer('size').notNull(),
	path: text('path').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

export const providers = sqliteTable('providers', {
	id: text('id').primaryKey(),
	kind: text('kind', { enum: ['openrouter', 'openai-compatible'] }).notNull(),
	name: text('name').notNull(),
	baseUrl: text('base_url').notNull(),
	apiKeyEnc: text('api_key_enc'),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

export const models = sqliteTable('models', {
	id: text('id').primaryKey(),
	providerId: text('provider_id').notNull(),
	modelKey: text('model_key').notNull(),
	displayName: text('display_name').notNull(),
	contextWindow: integer('context_window'),
	supportsTools: integer('supports_tools', { mode: 'boolean' }).notNull().default(false),
	supportsVision: integer('supports_vision', { mode: 'boolean' }).notNull().default(false),
	promptCostPerMTok: real('prompt_cost_per_mtok'),
	completionCostPerMTok: real('completion_cost_per_mtok'),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true)
});

export const CORE_TASKS = [
	'chat',
	'coding',
	'deep-research',
	'visual',
	'memory',
	'skill-optimiser'
] as const;
export type CoreTask = (typeof CORE_TASKS)[number];

export const taskConfigs = sqliteTable('task_configs', {
	task: text('task').primaryKey(),
	systemPrompt: text('system_prompt').notNull().default(''),
	primaryModelId: text('primary_model_id'),
	backupModelId: text('backup_model_id'),
	options: text('options', { mode: 'json' })
});

// Every save of a task's system prompt lands here, newest first, so edits
// are always recoverable (restore = save an old version as the new current).
export const taskPromptVersions = sqliteTable('task_prompt_versions', {
	id: text('id').primaryKey(),
	task: text('task').notNull(),
	systemPrompt: text('system_prompt').notNull(),
	author: text('author').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

// One coding session per code-mode chat: a cloned workspace on the shared
// data volume plus the branch the agent works on.
export const codeSessions = sqliteTable('code_sessions', {
	chatId: text('chat_id').primaryKey(),
	userId: text('user_id').notNull(),
	repoUrl: text('repo_url').notNull(),
	repoName: text('repo_name').notNull(),
	baseBranch: text('base_branch').notNull(),
	workBranch: text('work_branch').notNull(),
	/** Workspace path relative to DATA_DIR (shared with runner containers). */
	workspaceRel: text('workspace_rel').notNull(),
	mode: text('mode', { enum: ['plan', 'implement'] }).notNull().default('plan'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

// Library metadata + cached snippet; the markdown body lives on disk at
// DATA_DIR/library/<id>.md. Full-text search runs on the library_fts
// virtual table created at boot (drizzle doesn't manage FTS5).
export const libraryDocs = sqliteTable('library_docs', {
	id: text('id').primaryKey(), // slug, doubles as the filename
	title: text('title').notNull(),
	snippet: text('snippet').notNull().default(''),
	author: text('author', { enum: ['user', 'agent'] }).notNull().default('user'),
	sizeBytes: integer('size_bytes').notNull().default(0),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

// Skill index; the SKILL.md body lives on disk at
// DATA_DIR/skills/<category>/<name>/SKILL.md (a git repo, committed on save).
export const skills = sqliteTable('skills', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	category: text('category').notNull().default('general'),
	description: text('description').notNull().default(''),
	triggers: text('triggers').notNull().default(''),
	version: integer('version').notNull().default(1),
	author: text('author', { enum: ['user', 'agent'] }).notNull().default('user'),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

// Durable observations the memory agent extracts from activity. Injected
// into the context bootstrap while active.
export const memoryItems = sqliteTable('memory_items', {
	id: text('id').primaryKey(),
	kind: text('kind', { enum: ['preference', 'pattern', 'fact'] }).notNull(),
	content: text('content').notNull(),
	source: text('source'),
	status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

// Skills proposed by the memory/optimiser agents. Never auto-activated:
// a human approves (which writes the real skill) or rejects.
export const skillCandidates = sqliteTable('skill_candidates', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	category: text('category').notNull().default('general'),
	description: text('description').notNull().default(''),
	triggers: text('triggers').notNull().default(''),
	body: text('body').notNull().default(''),
	rationale: text('rationale').notNull().default(''),
	status: text('status', { enum: ['pending', 'approved', 'rejected'] })
		.notNull()
		.default('pending'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	decidedAt: integer('decided_at', { mode: 'timestamp_ms' })
});

export const usageLog = sqliteTable('usage_log', {
	id: text('id').primaryKey(),
	ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
	userId: text('user_id'),
	chatId: text('chat_id'),
	task: text('task').notNull(),
	modelKey: text('model_key').notNull(),
	promptTokens: integer('prompt_tokens').notNull().default(0),
	completionTokens: integer('completion_tokens').notNull().default(0),
	costUsd: real('cost_usd'),
	status: text('status', { enum: ['ok', 'error'] }).notNull()
});

// Job history for non-hidden chats; the live stream state is in-memory
// (see $lib/server/engine/jobs.ts).
export const jobs = sqliteTable('jobs', {
	id: text('id').primaryKey(),
	chatId: text('chat_id'),
	userId: text('user_id').notNull(),
	task: text('task').notNull(),
	status: text('status', { enum: ['running', 'done', 'error'] }).notNull(),
	error: text('error'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
});
