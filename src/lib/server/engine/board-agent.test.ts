import { describe, expect, it } from 'vitest';
import { cardCodingBrief } from './board-agent';

describe('cardCodingBrief', () => {
	const card = {
		id: 'card-123',
		title: 'Boss fight: Aquamentus',
		description: 'Add the level 1 boss. Done when it has three attack patterns. Plan: docs/epics/zelda.md'
	};

	it('carries the card id, so the session can write back to the card', () => {
		const brief = cardCodingBrief(card);
		expect(brief).toContain('card-123');
		expect(brief).toContain('card_comment');
		expect(brief).toContain('card_update');
	});

	it('hands over the card as written', () => {
		const brief = cardCodingBrief(card);
		expect(brief).toContain('## Boss fight: Aquamentus');
		expect(brief).toContain('docs/epics/zelda.md');
	});

	it('says so when the card has no description', () => {
		expect(cardCodingBrief({ ...card, description: '' })).toContain('No description was written');
	});
});
