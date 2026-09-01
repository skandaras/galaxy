import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';
import type { MessageTrace } from '$lib/run-timeline';

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	email: text('email'),
	displayName: text('display_name'),
	/**
	 * Re-derived from Authelia group membership on every request (see
	 * hooks.server.ts), so this column is a cache, not a control — setting it
	 * in-app is overwritten on the user's next request.
	 */
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	/**
	 * Coding mode clones and pushes with one shared GitHub token, so it grants
	 * write access to every repository that token reaches. Off for new users;
	 * granted per user in Admin → Users.
	 */
	canCode: integer('can_code', { mode: 'boolean' }).notNull().default(false),
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
//
// Every read is "newest first, optionally narrowed" (see /api/events), and the
// table is the fastest-growing one in the schema — so the indexes are on ts and
// on the two columns the feed filters by, each paired with ts so the sort is
// served by the index rather than a temp b-tree.
export const events = sqliteTable(
	'events',
	{
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
	},
	(t) => [
		index('events_ts_idx').on(t.ts),
		index('events_user_ts_idx').on(t.userId, t.ts),
		index('events_chat_ts_idx').on(t.chatId, t.ts)
	]
);

// Hidden chats never appear here — they live only in the in-memory store
// (see $lib/server/chats.ts) and vanish on restart.
export const chats = sqliteTable(
	'chats',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		mode: text('mode', { enum: ['chat', 'code'] }).notNull().default('chat'),
		title: text('title').notNull().default('New chat'),
		/**
		 * Model this chat last used, so reopening it restores that choice instead of
		 * inheriting whatever the composer happened to be set to. Nullable for chats
		 * that predate this, and may name a model that has since been deleted or
		 * disabled — callers fall back to the task default.
		 */
		modelId: text('model_id'),
		/**
		 * Set once a human names the chat, so the auto-titler never overwrites a
		 * title someone chose. Nothing clears it but another rename.
		 */
		titleCustom: integer('title_custom', { mode: 'boolean' }).notNull().default(false),
		/**
		 * When the chat was archived, or null while it is active. A timestamp
		 * rather than a flag so the archive can be ordered by when things were put
		 * away. Archiving only hides a chat from the list — it stays readable, and
		 * stays part of the platform's context.
		 */
		archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
		compactSummary: text('compact_summary'),
		compactedUpTo: integer('compacted_up_to').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	// listChats() is per-user, newest first — the history pane's only query.
	(t) => [index('chats_user_updated_idx').on(t.userId, t.updatedAt)]
);

export const messages = sqliteTable(
	'messages',
	{
		id: text('id').primaryKey(),
		chatId: text('chat_id').notNull(),
		seq: integer('seq').notNull(),
		role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
		content: text('content').notNull(),
		attachments: text('attachments', { mode: 'json' }).$type<AttachmentRef[] | null>(),
		modelKey: text('model_key'),
		/**
		 * What the agent did to produce this reply — the steps it took and the
		 * tools each one called. Null for every message written before runs were
		 * recorded, and for anything that isn't an agent reply.
		 *
		 * Without it, scrolling back through a coding session showed the prose and
		 * no evidence at all: the trace was live-only and thrown away the moment
		 * the run finished.
		 */
		trace: text('trace', { mode: 'json' }).$type<MessageTrace | null>(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Every turn reads a whole chat in seq order, so the sort rides the index.
	(t) => [index('messages_chat_seq_idx').on(t.chatId, t.seq)]
);

export interface AttachmentRef {
	id: string;
	name: string;
	mime: string;
	/** Absent on refs written before document support — treat as an image. */
	kind?: 'image' | 'document';
	/** Length of the extracted text, so the UI can hint at document size. */
	textChars?: number;
}

export const attachments = sqliteTable(
	'attachments',
	{
		id: text('id').primaryKey(),
		chatId: text('chat_id').notNull(),
		name: text('name').notNull(),
		mime: text('mime').notNull(),
		size: integer('size').notNull(),
		path: text('path').notNull(),
		// Documents are text-extracted once at upload; images go to the model as
		// data URLs instead and leave these two columns empty.
		kind: text('kind', { enum: ['image', 'document'] }).notNull().default('image'),
		extractedText: text('extracted_text'),
		textChars: integer('text_chars').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('attachments_chat_idx').on(t.chatId)]
);

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
	/**
	 * The model returns images, not just reads them — what generate_image needs
	 * and what the `visual` task must be pointed at. Read from a provider's own
	 * listing (OpenRouter's `output_modalities`), so unlike cacheMode it is a
	 * fact to be corrected on every sync rather than a preference an admin owns.
	 */
	supportsImageOutput: integer('supports_image_output', { mode: 'boolean' })
		.notNull()
		.default(false),
	promptCostPerMTok: real('prompt_cost_per_mtok'),
	completionCostPerMTok: real('completion_cost_per_mtok'),
	/**
	 * How this model wants prompt caching asked for.
	 *
	 * 'auto'     — send nothing. Providers that cache on their own (GLM, OpenAI,
	 *              DeepSeek and friends) do it off a stable prefix with no
	 *              request changes, and a provider that does not cache ignores
	 *              us either way. This is the default because sending an unknown
	 *              field to an endpoint that has never heard of it is the only
	 *              way this feature can break a working setup.
	 * 'explicit' — mark cache breakpoints with cache_control, which is what
	 *              Anthropic and Gemini need and what OpenRouter passes through.
	 * 'none'     — never mark anything, for an endpoint that rejects the field.
	 *
	 * An admin setting rather than something inferred: nothing in an
	 * OpenAI-compatible /models listing describes caching, so any inference is a
	 * guess, and a wrong guess costs money silently.
	 */
	cacheMode: text('cache_mode', { enum: ['auto', 'explicit', 'none'] })
		.notNull()
		.default('auto'),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true)
});

