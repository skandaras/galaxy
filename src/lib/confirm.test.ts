import { describe, expect, it } from 'vitest';
import { ask, question } from './confirm.svelte';

describe('ask', () => {
	it('holds the question until it is answered, then clears it', async () => {
		const answer = ask({ title: 'Delete "Q3 plan"?', confirm: 'Delete document', danger: true });
		expect(question.current?.confirm).toBe('Delete document');
		question.answer(true);
		await expect(answer).resolves.toBe(true);
		expect(question.current).toBeNull();
	});

	it('resolves false on cancel', async () => {
		const answer = ask({ title: 'Remove this attachment?', confirm: 'Remove' });
		question.answer(false);
		await expect(answer).resolves.toBe(false);
	});

	it('refuses a question that a newer one replaced', async () => {
		// Nobody saw the first one through to an answer, so it must not go ahead.
		const first = ask({ title: 'Delete A?', confirm: 'Delete' });
		const second = ask({ title: 'Delete B?', confirm: 'Delete' });
		await expect(first).resolves.toBe(false);
		expect(question.current?.title).toBe('Delete B?');
		question.answer(true);
		await expect(second).resolves.toBe(true);
	});

	it('ignores an answer when nothing is being asked', () => {
		expect(() => question.answer(true)).not.toThrow();
		expect(question.current).toBeNull();
	});
});
