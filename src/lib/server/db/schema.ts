import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';

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
	'skill-optimiser',
	'ux-audit',
	'chat-title',
	'run-summary',
	'board'
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
