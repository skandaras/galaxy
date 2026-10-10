import { describe, expect, it } from 'vitest';
import { draftPaths, draftProblems, emptyDraft, mergeDrafts, type Draft, type DraftEntry } from './profile-draft';

const line = (over: Partial<DraftEntry> & { claim: string }): DraftEntry => ({
	path: 'work/tools',
	kind: 'fact',
	pinned: false,
	until: null,
	about: null,
	sensitivity: null,
	...over
});

describe('mergeDrafts', () => {
	it('keeps everything from both, and someone named in both once', () => {
		const a: Draft = { ...emptyDraft(), people: [{ name: 'Aroha', kind: 'person', relation: 'partner', aka: [] }], entries: [line({ claim: 'Uses Neovim daily.' })] };
		const b: Draft = {
			people: [{ name: 'aroha', kind: 'person', relation: '', aka: [] }, { name: 'Pip', kind: 'pet', relation: 'dog', aka: [] }],
			entries: [line({ claim: 'Uses Docker at work.' })],
			notCarried: ['Prefers bullet points.'],
			leftOut: ['1 line was left out.']
		};
		const merged = mergeDrafts(a, b);
		expect(merged.people.map((p) => p.name)).toEqual(['Aroha', 'Pip']);
		expect(merged.entries).toHaveLength(2);
		expect(merged.notCarried).toEqual(['Prefers bullet points.']);
		expect(merged.leftOut).toEqual(['1 line was left out.']);
	});
});

describe('draftPaths', () => {
	it('offers the profile’s places, people the draft adds, and new subdomains it names', () => {
		const draft: Draft = {
			...emptyDraft(),
			people: [{ name: 'Nikau', kind: 'person', relation: 'son', aka: [] }],
			entries: [line({ path: 'interests/sailing', claim: 'Races a Laser.' }), line({ path: 'hobbies/x', claim: 'Not a domain.' })]
		};
		const paths = draftPaths(
			[
				{ domain: 'life', subdomains: [{ name: 'health', label: 'health', sensitivity: 'private' }] },
				{ domain: 'people', subdomains: [{ name: 'k3j9x2ab', label: 'Aroha', sensitivity: 'personal' }] }
			],
			draft
		);
		expect(paths).toEqual([
			{ value: 'life/health', label: 'life / health', sensitivity: 'private', isNew: false },
			{ value: 'people/Aroha', label: 'people / Aroha', sensitivity: 'personal', isNew: false },
			{ value: 'people/Nikau', label: 'people / Nikau', sensitivity: 'personal', isNew: true },
			{ value: 'interests/sailing', label: 'interests / sailing', sensitivity: 'normal', isNew: true }
		]);
	});
});

describe('draftProblems', () => {
	it('says what the store would refuse, line by line', () => {
		const draft: Draft = {
			...emptyDraft(),
			people: [{ name: ' ', kind: 'person', relation: '', aka: [] }],
			entries: [
				line({ claim: 'Uses Neovim daily.' }),
				line({ claim: 'short' }),
				line({ claim: 'Moving house soon.', until: '2026-10-10' }),
				line({ path: 'life/health', claim: 'Coeliac; avoids gluten.', pinned: true }),
				line({ path: '', claim: 'Filed nowhere yet.' })
			]
		};
		const { people, entries } = draftProblems(draft, '2026-10-10');
		expect(people[0]).toMatch(/A name is/);
		expect(entries[0]).toBeNull();
		expect(entries[1]).toMatch(/this one is 5/);
		expect(entries[2]).toMatch(/passed/);
		expect(entries[3]).toMatch(/cannot be pinned/);
		expect(entries[4]).toMatch(/Choose where/);
	});
});
