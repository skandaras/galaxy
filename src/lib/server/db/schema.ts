import {
	sqliteTable,
	text,
	integer,
	real,
	primaryKey,
	index,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
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
		 * A task config whose system prompt supplements the chat prompt for the life
		 * of this chat — 'board' for a board hand-off, null for an ordinary chat.
		 *
		 * It names the config rather than copying its text, so editing the board
		 * prompt in Admin -> Tasks takes effect on the next turn of chats that
		 * already exist. Before this the board prompt reached nothing at all: the
		 * board agent borrowed only the model and called startChatTurn, so board
		 * replies ran on the chat prompt and the textarea was dead.
		 *
		 * A nullable column rather than a new `mode` value, because an image rolled
		 * back to the previous version ignores a column it does not know about,
		 * where a `mode` of 'board' would reach code that renders only 'chat' and
		 * 'code'. Passing the prompt per-turn was the other option and does not
		 * work: a hand-off opens a chat the owner can reply in, so turn two would
		 * arrive without it — and the system prefix would change between turns,
		 * which is the prompt-cache defect buildContext exists to avoid.
		 */
		agentTask: text('agent_task'),
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
		/**
		 * What the person thought of this reply, where they said.
		 *
		 * The one judgement that matters most and the only one the platform could
		 * not see. Across every other table the signals are indirect — the UX audit
		 * infers friction from retries and cancels — so "that answer was wrong" was
		 * a thing a person could know and nothing could record.
		 *
		 * Null is the ordinary case and means nothing was said, not that the reply
		 * was fine. Only ever set on an assistant message; a hidden chat is never
		 * written here at all, so its replies cannot carry one by construction.
		 */
		feedback: text('feedback', { enum: ['up', 'down'] }),
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
	/**
	 * Whether this model accepts being told how hard to think.
	 *
	 * Read from the provider's own listing like `supportsTools`, so a re-sync
	 * corrects it — and read rather than guessed because the cost of guessing
	 * wrong is a 400 on every call to that model.
	 */
	supportsReasoning: integer('supports_reasoning', { mode: 'boolean' })
		.notNull()
		.default(false),
	/**
	 * How hard this model should think, when it can be told.
	 *
	 * `auto` — the default — honours whatever the *job* asks for, which is how
	 * the app's structured-output jobs get low effort without an admin having to
	 * know they exist. The other three override that either way, for a model
	 * whose provider does not advertise its parameters or one an admin has a
	 * view about.
	 *
	 * `off` is deliberately absent. Models with mandatory reasoning reject a
	 * request that tries to disable it outright, so an off switch would be a
	 * setting that breaks some models and there is nothing honest to call it.
	 * `low` is the floor.
	 *
	 * An admin preference, like cacheMode beside it, so a re-sync never undoes a
	 * decision somebody made in the UI.
	 */
	reasoningMode: text('reasoning_mode', { enum: ['auto', 'low', 'medium', 'high'] })
		.notNull()
		.default('auto'),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true)
});

export const CORE_TASKS = [
	'chat',
	'coding',
	'deep-research',
	'visual',
	'vision',
	'memory',
	'skill-optimiser',
	'ux-audit',
	'chat-title',
	'run-summary',
	'subagent',
	'board',
	'alignment',
	'alignment-synthesis',
	'ivory-read',
	'ivory-plan',
	'ivory-synthesise',
	'ivory-redteam'
] as const;
export type CoreTask = (typeof CORE_TASKS)[number];

