import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import { chats, messages, attachments, type AttachmentRef } from '$lib/server/db/schema';

export interface ChatMeta {
	id: string;
	userId: string;
	mode: 'chat' | 'code';
	title: string;
	hidden: boolean;
	/** Model last used in this chat; null until a turn runs. */
	modelId: string | null;
	/** True once a human has named it, which stops the auto-titler. */
	titleCustom: boolean;
	/** When it was archived, or null while active. */
	archivedAt: number | null;
	compactSummary: string | null;
	compactedUpTo: number;
	createdAt: number;
	updatedAt: number;
}

export interface StoredMessage {
	id: string;
	chatId: string;
	seq: number;
	role: 'user' | 'assistant' | 'tool';
	content: string;
	attachments: AttachmentRef[] | null;
	modelKey: string | null;
	createdAt: number;
}

interface HiddenAttachment {
	name: string;
	mime: string;
	dataUrl: string;
	kind: 'image' | 'document';
	text: string;
}

interface HiddenChat {
	meta: ChatMeta;
	messages: StoredMessage[];
	attachments: Map<string, HiddenAttachment>;
}

// Hidden chats never touch the DB or disk: they live here, are visible only
// to their owner for the lifetime of the process, and are excluded from
// memory consolidation by construction.
const hiddenChats = new Map<string, HiddenChat>();

function uploadsDir(chatId: string): string {
	return join(dataDir, 'uploads', chatId);
}

/** Active chats only. Archived ones are still readable — see listArchivedChats. */
export function listChats(userId: string): ChatMeta[] {
	const persisted = db
		.select()
		.from(chats)
		.where(and(eq(chats.userId, userId), isNull(chats.archivedAt)))
		.orderBy(desc(chats.updatedAt))
		.all()
		.map(rowToMeta);
	const hidden = [...hiddenChats.values()]
		.filter((h) => h.meta.userId === userId && !h.meta.archivedAt)
		.map((h) => h.meta);
	return [...hidden, ...persisted].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Archived chats, most recently archived first.
 *
 * Archiving is not deletion and not hiding: the chat keeps its messages, still
 * opens by id, and still counts as context for the memory agent. It is only out
 * of the way.
 */
export function listArchivedChats(userId: string): ChatMeta[] {
	const persisted = db
		.select()
		.from(chats)
		.where(and(eq(chats.userId, userId), isNotNull(chats.archivedAt)))
		// id as a tie-break: archiving two chats in quick succession stamps them
		// in the same millisecond, and without it their order reshuffles between
		// identical queries (same reason listMemoryItems does this).
		.orderBy(desc(chats.archivedAt), chats.id)
		.all()
		.map(rowToMeta);
	const hidden = [...hiddenChats.values()]
		.filter((h) => h.meta.userId === userId && h.meta.archivedAt)
		.map((h) => h.meta);
	return [...hidden, ...persisted].sort(
		(a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.id.localeCompare(b.id)
	);
}

/** Move a chat in or out of the archive. Returns null when it isn't the caller's. */
export function setArchived(chatId: string, userId: string, archived: boolean): ChatMeta | null {
	const meta = getChat(chatId, userId);
	if (!meta) return null;
	const archivedAt = archived ? Date.now() : null;

	const hidden = hiddenChats.get(chatId);
	if (hidden) {
		hidden.meta.archivedAt = archivedAt;
		return hidden.meta;
	}
	db.update(chats)
		.set({ archivedAt: archivedAt ? new Date(archivedAt) : null })
		.where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
		.run();
	return getChat(chatId, userId);
}

export function getChat(id: string, userId: string): ChatMeta | null {
	const hidden = hiddenChats.get(id);
	if (hidden) return hidden.meta.userId === userId ? hidden.meta : null;
	const row = db
		.select()
		.from(chats)
		.where(and(eq(chats.id, id), eq(chats.userId, userId)))
		.get();
	return row ? rowToMeta(row) : null;
}

export function createChat(opts: {
	userId: string;
	mode?: 'chat' | 'code';
	hidden?: boolean;
	title?: string;
}): ChatMeta {
	const now = Date.now();
	const meta: ChatMeta = {
		id: randomUUID(),
		userId: opts.userId,
		mode: opts.mode ?? 'chat',
		title: opts.title ?? 'New chat',
		hidden: opts.hidden ?? false,
		modelId: null,
		/**
		 * A chat created with a title was named on purpose — after the repository
		 * for a coding session, after the card for a board hand-off — so the
		 * auto-titler must leave it alone. Without this it renamed them on the
		 * first reply, which is how "Card: Book plumber" became a generic summary.
		 */
		titleCustom: !!opts.title,
		archivedAt: null,
		compactSummary: null,
		compactedUpTo: 0,
		createdAt: now,
		updatedAt: now
	};
	if (meta.hidden) {
		hiddenChats.set(meta.id, { meta, messages: [], attachments: new Map() });
	} else {
		db.insert(chats)
			.values({
				id: meta.id,
				userId: meta.userId,
				mode: meta.mode,
				title: meta.title,
				titleCustom: meta.titleCustom,
				createdAt: new Date(now),
				updatedAt: new Date(now)
			})
			.run();
	}
	return meta;
}

export function getMessages(chatId: string): StoredMessage[] {
	const hidden = hiddenChats.get(chatId);
	if (hidden) return [...hidden.messages];
	return db
		.select()
		.from(messages)
		.where(eq(messages.chatId, chatId))
		.orderBy(asc(messages.seq))
		.all()
		.map((r) => ({ ...r, createdAt: r.createdAt.getTime(), attachments: r.attachments ?? null }));
}

export function appendMessage(
	chatId: string,
	msg: {
		role: 'user' | 'assistant' | 'tool';
		content: string;
		attachments?: AttachmentRef[];
		modelKey?: string;
	}
): StoredMessage {
	const now = Date.now();
	const hidden = hiddenChats.get(chatId);
	const seq = hidden ? hidden.messages.length : countMessages(chatId);
	const stored: StoredMessage = {
		id: randomUUID(),
		chatId,
		seq,
		role: msg.role,
		content: msg.content,
		attachments: msg.attachments ?? null,
		modelKey: msg.modelKey ?? null,
		createdAt: now
	};
	if (hidden) {
		hidden.messages.push(stored);
		hidden.meta.updatedAt = now;
	} else {
		db.insert(messages)
			.values({ ...stored, createdAt: new Date(now) })
			.run();
		db.update(chats).set({ updatedAt: new Date(now) }).where(eq(chats.id, chatId)).run();
	}
	return stored;
}

/**
 * Amend a message already written.
 *
 * Used for one thing: replacing the stand-in reply a cut-short coding leg
 * saves with the real leg summary once that arrives. The summary is off the
 * critical path by design, so it lands after the message is already stored and
 * on screen — and callers must only ever aim this at a stand-in they wrote
 * themselves (see TurnSummary.fallbackReply), never at what a model said.
 */
export function updateMessage(
	chatId: string,
	messageId: string,
	patch: { content: string }
): void {
	const hidden = hiddenChats.get(chatId);
	if (hidden) {
		const msg = hidden.messages.find((m) => m.id === messageId);
		if (msg) msg.content = patch.content;
		return;
	}
	db.update(messages)
		.set({ content: patch.content })
		.where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)))
		.run();
}

