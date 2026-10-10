import { describe, expect, it } from 'vitest';
import { briefUsage, entryMarks, pathOptions } from './profile-view';

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
		).toEqual(['pinned', 'private', 'inferred', 'until 2026-11-01']);
	});
});