export const CORE_TASKS = [
	'chat',
	'coding',
	'deep-research',
	'visual',
	'memory',
	'skill-optimiser',
	'ux-audit',
	'chat-title',
	'run-summary',
	'subagent',
	'board',
	'alignment',
	'alignment-synthesis',
	'cortex-groom'
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
export const taskPromptVersions = sqliteTable(
	'task_prompt_versions',
	{
		id: text('id').primaryKey(),
		task: text('task').notNull(),
		systemPrompt: text('system_prompt').notNull(),
		author: text('author').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('task_prompt_versions_task_created_idx').on(t.task, t.createdAt)]
);

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
export const libraryDocs = sqliteTable(
	'library_docs',
	{
		id: text('id').primaryKey(), // slug, doubles as the filename
		title: text('title').notNull(),
		snippet: text('snippet').notNull().default(''),
		author: text('author', { enum: ['user', 'agent'] }).notNull().default('user'),
		/**
		 * Who owns the doc. Null means it predates ownership — those stay visible
		 * to everyone, which is exactly how the library behaved before this.
		 */
		ownerId: text('owner_id'),
		/**
		 * 'shared' shows in every user's list and context; 'personal' only in the
		 * owner's. New docs start personal — the library used to be entirely
		 * global, so sharing is now the deliberate act rather than the default.
		 */
		visibility: text('visibility', { enum: ['personal', 'shared'] })
			.notNull()
			.default('shared'),
		/**
		 * Cosmetic grouping for the shelf — a flat label, not a path, and no part
		 * of who may see a doc. Empty means unfiled, which is where everything
		 * starts and most things stay.
		 */
		folder: text('folder').notNull().default(''),
		sizeBytes: integer('size_bytes').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Every list is "what may this user see", which is owner or shared.
	(t) => [index('library_docs_owner_idx').on(t.ownerId, t.visibility)]
);

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
export const memoryItems = sqliteTable(
	'memory_items',
	{
		id: text('id').primaryKey(),
		// Owner. Nullable so the column can be added without breaking a rollback to
		// an image that inserts without it (expand-migrate-contract); every read
		// filters by owner, so a null row is simply invisible.
		userId: text('user_id'),
		kind: text('kind', { enum: ['preference', 'pattern', 'fact'] }).notNull(),
		content: text('content').notNull(),
		source: text('source'),
		status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Reads are always "this user's items, usually the active ones".
	(t) => [index('memory_items_user_status_idx').on(t.userId, t.status)]
);

// Skills proposed by the memory/optimiser agents. Never auto-activated:
// a human approves (which writes the real skill) or rejects.
export const skillCandidates = sqliteTable('skill_candidates', {
	id: text('id').primaryKey(),
	/** Whose activity proposed this, for attribution in the approval queue. */
	userId: text('user_id'),
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

// Admin overrides for tools. Behaviour always lives in code (or on an MCP
// server) — these rows only gate and relabel what the agents are offered, so
// a row naming a tool that no longer exists is simply ignored.
export const toolSettings = sqliteTable('tool_settings', {
	name: text('name').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	descriptionOverride: text('description_override'),
	/** Restrict to these tasks; null means "wherever the tool normally applies". */
	tasks: text('tasks', { mode: 'json' }).$type<string[] | null>(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

// External MCP servers. Their tools are discovered on sync and cached in
// mcp_tools so assembling a turn never waits on a network round trip.
export const mcpServers = sqliteTable('mcp_servers', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	transport: text('transport', { enum: ['http', 'stdio'] }).notNull().default('http'),
	/** http transport */
	url: text('url'),
	/** Headers as an encrypted JSON object — they usually carry a bearer token. */
	headersEnc: text('headers_enc'),
	/** stdio transport; the command must exist inside the container. */
	command: text('command'),
	/** Environment for the stdio child process, as an encrypted JSON object —
	 * it often carries an API key the server needs (e.g. FIGMA_API_KEY), and is
	 * never returned to the browser once saved, like headers. */
	envEnc: text('env_enc'),
	args: text('args', { mode: 'json' }).$type<string[] | null>(),
	/** Prepended to every tool name as `<prefix>__<tool>` to avoid collisions. */
	toolPrefix: text('tool_prefix').notNull().default(''),
	tasks: text('tasks', { mode: 'json' }).$type<string[] | null>(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	status: text('status', { enum: ['unknown', 'ok', 'error'] }).notNull().default('unknown'),
	lastError: text('last_error'),
	lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

export const mcpTools = sqliteTable('mcp_tools', {
	/** `<serverId>:<remoteName>` */
	id: text('id').primaryKey(),
	serverId: text('server_id').notNull(),
	/** Qualified name the model sees. */
	name: text('name').notNull(),
	/** Name on the server, which is what gets called. */
	remoteName: text('remote_name').notNull(),
	description: text('description').notNull().default(''),
	parameters: text('parameters', { mode: 'json' }).$type<Record<string, unknown>>()
	// Enable/disable lives in tool_settings, so builtin and MCP tools are
	// governed by exactly one mechanism.
});

// Indexed on ts because getBudgetStatus() sums this period's rows before every
// single turn, and the usage dashboard groups over the same window.
export const usageLog = sqliteTable(
	'usage_log',
	{
		id: text('id').primaryKey(),
		ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
		userId: text('user_id'),
		chatId: text('chat_id'),
		task: text('task').notNull(),
		modelKey: text('model_key').notNull(),
		promptTokens: integer('prompt_tokens').notNull().default(0),
		completionTokens: integer('completion_tokens').notNull().default(0),
		/**
		 * Prompt tokens the provider served from its own cache, where it says so.
		 * Zero also covers "the provider never mentioned caching", which is the
		 * honest reading for a row written before this column existed.
		 */
		cachedPromptTokens: integer('cached_prompt_tokens').notNull().default(0),
		costUsd: real('cost_usd'),
		status: text('status', { enum: ['ok', 'error'] }).notNull()
	},
	(t) => [index('usage_log_ts_idx').on(t.ts), index('usage_log_user_ts_idx').on(t.userId, t.ts)]
);

// Job history for non-hidden chats; the live stream state is in-memory
// (see $lib/server/engine/jobs.ts).
export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		chatId: text('chat_id'),
		userId: text('user_id').notNull(),
		task: text('task').notNull(),
		// 'cancelled' = stopped by the user; the partial reply is still saved.
		// SQLite stores this as plain TEXT with no CHECK, so adding a value here is
		// a type-level change only and needs no migration.
		status: text('status', { enum: ['running', 'done', 'error', 'cancelled'] }).notNull(),
		error: text('error'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
	},
	(t) => [index('jobs_created_idx').on(t.createdAt), index('jobs_chat_idx').on(t.chatId)]
);

// --- task boards -----------------------------------------------------------
//
// A board is a small shared workspace: lanes group cards however the owner
// likes, and a card's status moves through the workflow independently (the
// Linear split, rather than Trello's "the column *is* the status"). Marking a
// card with the board's done status archives it off the board.
//
// Access is entirely through board_members — a board's owner gets a member row
// when the board is created, so there is exactly one table to consult and no
// "owner or member" special case anywhere.

export const boards = sqliteTable(
	'boards',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		/** Archiving a whole board hides it from the picker; nothing is deleted. */
		archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('boards_owner_idx').on(t.ownerId)]
);

export const BOARD_ROLES = ['owner', 'collaborator'] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

/**
 * Who may see a board. Collaborators do everything on the board's contents;
 * only the owner may rename or delete the board itself, or change membership.
 */
export const boardMembers = sqliteTable(
	'board_members',
	{
		boardId: text('board_id').notNull(),
		userId: text('user_id').notNull(),
		role: text('role', { enum: BOARD_ROLES }).notNull().default('collaborator'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	// "Which boards may this user see" is the question asked on every request,
	// including from agent tools, so it gets its own index rather than riding
	// the primary key's leading column.
	(t) => [primaryKey({ columns: [t.boardId, t.userId] }), index('board_members_user_idx').on(t.userId)]
);

/** Columns on the board. Capped at MAX_LANES, enforced on write. */
export const boardLanes = sqliteTable(
	'board_lanes',
	{
		id: text('id').primaryKey(),
		boardId: text('board_id').notNull(),
		name: text('name').notNull(),
		position: integer('position').notNull().default(0)
	},
	(t) => [index('board_lanes_board_idx').on(t.boardId, t.position)]
);

export const boardStatuses = sqliteTable(
	'board_statuses',
	{
		id: text('id').primaryKey(),
		boardId: text('board_id').notNull(),
		name: text('name').notNull(),
		colour: text('colour').notNull().default(''),
		position: integer('position').notNull().default(0),
		/**
		 * The status that means finished. Setting a card to it archives the card.
		 * A board may have more than one (e.g. "Done" and "Won't do").
		 */
		isDone: integer('is_done', { mode: 'boolean' }).notNull().default(false)
	},
	(t) => [index('board_statuses_board_idx').on(t.boardId, t.position)]
);

/**
 * A strand of work running across a board — "kitchen", "the move", "tax".
 *
 * Purely a way of grouping and then filtering the view: hiding a project hides
 * its cards from the board, it does not archive or remove them. That is why
 * this is separate from status (which finishes a card) and from lane (which
 * decides where it sits).
 */
export const boardProjects = sqliteTable(
	'board_projects',
	{
		id: text('id').primaryKey(),
		boardId: text('board_id').notNull(),
		name: text('name').notNull(),
		/** Drawn as the card's border, so a board reads as colour at a glance. */
		colour: text('colour').notNull().default(''),
		position: integer('position').notNull().default(0)
	},
	(t) => [index('board_projects_board_idx').on(t.boardId, t.position)]
);

export const CARD_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

export const cards = sqliteTable(
	'cards',
	{
		id: text('id').primaryKey(),
		boardId: text('board_id').notNull(),
		laneId: text('lane_id').notNull(),
		statusId: text('status_id').notNull(),
		/** Optional: a card need not belong to a project. Nulled if one is deleted. */
		projectId: text('project_id'),
		title: text('title').notNull(),
		description: text('description').notNull().default(''),
		priority: text('priority', { enum: CARD_PRIORITIES }).notNull().default('none'),
		/** Order within the lane, renumbered from 0 whenever a lane is reordered. */
		position: integer('position').notNull().default(0),
		createdBy: text('created_by').notNull(),
		assignedTo: text('assigned_to'),
		/** Set when the card reaches a done status; archived cards leave the board. */
		archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	// The board view reads one board's live cards in lane order; the archive
	// reads the same board's archived ones newest first.
	(t) => [
		index('cards_board_lane_idx').on(t.boardId, t.laneId, t.position),
		index('cards_board_archived_idx').on(t.boardId, t.archivedAt)
	]
);

// Cards need their own attachments: the chat `attachments` table is keyed by
// chatId, and a card has no chat.
export const cardAttachments = sqliteTable(
	'card_attachments',
	{
		id: text('id').primaryKey(),
		cardId: text('card_id').notNull(),
		name: text('name').notNull(),
		mime: text('mime').notNull(),
		size: integer('size').notNull(),
		path: text('path').notNull(),
		kind: text('kind', { enum: ['image', 'document'] }).notNull().default('document'),
		extractedText: text('extracted_text'),
		textChars: integer('text_chars').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('card_attachments_card_idx').on(t.cardId)]
);

/**
 * Every change to a card lands here, so the card's Log is the audit trail
 * rather than a separate feature — and an agent that picks a card up can read
 * what has already been tried.
 */
export const cardLog = sqliteTable(
	'card_log',
	{
		id: text('id').primaryKey(),
		cardId: text('card_id').notNull(),
		actor: text('actor', { enum: ['user', 'agent'] }).notNull().default('user'),
		/** Who did it — the acting user, or the user an agent was acting for. */
		userId: text('user_id'),
		/** Short verb: created, moved, status, priority, assigned, comment, agent. */
		event: text('event').notNull(),
		detail: text('detail').notNull().default(''),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('card_log_card_created_idx').on(t.cardId, t.createdAt)]
);

// --- notifications ---------------------------------------------------------

/**
 * What raised a notification. The kind drives the icon and, more importantly,
 * whether it is worth waking a phone for — only `question` parks real work.
 */
export const NOTIFICATION_KINDS = [
	'question',
	'card-assigned',
	'board-shared',
	'card-done',
	'turn-failed'
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Things addressed to one person that they have not dealt with yet.
 *
 * Deliberately not the events table: events record what the platform did, and
 * a notification records what somebody still needs to look at. The failure mode
 * this exists for is being *away*, so it is durable rather than live-only — a
 * badge that only exists while you are watching solves nothing.
 */
export const notifications = sqliteTable(
	'notifications',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
		title: text('title').notNull(),
		body: text('body').notNull().default(''),
		/** Where to go when it is clicked, e.g. /chat?chat=… or /boards?card=… */
		link: text('link').notNull().default(''),
		/**
		 * The thing this is about — a question id, card id, chat id. Lets a
		 * notification be cleared when its subject is dealt with somewhere else, so
		 * the badge never claims attention for something already handled.
		 */
		entityId: text('entity_id'),
		/** Worth interrupting for: the run is parked until it is answered. */
		urgent: integer('urgent', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		readAt: integer('read_at', { mode: 'timestamp_ms' })
	},
	// The two reads: this user's unread count, and their list newest first.
	(t) => [
		index('notifications_user_read_idx').on(t.userId, t.readAt),
		index('notifications_user_created_idx').on(t.userId, t.createdAt),
		index('notifications_entity_idx').on(t.entityId)
	]
);

/**
 * Web Push registrations — one row per browser/device that has granted
 * permission, which is why a single user has several.
 *
 * The keys are the browser's own public key material, not ours; they are
 * useless without the VAPID private key held in settings, so they are stored
 * as-is. A push service reports a dead registration as 404/410, and those rows
 * are deleted rather than retried.
 */
export const pushSubscriptions = sqliteTable(
	'push_subscriptions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		/** Unique per browser install; re-registering the same one is an upsert. */
		endpoint: text('endpoint').notNull().unique(),
		p256dh: text('p256dh').notNull(),
		auth: text('auth').notNull(),
		/** So a person can tell their phone from their laptop when revoking one. */
		userAgent: text('user_agent').notNull().default(''),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' })
	},
	(t) => [index('push_subscriptions_user_idx').on(t.userId)]
);

/**
 * The UX backlog: ideas the weekly ux-audit agent proposes for the owner to
 * skim. Nothing here is ever actioned automatically — a human marks each one
 * `actioned` or `discarded`, and both simply dismiss it from the open list.
 *
 * Rows are never deleted. Decided ideas are the agent's institutional memory:
 * every run is shown what it has already proposed, and what became of it, so it
 * stops re-raising the same thing. `fingerprint` is a normalised form of the
 * title and enforces that in code as well as in the prompt.
 */
export const uxIdeas = sqliteTable(
	'ux_ideas',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		/** Free text, but the prompt asks for one of the known surfaces. */
		area: text('area').notNull().default('general'),
		severity: text('severity', { enum: ['low', 'medium', 'high'] })
			.notNull()
			.default('medium'),
		/** Rough size: s/m/l. Advisory only — nothing schedules off it. */
		effort: text('effort', { enum: ['s', 'm', 'l'] })
			.notNull()
			.default('m'),
		problem: text('problem').notNull().default(''),
		proposal: text('proposal').notNull().default(''),
		/** What in the telemetry or the UI source prompted this. */
		evidence: text('evidence').notNull().default(''),
		fingerprint: text('fingerprint').notNull(),
		status: text('status', { enum: ['open', 'actioned', 'discarded'] })
			.notNull()
			.default('open'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		decidedAt: integer('decided_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		index('ux_ideas_status_created_idx').on(t.status, t.createdAt),
		index('ux_ideas_fingerprint_idx').on(t.fingerprint)
	]
);

// --- alignment --------------------------------------------------------------
//
// A private place to state who you are, write reflections, and have an agent
// report how closely the two track each other.
//
// The whole feature is a mirror rather than a verdict, and the schema is shaped
// by that. Nothing is deleted by editing: a principle is retired, an entry keeps
// its assessments, and every save of a principle leaves a revision behind. An
// assessment is pinned both to the text it read (`entryHash`) and to the
// constitution version live at the time, so a March entry is never re-judged
// against August's values — which is the only thing that makes the trend mean
// anything.
//
// This is the most private data in the platform. Every read filters by user,
// admins included; nothing here reaches the memory agent, the context bootstrap,
// the Library or the UX audit; and no event detail ever carries the text.

export const PRINCIPLE_KINDS = [
	'value',
	'principle',
	'belief',
	'role',
	'failure-mode',
	'aspiration'
] as const;
export type PrincipleKind = (typeof PRINCIPLE_KINDS)[number];

export const PRINCIPLE_STATUSES = ['active', 'provisional', 'retired'] as const;
export type PrincipleStatus = (typeof PRINCIPLE_STATUSES)[number];

/**
 * The constitution: one row per thing you hold.
 *
 * `statement` is the sentence actually judged against; `body` is context. The
 * two exemplar columns carry different questions depending on `kind` — the form
 * relabels them (see ALIGNMENT_EXEMPLAR_LABELS) rather than the schema growing a
 * column per kind that five of the six leave empty. For a belief they become
 * "what follows from this" and "what would make me doubt it", which is what turns
 * a philosophical statement into something you can actually be wrong about.
 *
 * `weight` and `conviction` are deliberately separate axes and both reach the
 * agent: weight decides who wins when two of these collide, conviction decides
 * how firmly you are held to it. Without the split, "I'm still working this out"
 * and "this one is non-negotiable" are indistinguishable.
 */
export const alignmentPrinciples = sqliteTable(
	'alignment_principles',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		kind: text('kind', { enum: PRINCIPLE_KINDS }).notNull().default('value'),
		/** Short handle. Cited verbatim in assessments, so it is the name you'll read. */
		title: text('title').notNull(),
		/** The one-line canonical claim, in your own words. */
		statement: text('statement').notNull().default(''),
		body: text('body').notNull().default(''),
		/** "In practice this looks like…" — kind-dependent, see above. */
		exemplar: text('exemplar').notNull().default(''),
		/** "I've broken this when…" — kind-dependent, see above. */
		counterExemplar: text('counter_exemplar').notNull().default(''),
		/** 1–5: priority when two principles collide. */
		weight: integer('weight').notNull().default(3),
		/** 1–5: how settled you are. Low means engage it as an open question. */
		conviction: integer('conviction').notNull().default(3),
		/** A book, a person, an event. */
		origin: text('origin').notNull().default(''),
		status: text('status', { enum: PRINCIPLE_STATUSES }).notNull().default('active'),
		/** A nudge to revisit this one; null means never ask. */
		reviewAfter: integer('review_after', { mode: 'timestamp_ms' }),
		position: integer('position').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Every read is "this user's constitution", usually the live part of it.
	(t) => [index('alignment_principles_user_status_idx').on(t.userId, t.status)]
);

/**
 * Conflicts you declare between two of your own principles.
 *
 * Stored once with aId < bId, so a pair cannot be entered twice in opposite
 * order. This changes what the agent does with a collision: a declared tension
 * is judged on how you resolved it, where an undeclared one gets reported as a
 * gap every single time it appears.
 */
export const alignmentPrincipleTensions = sqliteTable(
	'alignment_principle_tensions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		aId: text('a_id').notNull(),
		bId: text('b_id').notNull(),
		/** How you intend to resolve it when it comes up. */
		note: text('note').notNull().default(''),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('alignment_tensions_user_idx').on(t.userId)]
);

/**
 * Per-principle history, written on every save that actually changes something.
 *
 * Separate from the constitution snapshots below and for a different purpose:
 * these are for reading — how one belief was worded two years ago and why it
 * changed — where a snapshot exists so an old assessment can say what it was
 * judging against.
 */
export const alignmentPrincipleRevisions = sqliteTable(
	'alignment_principle_revisions',
	{
		id: text('id').primaryKey(),
		principleId: text('principle_id').notNull(),
		userId: text('user_id').notNull(),
		/** Every field as it stood *after* this save. */
		snapshot: text('snapshot', { mode: 'json' }).notNull(),
		/** Which columns this save touched, so the history renders as a diff. */
		changedFields: text('changed_fields', { mode: 'json' }).$type<string[]>(),
		/** Optional, prompted: why did this change? */
		note: text('note').notNull().default(''),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('alignment_revisions_principle_idx').on(t.principleId, t.createdAt)]
);

/**
 * Whole-constitution snapshots, written lazily: an assessment hashes the live
 * principles and only inserts when the fingerprint differs from the newest row.
 * Editing a principle therefore costs nothing until it next matters.
 */
export const alignmentConstitutionVersions = sqliteTable(
	'alignment_constitution_versions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		/** Hash of the live principles; the whole mechanism for "has this changed". */
		fingerprint: text('fingerprint').notNull(),
		snapshot: text('snapshot', { mode: 'json' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('alignment_versions_user_created_idx').on(t.userId, t.createdAt)]
);

/** A journal entry. Never assessed unless asked, and never at all if flagged. */
export const alignmentEntries = sqliteTable(
	'alignment_entries',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		title: text('title').notNull().default(''),
		body: text('body').notNull(),
		/** 1–5, or null. Optional on purpose: a required field is a reason not to write. */
		mood: integer('mood'),
		/** Free comma-separated labels — work, family, health. */
		tags: text('tags').notNull().default(''),
		/**
		 * "Don't judge this one." Some entries exist to be written, not read back,
		 * and a journal you feel graded by is a journal you stop keeping.
		 */
		skipAssessment: integer('skip_assessment', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('alignment_entries_user_created_idx').on(t.userId, t.createdAt)]
);

/**
 * How aligned an entry reads against the constitution that was live when it was
 * judged.
 *
 * `band` is deliberately coarse and 'insufficient' is a first-class answer: a
 * three-line entry cannot support a judgement about character, and inventing one
 * is worse than saying so. There is no aggregate score column anywhere by
 * design — a number is a thing to optimise, and you would start writing for it.
 */
export const ASSESSMENT_BANDS = ['aligned', 'mixed', 'diverging', 'insufficient'] as const;
export type AssessmentBand = (typeof ASSESSMENT_BANDS)[number];

export const alignmentAssessments = sqliteTable(
	'alignment_assessments',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		entryId: text('entry_id').notNull(),
		constitutionVersionId: text('constitution_version_id').notNull(),
		rubricVersion: integer('rubric_version').notNull().default(1),
		/**
		 * Hash of the entry body this read. When it stops matching the entry, the
		 * assessment is stale rather than quietly wrong.
		 */
		entryHash: text('entry_hash').notNull(),
		band: text('band', { enum: ASSESSMENT_BANDS }).notNull().default('insufficient'),
		/** One plain sentence — the line the Standing view actually shows. */
		standing: text('standing').notNull().default(''),
		summary: text('summary').notNull().default(''),
		confidence: text('confidence', { enum: ['low', 'medium', 'high'] })
			.notNull()
			.default('low'),
		/** Per-dimension: score, the quote that supports it, principles engaged. */
		scores: text('scores', { mode: 'json' }).$type<AssessmentScore[]>(),
		tensions: text('tensions', { mode: 'json' }).$type<AssessmentTension[]>(),
		gaps: text('gaps', { mode: 'json' }).$type<AssessmentGap[]>(),
		/** Bandura's mechanisms spotted in the entry's own language. */
		disengagement: text('disengagement', { mode: 'json' }).$type<string[]>(),
		/** Brooding rather than reflecting — switches the reply to self-distancing. */
		rumination: integer('rumination', { mode: 'boolean' }).notNull().default(false),
		/** Distress signals: the rubric is dropped entirely and care comes first. */
		care: integer('care', { mode: 'boolean' }).notNull().default(false),
		/** One if-then implementation intention, not a lecture. */
		nextStep: text('next_step').notNull().default(''),
		/** One question to sit with — usually worth more than the advice. */
		question: text('question').notNull().default(''),
		modelKey: text('model_key'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [
		index('alignment_assessments_user_created_idx').on(t.userId, t.createdAt),
		index('alignment_assessments_entry_idx').on(t.entryId)
	]
);

export interface AssessmentScore {
	dimensionId: string;
	score: number;
	/** Verbatim from the entry. No quote, no score — enforced in parseAssessment. */
	evidence: string;
	/** Principle ids this engaged. */
	principles: string[];
	note: string;
}

export interface AssessmentTension {
	/** Exactly two principle ids. */
	between: string[];
	/** Which one won, of the two. */
	chose: string;
	note: string;
	/** Whether you had already declared this pair as a known tension. */
	declared: boolean;
}

export interface AssessmentGap {
	principle: string;
	observation: string;
	evidence: string;
}

/**
 * The periodic letter: what is growing, what is slipping, one thing to watch.
 *
 * Written from past *assessments* rather than the entries themselves — smaller
 * context, and one more layer between the rawest text and a model call.
 */
export const alignmentSyntheses = sqliteTable(
	'alignment_syntheses',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		periodStart: integer('period_start', { mode: 'timestamp_ms' }).notNull(),
		periodEnd: integer('period_end', { mode: 'timestamp_ms' }).notNull(),
		body: text('body').notNull().default(''),
		/** Short bullets the Standing view can show without the whole letter. */
		highlights: text('highlights', { mode: 'json' }).$type<string[]>(),
		/** Principles nothing has cited lately, so the letter can ask about them. */
		neglected: text('neglected', { mode: 'json' }).$type<string[]>(),
		modelKey: text('model_key'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('alignment_syntheses_user_created_idx').on(t.userId, t.createdAt)]
);

// --- cortex -----------------------------------------------------------------
//
// The knowledge lattice: concepts as nodes, weighted associations as edges,
// retrieval by traversal rather than lookup. See docs/CORTEX.md for the design
// and the reasoning behind it.
//
// Like the Library and memory, this is a store whose contents reach an agent's
// system prompt, so every row carries an owner and every read filters by one.
// The rule that makes the mesh safe as well as the rows: an association is
// visible only when *both* its endpoints are, and activation never traverses
// into a node the reader cannot see — otherwise a shared node becomes a bridge
// between two people's private ones.

export const cortexNodes = sqliteTable(
	'cortex_nodes',
	{
		id: text('id').primaryKey(),
		/**
		 * Owner. Nullable for the same expand-migrate-contract reason as
		 * memory_items: the column can be added without breaking a rollback, and
		 * every read filters by owner, so a null row is simply invisible.
		 */
		ownerId: text('owner_id'),
		/**
		 * 'shared' reaches every user's traversals; 'personal' only the owner's.
		 * New nodes start personal — the opposite of the Library's default,
		 * because a concept in someone's lattice is a more personal thing than a
		 * document they wrote to be read.
		 */
		visibility: text('visibility', { enum: ['personal', 'shared'] })
			.notNull()
			.default('personal'),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		/** JSON array. Cosmetic grouping and filtering, never access control. */
		modalities: text('modalities', { mode: 'json' }).$type<string[]>(),
		/**
		 * JSON array of circuit ids. A label for grouping and for the map's
		 * cluster titles — deliberately *not* a routing key. Seeds come from FTS
		 * so that circuits can stay curated (or later, derived) without
		 * retrieval depending on which they are.
		 */
		circuits: text('circuits', { mode: 'json' }).$type<string[]>(),
		/** 0.0–1.0. How readily this node earns a place in a result. */
		activationPriority: real('activation_priority').notNull().default(0.5),
		/**
		 * Bridges otherwise-separate areas. Earns a boost during traversal from
		 * P2 — the whole claim of the design is that these are where the useful
		 * cross-domain context lives, and the map is how you check that it is true.
		 */
		isConvergence: integer('is_convergence', { mode: 'boolean' }).notNull().default(false),
		/**
		 * Precomputed map coordinates, written by the layout sweep and never at
		 * request time. Force layout is the expensive half of any graph view, and
		 * a stable position is also what lets the chart become spatial memory
		 * rather than a fresh scatter of dots on every visit.
		 */
		x: real('x'),
		y: real('y'),
		z: real('z'),
		lastVerifiedAt: integer('last_verified_at', { mode: 'timestamp_ms' }),
		lastActivatedAt: integer('last_activated_at', { mode: 'timestamp_ms' }),
		activationCount: integer('activation_count').notNull().default(0),
		/**
		 * When the groomer last looked at this concept's **shape** — its name,
		 * areas and connections — because it was in a survey window, or in a close
		 * read of a lattice small enough not to need one.
		 *
		 * This is what makes coverage a fact rather than a hope. The rotating
		 * window used to be driven by one stored id into name order, which a
		 * deletion disturbed and which could not answer "has the groomer seen all
		 * of my lattice?" at all. Ordering a survey by this column instead means
		 * the longest-neglected concepts go first, a new concept sorts to the front
		 * on its own, and the question is answerable by looking.
		 */
		lastGroomedAt: integer('last_groomed_at', { mode: 'timestamp_ms' }),
		/**
		 * When the groomer last read this concept's **description**, in the close
		 * pass that actually judges it.
		 *
		 * Separate from the above because they are different amounts of attention,
		 * and on a large lattice the gap between them is where a problem hides: the
		 * same well-connected twenty can be examined every run while everything
		 * else is only ever glanced at. Null means no model has read what this
		 * concept says.
		 */
		lastExaminedAt: integer('last_examined_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Every read is "what may this user see", exactly as the Library does it.
	(t) => [index('cortex_nodes_owner_idx').on(t.ownerId, t.visibility)]
);

export const cortexAssociations = sqliteTable(
	'cortex_associations',
	{
		sourceId: text('source_id')
			.notNull()
			.references(() => cortexNodes.id),
		targetId: text('target_id')
			.notNull()
			.references(() => cortexNodes.id),
		/**
		 * 0.0–1.0. How strongly the two co-activate, as somebody *authored* it —
		 * by hand, by an agent, by an accepted suggestion or by an import.
		 *
		 * Learning never touches this column. What use and disuse move is
		 * `reinforcement` below, and the two are added at read time. Keeping them
		 * apart is what lets a number a person typed survive months of decay, and
		 * what lets the learned half be shown, reset or argued with on its own.
		 */
		weight: real('weight').notNull().default(0.5),
		/**
		 * The learned half of the strength, added to `weight` at read time — see
		 * `effectiveWeight` in cortex.ts, which every reader goes through.
		 *
		 * Positive when replies have actually drawn on the concepts this edge
		 * connects, and drifting negative when nothing has. Capped above, because
		 * unbounded strengthening walks a lattice toward a fully connected mesh
		 * where activation spreads everywhere and therefore nowhere; bounded below
		 * by what it is added to, so erosion stops at a floor on the sum rather
		 * than at a fixed distance from wherever the edge started.
		 */
		reinforcement: real('reinforcement').notNull().default(0),
		/** JSON array. Which conversational domains make this edge relevant. */
		contextTags: text('context_tags', { mode: 'json' }).$type<string[]>(),
		/**
		 * Why they connect, in a sentence. A closed set of edge types was
		 * considered and rejected: the relationships worth recording here don't
		 * fall into a small vocabulary, and a wrong label is worse than prose.
		 */
		description: text('description').notNull().default(''),
		/**
		 * Whether activation flows both ways equally. One concept can strongly
		 * imply another while the reverse is weak — the second is touched by many
		 * things, the first is specific.
		 */
		directionality: text('directionality', { enum: ['symmetric', 'asymmetric'] })
			.notNull()
			.default('symmetric'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		/**
		 * When activation last crossed this edge, and how often it has.
		 *
		 * Telemetry, not a weight input. Reinforcing on co-retrieval would teach
		 * the lattice to confirm the shape it already has, so these two record
		 * traversal and `reinforcement` records use — which are different
		 * questions and deliberately answered by different columns.
		 *
		 * `lastTraversedAt` also decides when an eroded edge is old enough to
		 * propose disconnecting: at the floor *and* untouched for a long time.
		 */
		lastTraversedAt: integer('last_traversed_at', { mode: 'timestamp_ms' }),
		traversalCount: integer('traversal_count').notNull().default(0)
	},
	(t) => [
		primaryKey({ columns: [t.sourceId, t.targetId] }),
		// The primary key serves outbound traversal only. Symmetric spreading
		// activation walks inbound too, and without this it table-scans every hop.
		index('cortex_assoc_target_idx').on(t.targetId)
	]
);

export const cortexCircuits = sqliteTable(
	'cortex_circuits',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id'),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('cortex_circuits_owner_idx').on(t.ownerId)]
);

/**
 * Every mutation of the lattice, whoever made it.
 *
 * Here from the first phase rather than added alongside the grooming agent,
 * because writes exist from the first phase and the first one should already be
 * auditable. When grooming lands it classifies its changes as uncontroversial,
 * low or high risk; the first two are applied and land here, and `before` is
 * what makes a flagged low-risk change reversible rather than merely noted.
 */
export const cortexChangeLog = sqliteTable(
	'cortex_change_log',
	{
		id: text('id').primaryKey(),
		nodeId: text('node_id'),
		actor: text('actor', { enum: ['user', 'agent', 'groom'] })
			.notNull()
			.default('user'),
		/** Who did it — the acting user, or the user an agent was acting for. */
		userId: text('user_id'),
		/** Short verb: created, updated, connected, disconnected, merged, deleted. */
		event: text('event').notNull(),
		detail: text('detail').notNull().default(''),
		/** Prior state for a reversible change. Null when there is nothing to undo. */
		before: text('before', { mode: 'json' }),
		/**
		 * Groups the changes one groom run made.
		 *
		 * A run touching two hundred nodes is two hundred rows, and a log nobody
		 * can read is a log nobody checks — which defeats the point of applying
		 * anything automatically. Collapsed to one line per run in the UI, and a
		 * whole run can be reverted together. Null for a change a person made by
		 * hand, which is its own occasion.
		 */
		runId: text('run_id'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [
		index('cortex_change_log_node_created_idx').on(t.nodeId, t.createdAt),
		index('cortex_change_log_user_created_idx').on(t.userId, t.createdAt),
		index('cortex_change_log_run_idx').on(t.runId)
	]
);

export const CORTEX_PROPOSAL_KINDS = [
	// The one the groomer could not make until now, and the only one that grows
	// a lattice rather than tidying one.
	'create',
	'merge',
	'connect',
	'disconnect',
	'weight',
	'circuit',
	'convergence',
	'rename',
	'delete'
] as const;
export type CortexProposalKind = (typeof CORTEX_PROPOSAL_KINDS)[number];

/**
 * Changes the groomer wants to make and will not make on its own.
 *
 * The line is sharp and permanent: if a change would alter what a query
 * returns, it is proposed rather than applied. Mechanical tidying — whitespace
 * in a name, an edge whose endpoint is gone — goes straight through and lands
 * in the change log instead.
 *
 * Modelled on ux_ideas, including the fingerprint: a decision is replayed to
 * later runs so that something already turned down is not raised again every
 * week until it is accepted out of fatigue.
 */
export const cortexProposals = sqliteTable(
	'cortex_proposals',
	{
		id: text('id').primaryKey(),
		/** Whose lattice this concerns. The groomer never proposes across owners. */
		userId: text('user_id').notNull(),
		kind: text('kind', { enum: CORTEX_PROPOSAL_KINDS }).notNull(),
		/** Short line naming the change, for the review list. */
		title: text('title').notNull(),
		/** Why the groomer thinks so, in its own words. */
		rationale: text('rationale').notNull().default(''),
		nodeId: text('node_id'),
		targetId: text('target_id'),
		/** Everything needed to apply it, so accepting is one click and not a form. */
		payload: text('payload', { mode: 'json' }),
		fingerprint: text('fingerprint').notNull(),
		status: text('status', { enum: ['open', 'actioned', 'discarded'] })
			.notNull()
			.default('open'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		decidedAt: integer('decided_at', { mode: 'timestamp_ms' })
	},
	(t) => [
		index('cortex_proposals_user_status_idx').on(t.userId, t.status, t.createdAt),
		index('cortex_proposals_fingerprint_idx').on(t.fingerprint)
	]
);