function countMessages(chatId: string): number {
	return db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId)).all()
		.length;
}

export function updateChat(
	chatId: string,
	patch: Partial<
		Pick<ChatMeta, 'title' | 'titleCustom' | 'modelId' | 'compactSummary' | 'compactedUpTo'>
	>
): void {
	const hidden = hiddenChats.get(chatId);
	if (hidden) {
		Object.assign(hidden.meta, patch, { updatedAt: Date.now() });
		return;
	}
	db.update(chats)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(chats.id, chatId))
		.run();
}

/**
 * Flip a chat's Hidden state. visible→hidden pulls every trace out of the DB
 * (rows and uploaded files) into memory; hidden→visible persists it.
 */
export function setHidden(chatId: string, userId: string, hidden: boolean): ChatMeta | null {
	const meta = getChat(chatId, userId);
	if (!meta || meta.hidden === hidden) return meta;

	if (hidden) {
		const msgs = getMessages(chatId);
		const files = new Map<string, HiddenAttachment>();
		for (const att of db.select().from(attachments).where(eq(attachments.chatId, chatId)).all()) {
			if (existsSync(att.path)) {
				const b64 = readFileSync(att.path).toString('base64');
				files.set(att.id, {
					name: att.name,
					mime: att.mime,
					dataUrl: `data:${att.mime};base64,${b64}`,
					kind: att.kind,
					text: att.extractedText ?? ''
				});
			}
		}
		const newMeta: ChatMeta = { ...meta, hidden: true, updatedAt: Date.now() };
		hiddenChats.set(chatId, { meta: newMeta, messages: msgs, attachments: files });
		db.delete(messages).where(eq(messages.chatId, chatId)).run();
		db.delete(attachments).where(eq(attachments.chatId, chatId)).run();
		db.delete(chats).where(eq(chats.id, chatId)).run();
		rmSync(uploadsDir(chatId), { recursive: true, force: true });
		return newMeta;
	}

	const record = hiddenChats.get(chatId);
	if (!record) return meta;
	const now = Date.now();
	db.insert(chats)
		.values({
			id: record.meta.id,
			userId: record.meta.userId,
			mode: record.meta.mode,
			title: record.meta.title,
			modelId: record.meta.modelId,
			compactSummary: record.meta.compactSummary,
			compactedUpTo: record.meta.compactedUpTo,
			createdAt: new Date(record.meta.createdAt),
			updatedAt: new Date(now)
		})
		.run();
	for (const m of record.messages) {
		db.insert(messages)
			.values({ ...m, createdAt: new Date(m.createdAt) })
			.run();
	}
	for (const [attId, file] of record.attachments) {
		const saved = saveAttachmentFile(
			chatId,
			attId,
			file.name,
			file.mime,
			dataUrlToBuffer(file.dataUrl),
			file.kind,
			file.text
		);
		db.insert(attachments).values(saved).run();
	}
	hiddenChats.delete(chatId);
	return { ...record.meta, hidden: false, updatedAt: now };
}

