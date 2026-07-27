import { browser } from '$app/environment';

/**
 * Unsent composer text, kept outside the page components so it survives
 * client-side navigation (Chat → Settings → back) as well as a reload.
 *
 * Keys are `<mode>:<chatId>`, with `new` standing in for a conversation that
 * has not been created yet, so a New Chat draft and each existing chat's
 * draft are independent in both modes.
 */
const STORAGE_KEY = 'galaxy:composer-drafts';

const drafts = $state<Record<string, string>>(browser ? load() : {});

function load(): Record<string, string> {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== 'object') return {};
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				([, v]) => typeof v === 'string' && v !== ''
			)
		) as Record<string, string>;
	} catch {
		return {};
	}
}

/**
 * Hidden chats are memory-only by design, so their drafts never reach
 * storage; this set tracks the keys to skip when persisting.
 */
const ephemeralKeys = new Set<string>();

function persist(): void {
	if (!browser) return;
	try {
		const storable = Object.fromEntries(
			Object.entries(drafts).filter(([k, v]) => v !== '' && !ephemeralKeys.has(k))
		);
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(storable));
	} catch {
		// Private-mode or quota failures must not break typing.
	}
}

export function draftKey(mode: 'chat' | 'code', chatId: string | null | undefined): string {
	return `${mode}:${chatId ?? 'new'}`;
}

export function getDraft(key: string): string {
	return drafts[key] ?? '';
}

export function setDraft(key: string, value: string, options?: { ephemeral?: boolean }): void {
	if (options?.ephemeral) ephemeralKeys.add(key);
	else ephemeralKeys.delete(key);

	if (value === '') delete drafts[key];
	else drafts[key] = value;
	persist();
}

export function clearDraft(key: string): void {
	delete drafts[key];
	ephemeralKeys.delete(key);
	persist();
}

/**
 * Move a draft written against the `new` placeholder onto the real chat id,
 * for the case where sending is what creates the conversation.
 */
export function renameDraft(from: string, to: string): void {
	const value = drafts[from];
	if (value === undefined) return;
	delete drafts[from];
	drafts[to] = value;
	if (ephemeralKeys.delete(from)) ephemeralKeys.add(to);
	persist();
}
