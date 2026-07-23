import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateContextTokens } from './compaction';

describe('token estimation', () => {
	it('estimates ~4 chars per token', () => {
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('abcd')).toBe(1);
		expect(estimateTokens('a'.repeat(400))).toBe(100);
	});

	it('sums system prompt and message overheads', () => {
		const total = estimateContextTokens('sys!', [{ content: 'abcd' }, { content: 'efgh' }]);
		// 1 (system) + (1 + 4) + (1 + 4)
		expect(total).toBe(11);
	});
});
