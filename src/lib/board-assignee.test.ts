import { describe, expect, it } from 'vitest';
import { EVERYONE, UNASSIGNED, matchesAssignee, resolveAssignee } from './board-types';

const card = (assignedTo: string | null) => ({ assignedTo });

describe('matchesAssignee', () => {
	it('shows everything when nobody is selected', () => {
		expect(matchesAssignee(card('alice'), EVERYONE)).toBe(true);
		expect(matchesAssignee(card(null), EVERYONE)).toBe(true);
	});

	it('shows one person their own cards', () => {
		expect(matchesAssignee(card('alice'), 'alice')).toBe(true);
		expect(matchesAssignee(card('bob'), 'alice')).toBe(false);
	});

	it('hides unassigned cards from a person filter', () => {
		// The point of filtering by a person is to see their work, and a card
		// nobody has picked up is not theirs.
		expect(matchesAssignee(card(null), 'alice')).toBe(false);
	});

	it('can show exactly the cards nobody has picked up', () => {
		// Without this they are unreachable the moment you filter by a person.
		expect(matchesAssignee(card(null), UNASSIGNED)).toBe(true);
		expect(matchesAssignee(card('alice'), UNASSIGNED)).toBe(false);
	});

	it('does not confuse the unassigned marker with a username', () => {
		expect(matchesAssignee(card('unassigned'), UNASSIGNED)).toBe(false);
	});
});

describe('resolveAssignee', () => {
	const members = [{ userId: 'alice' }, { userId: 'bob' }];

	it('restores a filter naming someone still on the board', () => {
		expect(resolveAssignee('bob', members)).toBe('bob');
	});

	it('falls back to everyone when that person has left', () => {
		// Otherwise the board comes up empty with nothing saying why.
		expect(resolveAssignee('carol', members)).toBe(EVERYONE);
	});

	it('keeps the unassigned filter, which belongs to no member', () => {
		expect(resolveAssignee(UNASSIGNED, members)).toBe(UNASSIGNED);
	});

	it('treats nothing stored as everyone', () => {
		expect(resolveAssignee(null, members)).toBe(EVERYONE);
		expect(resolveAssignee('', members)).toBe(EVERYONE);
	});

	it('falls back when the board has no members to check against', () => {
		expect(resolveAssignee('alice', [])).toBe(EVERYONE);
	});
});
