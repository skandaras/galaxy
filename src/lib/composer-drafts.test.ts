import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Run as a browser with a real-looking sessionStorage, because what matters is
 * what reaches storage: a hidden chat's draft must not, and a draft moved from
 * the "new" placeholder onto the chat that sending created must.
 */
vi.mock('$app/environment', () => ({ browser: true }));

const store = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k)
});

const { clearDraft, draftKey, getDraft, renameDraft, setDraft } = await import(
	'./composer-drafts.svelte'
);

const stored = () => JSON.parse(store.get('galaxy:composer-drafts') ?? '{}');

describe('composer drafts', () => {
	beforeEach(() => {
		for (const key of Object.keys(stored())) clearDraft(key);
	});

	it('keys a draft by mode and chat, with a placeholder for one not made yet', () => {
		expect(draftKey('chat', 'abc')).toBe('chat:abc');
		expect(draftKey('code', null)).toBe('code:new');
	});

	it('keeps text per thread and stores it', () => {
		setDraft('chat:a', 'first');
		setDraft('chat:b', 'second');
		expect(getDraft('chat:a')).toBe('first');
		expect(stored()).toEqual({ 'chat:a': 'first', 'chat:b': 'second' });
	});

	it('never stores a hidden chat draft, though it is kept while the page lives', () => {
		setDraft('chat:h', 'secret', { ephemeral: true });
		expect(getDraft('chat:h')).toBe('secret');
		expect(stored()).not.toHaveProperty('chat:h');
	});

	it('takes a draft back out of storage when its chat becomes hidden', () => {
		// Re-stashing on the flip is what evicts text typed while it was visible.
		setDraft('chat:x', 'typed while visible');
		setDraft('chat:x', 'typed while visible', { ephemeral: true });
		expect(stored()).not.toHaveProperty('chat:x');
	});

	it('moves the placeholder draft onto the chat that sending created', () => {
		setDraft('chat:new', 'half a thought');
		renameDraft('chat:new', 'chat:c1');
		expect(getDraft('chat:new')).toBe('');
		expect(getDraft('chat:c1')).toBe('half a thought');
		expect(stored()).toEqual({ 'chat:c1': 'half a thought' });
	});

	it('keeps a hidden draft hidden when it moves', () => {
		setDraft('chat:new', 'still secret', { ephemeral: true });
		renameDraft('chat:new', 'chat:c2');
		expect(getDraft('chat:c2')).toBe('still secret');
		expect(stored()).not.toHaveProperty('chat:c2');
	});

	it('drops a draft emptied by the person', () => {
		setDraft('chat:a', 'text');
		setDraft('chat:a', '');
		expect(stored()).not.toHaveProperty('chat:a');
	});
});