export function deleteChat(chatId: string, userId: string): boolean {
	const meta = getChat(chatId, userId);
	if (!meta) return false;
	if (hiddenChats.has(chatId)) {
		hiddenChats.delete(chatId);
		return true;
	}
	db.delete(messages).where(eq(messages.chatId, chatId)).run();
	db.delete(attachments).where(eq(attachments.chatId, chatId)).run();
	db.delete(chats).where(eq(chats.id, chatId)).run();
	rmSync(uploadsDir(chatId), { recursive: true, force: true });
	return true;
}

// --- attachments -----------------------------------------------------------

export function addAttachment(
	chatId: string,
	file: {
		name: string;
		mime: string;
		data: Buffer;
		kind?: 'image' | 'document';
		text?: string;
	}
): AttachmentRef {
	const id = randomUUID();
	const kind = file.kind ?? 'image';
	const text = file.text ?? '';
	const ref: AttachmentRef = { id, name: file.name, mime: file.mime, kind, textChars: text.length };
	const hidden = hiddenChats.get(chatId);
	if (hidden) {
		hidden.attachments.set(id, {
			name: file.name,
			mime: file.mime,
			dataUrl: `data:${file.mime};base64,${file.data.toString('base64')}`,
			kind,
			text
		});
		return ref;
	}
	const saved = saveAttachmentFile(chatId, id, file.name, file.mime, file.data, kind, text);
	db.insert(attachments).values(saved).run();
	return ref;
}

/** Resolve an attachment to a data URL for vision model input. */
export function attachmentDataUrl(chatId: string, attId: string): string | null {
	const hidden = hiddenChats.get(chatId);
	if (hidden) return hidden.attachments.get(attId)?.dataUrl ?? null;
	const row = db.select().from(attachments).where(eq(attachments.id, attId)).get();
	if (!row || row.chatId !== chatId || !existsSync(row.path)) return null;
	return `data:${row.mime};base64,${readFileSync(row.path).toString('base64')}`;
}

/** The text extracted from a document attachment at upload time. */
export function attachmentText(chatId: string, attId: string): string | null {
	const hidden = hiddenChats.get(chatId);
	if (hidden) return hidden.attachments.get(attId)?.text ?? null;
	const row = db.select().from(attachments).where(eq(attachments.id, attId)).get();
	if (!row || row.chatId !== chatId) return null;
	return row.extractedText ?? null;
}

export interface AttachmentSummary {
	id: string;
	name: string;
	mime: string;
	kind: 'image' | 'document';
	textChars: number;
}

/** Every attachment on a chat, for the list_attachments tool. */
export function listAttachments(chatId: string): AttachmentSummary[] {
	const hidden = hiddenChats.get(chatId);
	if (hidden) {
		return [...hidden.attachments].map(([id, a]) => ({
			id,
			name: a.name,
			mime: a.mime,
			kind: a.kind,
			textChars: a.text.length
		}));
	}
	return db
		.select()
		.from(attachments)
		.where(eq(attachments.chatId, chatId))
		.all()
		.map((r) => ({
			id: r.id,
			name: r.name,
			mime: r.mime,
			kind: r.kind,
			textChars: r.textChars
		}));
}

function saveAttachmentFile(
	chatId: string,
	id: string,
	name: string,
	mime: string,
	data: Buffer,
	kind: 'image' | 'document' = 'image',
	text = ''
) {
	const dir = uploadsDir(chatId);
	mkdirSync(dir, { recursive: true });
	const safeName = name.replace(/[^\w.-]/g, '_').slice(0, 80);
	const path = join(dir, `${id}-${safeName}`);
	writeFileSync(path, data);
	return {
		id,
		chatId,
		name,
		mime,
		size: data.length,
		path,
		kind,
		extractedText: text || null,
		textChars: text.length,
		createdAt: new Date()
	};
}

function dataUrlToBuffer(dataUrl: string): Buffer {
	return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

function rowToMeta(row: typeof chats.$inferSelect): ChatMeta {
	return {
		id: row.id,
		userId: row.userId,
		mode: row.mode,
		title: row.title,
		hidden: false,
		modelId: row.modelId,
		titleCustom: row.titleCustom,
		archivedAt: row.archivedAt?.getTime() ?? null,
		compactSummary: row.compactSummary,
		compactedUpTo: row.compactedUpTo,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime()
	};
}
