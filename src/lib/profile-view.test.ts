import { describe, expect, it } from 'vitest';
import {
	briefUsage,
	entryMarks,
	pathOptions,
	placeLabel,
	learnedWords,
	readingText
} from './profile-view';

describe('pathOptions', () => {
	it('offers every subdomain, and a person’s card by their name', () => {
		expect(
			pathOptions([
				{ domain: 'work', subdomains: [{ name: 'tools', label: 'tools', entries: [] }] },
				{ domain: 'people', subdomains: [{ name: 'k3j9x2ab', label: 'Aroha', entries: [] }] }
			])
		).toEqual([
			{ value: 'work/tools', label: 'work / tools' },
			{ value: 'people/Aroha', label: 'people / Aroha' }
		]);
	});
});

describe('briefUsage', () => {
	it('says how much of the brief is used and never reads past full', () => {
		expect(briefUsage(975, 2400)).toEqual({ text: 'Brief: 975 of 2,400 characters', full: 975 / 2400 });
		expect(briefUsage(3000, 2400).full).toBe(1);
	});
});

describe('entryMarks', () => {
	it('names what is unusual about an entry and nothing else', () => {
		expect(entryMarks({ pinned: false, sensitivity: 'normal', source: 'stated', expiresAt: null })).toEqual([]);
		expect(
			entryMarks({ pinned: true, sensitivity: 'private', source: 'inferred', expiresAt: '2026-11-01T00:00:00.000Z' })
		).toEqual(['always in brief', 'private', 'inferred', 'until 2026-11-01']);
	});
});

describe('learnedWords', () => {
	it('says what each kind of learned change is called, and what undoing it reports', () => {
		expect(learnedWords('add')).toEqual({ badge: 'New', undo: 'Undo', done: 'Taken back. It will not be learned again.' });
		expect(learnedWords('update')).toEqual({ badge: 'Changed', undo: 'Undo', done: 'Put back as it was.' });
		expect(learnedWords('retire')).toEqual({ badge: 'Retired', undo: 'Bring it back', done: 'Back in your profile.' });
		expect(placeLabel('people/Nikau')).toBe('people / Nikau');
	});
});

describe('readingText', () => {
	const r = { running: true, done: 2, total: 5, learned: 3, failed: 0 };
	it('follows a reading, and says nothing once one ends well', () => {
		expect(readingText(r)).toEqual({
			text: 'Reading your past conversations: 2 of 5 batches, 3 learned so far.',
			error: false
		});
		expect(readingText({ ...r, running: false, done: 5 })).toBeNull();
		expect(readingText(null)).toBeNull();
	});

	it('says why one stopped, and how much of it could not be read', () => {
		expect(readingText({ ...r, running: false, stopped: 'the spending cap was reached', failed: 1 })?.text).toBe(
			'The last reading stopped early: the spending cap was reached, and 1 of its 5 batches could not be read.'
		);
	});
});