export const taskConfigs = sqliteTable('task_configs', {
	task: text('task').primaryKey(),
	/**
	 * The resolved prompt, kept in step with `promptOverride` on every boot.
	 *
	 * Nothing reads it any more: `systemPromptFor` resolves
	 * `promptOverride ?? DEFAULT_PROMPTS[task]`. It stays written because this app
	 * updates itself and can be rolled back to the previous image, and that image
	 * reads this column directly. Dropping it in the same release as the code that
	 * stopped using it is exactly what AGENTS.md forbids.
	 */
	systemPrompt: text('system_prompt').notNull().default(''),
	/**
	 * The owner's own prompt for this task, or null to use the shipped default.
	 *
	 * Null is the normal state. Defaults used to be *seeded* into `systemPrompt`,
	 * which froze them at install time: changing a default reached nobody who had
	 * ever booted the app, so every reword needed its predecessor frozen verbatim
	 * in a SUPERSEDED_PROMPTS table and a migration that matched on it. Storing
	 * only the difference from the default removes both.
	 */
	promptOverride: text('prompt_override'),
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
	/**
	 * The pull request opened for this branch, by the button or the agent's
	 * tool. Not stored before, so switching sessions and back put "Open pull
	 * request" over a branch that already had one.
	 */
	prUrl: text('pr_url'),
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
		 *
		 * Superseded by `parentId`, and kept for one release because the old image
		 * still reads it. A doc with a label and no parent groups under that label
		 * as a virtual root; saving it under a real parent is what migrates it.
		 */
		folder: text('folder').notNull().default(''),
		/**
		 * The doc this one sits under. Null is a root.
		 *
		 * There is no folder object: a doc is both the thing you read and the
		 * thing others hang off, because an epic charter *is* the parent of its
		 * sprint records and splitting that across a container row and a content
		 * row means two rows to keep in step for no gain.
		 */
		parentId: text('parent_id'),
		/**
		 * The top of this doc's tree — its own id when it is a root.
		 *
		 * Denormalised because the digest's only question is "roots, and how many
		 * docs under each", and that runs on every chat and coding turn. A
		 * recursive CTE on the hot path is how a change meant to *cut* per-turn
		 * cost ends up adding to it. Reads still COALESCE to the id: a rollback,
		 * rows written by the old image, then an upgrade leaves nulls behind that
		 * the backfill has already run past.
		 */
		rootId: text('root_id'),
		sizeBytes: integer('size_bytes').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Every list is "what may this user see", which is owner or shared.
	(t) => [
		index('library_docs_owner_idx').on(t.ownerId, t.visibility),
		// The tree view's read: one node's children.
		index('library_docs_parent_idx').on(t.parentId),
		// The digest's read: every visible doc grouped by the tree it belongs to.
		index('library_docs_root_idx').on(t.rootId)
	]
);

/**
 * The folders the shelf is made of, keyed by name.
 *
 * The tree shipped with no folder object at all — a doc with children *was* the
 * container — and the top of the shelf then held documents and folders side by
 * side, where a document that was also a heading belonged to neither. Folders
 * came back for the top level only: every doc now sits in one, and nesting
 * below that is still doc-under-doc.
 *
 * Name-keyed rather than a `folder_id` on `library_docs`, because the label on
 * the doc is already the grouping every read path uses — the shelf, the digest
 * on every turn, and an image rolled back to before this table. This row only
 * has to make a folder exist while it is empty, which is the one thing a label
 * on a document cannot do and the reason `New folder` needs it.
 */
export const libraryFolders = sqliteTable(
	'library_folders',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		ownerId: text('owner_id').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Two folders of one name on one shelf are the same folder drawn twice.
	(t) => [uniqueIndex('library_folders_owner_name_idx').on(t.ownerId, t.name)]
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
	/**
	 * Whose skill this is. Null is shared with everyone, which is every skill
	 * written before skills had owners and every one an admin writes or shares.
	 * A skill approved from one person's activity is theirs, because it was
	 * learnt from their conversations.
	 */
	ownerId: text('owner_id'),
	/**
	 * The tasks whose skill index lists it, comma-separated; empty is every
	 * task. A coding agent has no use for the Figma skill's line in its prompt.
	 */
	tasks: text('tasks').notNull().default(''),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

// A person's preferences and patterns, each one signed off by them. Only the
// titles of active items reach a prompt; an agent reads a body on demand.
export const memoryItems = sqliteTable(
	'memory_items',
	{
		id: text('id').primaryKey(),
		// Owner. Nullable so the column can be added without breaking a rollback to
		// an image that inserts without it (expand-migrate-contract); every read
		// filters by owner, so a null row is simply invisible.
		userId: text('user_id'),
		// Facts about a person's world are not memories. Rows written as 'fact'
		// before that may still be stored, and read back as the string they hold.
		kind: text('kind', { enum: ['preference', 'pattern'] }).notNull(),
		/**
		 * What an agent sees in its prompt, a few words long. Empty on rows
		 * written before titles existed, which show the start of their content
		 * instead; the default is what lets the previous image keep inserting.
		 */
		title: text('title').notNull().default(''),
		content: text('content').notNull(),
		source: text('source'),
		status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Reads are always "this user's items, usually the active ones".
	(t) => [index('memory_items_user_status_idx').on(t.userId, t.status)]
);

/**
 * A change to someone's memory that waits for them to sign it off.
 *
 * The audit, consolidation and the rebuild only ever write here. Nothing
 * reaches `memory_items` until its owner approves the proposal, and a rejected
 * one stays as the record that tells later audits not to propose it again.
 */
export const memoryProposals = sqliteTable(
	'memory_proposals',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		action: text('action', { enum: ['add', 'update', 'retire'] }).notNull(),
		/** The memory an update or retirement is about; null for an addition. */
		itemId: text('item_id'),
		kind: text('kind', { enum: ['preference', 'pattern'] }),
		title: text('title').notNull().default(''),
		content: text('content').notNull().default(''),
		/** The agent's reason, shown beside the proposal. */
		why: text('why').notNull().default(''),
		status: text('status', { enum: ['pending', 'approved', 'rejected'] })
			.notNull()
			.default('pending'),
		source: text('source'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		decidedAt: integer('decided_at', { mode: 'timestamp_ms' })
	},
	(t) => [index('memory_proposals_user_status_idx').on(t.userId, t.status)]
);

/**
 * One claim about a person or their world: "Works at Acme", "Vegetarian".
 *
 * The bounds live in code (profile.ts) rather than in the schema, because a
 * CHECK in SQLite means rebuilding the table to change one. Every column the
 * previous image would never write is nullable or defaulted, and it never
 * writes this table at all.
 *
 * Opaque ids rather than ones that spell the path ("wrk.tools.0012" was the
 * draft): an entry moved to another subdomain would otherwise carry an id that
 * names the wrong place, and an agent cites ids back when it corrects one.
 */
export const profileEntries = sqliteTable(
	'profile_entries',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		domain: text('domain', {
			enum: ['identity', 'work', 'people', 'life', 'interests']
		}).notNull(),
		/** A seed, a custom subdomain this person approved, or under `people` an entity id. */
		subdomain: text('subdomain').notNull(),
		/** The entity the claim is about, wherever it is filed. */
		about: text('about'),
		kind: text('kind', { enum: ['fact', 'preference', 'constraint', 'goal'] }).notNull(),
		claim: text('claim').notNull(),
		/** In the brief every agent sees. The person's choice, held to a char budget. */
		pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
		sensitivity: text('sensitivity', { enum: ['normal', 'personal', 'private'] })
			.notNull()
			.default('normal'),
		source: text('source', { enum: ['stated', 'survey', 'inferred', 'imported'] }).notNull(),
		/**
		 * The person's own words the claim rests on, and the message they came
		 * from. A claim with a quote cannot have come from a fetched page, which
		 * is what replaced the draft's `tainted` flag: nearly every chat has web
		 * content in it, so a flag for that would have been set on everything.
		 */
		quote: text('quote'),
		messageId: text('message_id'),
		/** Set for what is true for now ("moving house by November"). At most 90 days out. */
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
		/**
		 * A correction supersedes rather than overwrites, so the page can show
		 * what changed. Agents only ever see `active`.
		 */
		status: text('status', { enum: ['active', 'superseded', 'expired'] })
			.notNull()
			.default('active'),
		supersedes: text('supersedes'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		/** When the person last said it is still true; creation counts. */
		confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }).notNull()
	},
	// Every read is "this person's active entries, in some part of the tree".
	(t) => [index('profile_entries_user_status_path_idx').on(t.userId, t.status, t.domain, t.subdomain)]
);

/**
 * The named things a profile's claims are about: people, pets, organisations,
 * projects, places.
 *
 * Their own rows because a claim filed under life ("does the school run on
 * Tuesdays") is still about Nikau, and a lookup for Nikau should find it. A
 * relation-named subdomain (`people/family`) could not do that, and would
 * have put a son and a dog in one bucket.
 */
export const profileEntities = sqliteTable(
	'profile_entities',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		kind: text('kind', {
			enum: ['person', 'pet', 'organisation', 'project', 'place']
		}).notNull(),
		name: text('name').notNull(),
		/** Lower-cased name, so "Aroha" and "aroha" cannot both exist. */
		nameKey: text('name_key').notNull(),
		aka: text('aka', { mode: 'json' }).$type<string[]>().notNull().default([]),
		/** "partner", "son", "employer". Never an age, which goes stale; a birth year is a claim. */
		relation: text('relation').notNull().default(''),
		/** On the names line agents see. */
		named: integer('named', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [uniqueIndex('profile_entities_user_name_idx').on(t.userId, t.nameKey)]
);

/**
 * Subdomains a person added beyond the seeds, which live in code. Without a
 * row here a path outside the seeds does not exist, so a model cannot invent
 * one by writing to it.
 */
export const profileSubdomains = sqliteTable(
	'profile_subdomains',
	{
		userId: text('user_id').notNull(),
		domain: text('domain', {
			enum: ['identity', 'work', 'people', 'life', 'interests']
		}).notNull(),
		name: text('name').notNull(),
		sensitivity: text('sensitivity', { enum: ['normal', 'personal', 'private'] })
			.notNull()
			.default('normal'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [primaryKey({ columns: [t.userId, t.domain, t.name] })]
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
	/** As on `skills`: the tasks it is for, comma-separated, empty for all. */
	tasks: text('tasks').notNull().default(''),
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

export const mcpTools = sqliteTable(
	'mcp_tools',
	{
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
	},
	// Tools are always looked up a server at a time — listing one server's tools,
	// and replacing them wholesale on a sync.
	(t) => [index('mcp_tools_server_idx').on(t.serverId)]
);

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
		/**
		 * Completion tokens the model spent thinking rather than answering.
		 *
		 * Part of `completion_tokens`, not additional to it — broken out because
		 * the two together are the difference between a job that writes a lot and
		 * a job that deliberates a lot, and only the second is usually a fault.
		 * Zero also covers "the provider never broke it out", which is the honest
		 * reading for a row written before this column existed.
		 */
		reasoningTokens: integer('reasoning_tokens').notNull().default(0),
		costUsd: real('cost_usd'),
		status: text('status', { enum: ['ok', 'error'] }).notNull()
	},
	(t) => [
		index('usage_log_ts_idx').on(t.ts),
		index('usage_log_user_ts_idx').on(t.userId, t.ts),
		// Hiding or deleting a chat anonymises its rows here rather than removing
		// them — the spend stays, the identifier goes (see purgeChatTrail). Without
		// this that update scanned the whole table, on a table that now grows a row
		// per model call rather than one per turn.
		index('usage_log_chat_idx').on(t.chatId)
	]
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
		/**
		 * The repository a coding session filed this card against, so the card can
		 * be started as a coding session on that repository. Null for every card
		 * filed any other way.
		 */
		repoUrl: text('repo_url'),
		/** Set when the card reaches a done status; archived cards leave the board. */
		archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	// The board view reads one board's live cards in lane order; the archive
	// reads the same board's archived ones newest first.
	(t) => [
		index('cards_board_lane_idx').on(t.boardId, t.laneId, t.position),
		index('cards_board_archived_idx').on(t.boardId, t.archivedAt),
		// Positioning reads and writes a lane without knowing its board —
		// nextPosition, reposition and renumber all filter on lane_id alone, and
		// the composite above cannot serve them because board_id leads it.
		index('cards_lane_idx').on(t.laneId),
		// Deleting a status or a project unsets it across every card that used it.
		index('cards_status_idx').on(t.statusId),
		index('cards_project_idx').on(t.projectId)
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
		index('ux_ideas_fingerprint_idx').on(t.fingerprint),
		// Same reason as the change log: the prune filters on age with no status.
		index('ux_ideas_created_idx').on(t.createdAt)
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
