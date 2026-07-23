import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import { chats, messages, attachments, type AttachmentRef } from '$lib/server/db/schema';

export interface ChatMeta {
	id: string;
	userId: string;
	mode: 'chat' | 'code';
	title: string;
	hidden: boolean;
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

export function listChats(userId: string): ChatMeta[] {
	const persisted = db
		.select()
		.from(chats)
		.where(eq(chats.userId, userId))
		.orderBy(desc(chats.updatedAt))
		.all()
		.map(rowToMeta);
	const hidden = [...hiddenChats.values()]
		.filter((h) => h.meta.userId === userId)
		.map((h) => h.meta);
	return [...hidden, ...persisted].sort((a, b) => b.updatedAt - a.updatedAt);
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

function countMessages(chatId: string): number {
	return db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId)).all()
		.length;
}

export function updateChat(
	chatId: string,
	patch: Partial<Pick<ChatMeta, 'title' | 'compactSummary' | 'compactedUpTo'>>
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
				files.set(att.id, { name: att.name, mime: att.mime, dataUrl: `data:${att.mime};base64,${b64}` });
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
		const saved = saveAttachmentFile(chatId, attId, file.name, file.mime, dataUrlToBuffer(file.dataUrl));
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
	file: { name: string; mime: string; data: Buffer }
): AttachmentRef {
	const id = randomUUID();
	const hidden = hiddenChats.get(chatId);
	if (hidden) {
		hidden.attachments.set(id, {
			name: file.name,
			mime: file.mime,
			dataUrl: `data:${file.mime};base64,${file.data.toString('base64')}`
		});
		return { id, name: file.name, mime: file.mime };
	}
	const saved = saveAttachmentFile(chatId, id, file.name, file.mime, file.data);
	db.insert(attachments).values(saved).run();
	return { id, name: file.name, mime: file.mime };
}

/** Resolve an attachment to a data URL for vision model input. */
export function attachmentDataUrl(chatId: string, attId: string): string | null {
	const hidden = hiddenChats.get(chatId);
	if (hidden) return hidden.attachments.get(attId)?.dataUrl ?? null;
	const row = db.select().from(attachments).where(eq(attachments.id, attId)).get();
	if (!row || row.chatId !== chatId || !existsSync(row.path)) return null;
	return `data:${row.mime};base64,${readFileSync(row.path).toString('base64')}`;
}

function saveAttachmentFile(chatId: string, id: string, name: string, mime: string, data: Buffer) {
	const dir = uploadsDir(chatId);
	mkdirSync(dir, { recursive: true });
	const safeName = name.replace(/[^\w.-]/g, '_').slice(0, 80);
	const path = join(dir, `${id}-${safeName}`);
	writeFileSync(path, data);
	return { id, chatId, name, mime, size: data.length, path, createdAt: new Date() };
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
		compactSummary: row.compactSummary,
		compactedUpTo: row.compactedUpTo,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime()
	};
}
