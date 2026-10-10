import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { profileEntries } from '$lib/server/db/schema';
import type { Draft, DraftEntry } from '$lib/profile-draft';
import {
	addEntry,
	addSubdomain,
	cleanDraft,
	confirmDraft,
	correctEntry,
	createEntity,
	deleteEntity,
	deleteEntry,
	exportMarkdown,
	findEntity,
	history,
	LIMITS,
	listEntries,
	lookup,
	parseExport,
	ProfileError,
	ProfileNotFound,
	profileBlock,
	resolvePath,
	setPinned,
	setSensitivity,
	subdomainsOf,
	undoNote,
	updateEntity,
	wipeProfile,
	type EntryInput
} from './profile';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const NOW = new Date('2026-10-10T09:00:00Z');
const DAY = 86_400_000;

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	wipeProfile(ALICE);
	wipeProfile(BOB);
});

const add = (
	input: Partial<EntryInput> & { claim: string },
	source: 'stated' | 'survey' | 'inferred' | 'imported' = 'stated',
	user = ALICE,
	now = NOW
) =>
	addEntry(
		user,
		{ domain: 'work', subdomain: 'tools', kind: 'fact', ...input } as EntryInput,
		{ source, now }
	);

/** Distinct claims, since the tests that fill a cap need many. */
const nth = (i: number) => `Uses tool number ${i} every day.`;

describe('writing an entry', () => {
	it('stores one claim, active, with the path’s sensitivity', () => {
		const { entry, overCap } = add({ claim: 'Uses Neovim, pnpm and Docker on Linux.' });
		expect(entry.id).toMatch(/^[a-z2-7]{8}$/);
		expect(entry.status).toBe('active');
		expect(entry.sensitivity).toBe('normal');
		expect(entry.confirmedAt).toEqual(entry.createdAt);
		expect(overCap).toBe(false);
		expect(listEntries(ALICE, NOW).map((e) => e.claim)).toEqual([
			'Uses Neovim, pnpm and Docker on Linux.'
		]);
	});

	it('keeps a claim to one line', () => {
		const { entry } = add({ claim: 'Uses Neovim\n  and   Docker.' });
		expect(entry.claim).toBe('Uses Neovim and Docker.');
	});

	it(`holds a claim to ${LIMITS.claimMin}–${LIMITS.claimMax} characters`, () => {
		expect(() => add({ claim: 'x'.repeat(LIMITS.claimMin - 1) })).toThrow(ProfileError);
		expect(() => add({ claim: 'x'.repeat(LIMITS.claimMax + 1) })).toThrow(ProfileError);
		expect(add({ claim: 'x'.repeat(LIMITS.claimMax) }).entry.claim).toHaveLength(LIMITS.claimMax);
	});

	it('refuses a path that does not exist, so a model cannot invent one', () => {
		expect(() => add({ subdomain: 'gadgets', claim: 'Owns a lot of gadgets.' })).toThrow(
			ProfileError
		);
		expect(() => resolvePath(ALICE, 'hobbies/knitting')).toThrow(/domains are identity/);
	});

	it('defaults sensitivity from the path', () => {
		expect(add({ domain: 'life', subdomain: 'health', claim: 'Coeliac; avoids gluten.' }).entry.sensitivity).toBe('private');
		expect(add({ domain: 'identity', subdomain: 'culture', claim: 'Speaks conversational te reo.' }).entry.sensitivity).toBe('personal');
		const aroha = createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'partner' });
		expect(add({ domain: 'people', subdomain: aroha.id, claim: 'Aroha is a GP on weekend shifts.' }).entry.sensitivity).toBe('personal');
	});

	it('needs the person’s words for anything inferred', () => {
		expect(() => add({ claim: 'Prefers trail running.' }, 'inferred')).toThrow(/words of the person/);
		expect(add({ claim: 'Prefers trail running.', quote: 'I love the trails' }, 'inferred').entry.quote).toBe(
			'I love the trails'
		);
	});

	it(`holds a quote to ${LIMITS.quoteMax} characters`, () => {
		expect(() =>
			add({ claim: 'Prefers trail running.', quote: 'x'.repeat(LIMITS.quoteMax + 1) }, 'inferred')
		).toThrow(ProfileError);
	});

	it(`clamps an expiry to ${LIMITS.expiryDays} days and refuses one already past`, () => {
		const { entry } = add({ claim: 'Moving house to Raglan.', expiresAt: new Date(NOW.getTime() + 400 * DAY) });
		expect(entry.expiresAt!.getTime()).toBe(NOW.getTime() + LIMITS.expiryDays * DAY);
		expect(() => add({ claim: 'Moving house to Raglan.', expiresAt: new Date(NOW.getTime() - DAY) })).toThrow(
			/already passed/
		);
	});

	it('links a card’s claims to its person', () => {
		const nikau = createEntity(ALICE, { kind: 'person', name: 'Nikau', relation: 'son' });
		const { entry } = add({ domain: 'people', subdomain: nikau.id, claim: 'Nikau is at Kōwhai School.' });
		expect(entry.about).toBe(nikau.id);
		expect(() => add({ about: 'Nobody', claim: 'Uses the shared family laptop.' })).toThrow(/No one/);
	});
});

describe('caps', () => {
	it(`refuses the ${LIMITS.entriesPerSubdomain + 1}th entry in a subdomain unless the person said it`, () => {
		for (let i = 0; i < LIMITS.entriesPerSubdomain; i++) add({ claim: nth(i) }, 'survey');
		expect(() => add({ claim: nth(99) }, 'survey')).toThrow(/already holds 25/);
		const { overCap } = add({ claim: nth(100) }, 'stated');
		expect(overCap).toBe(true);
		expect(listEntries(ALICE, NOW)).toHaveLength(LIMITS.entriesPerSubdomain + 1);
	});

	it(`holds a person’s card to ${LIMITS.entriesPerPerson}`, () => {
		const pip = createEntity(ALICE, { kind: 'pet', name: 'Pip', relation: 'dog' });
		for (let i = 0; i < LIMITS.entriesPerPerson; i++) {
			add({ domain: 'people', subdomain: pip.id, claim: `Pip fact number ${i}.` }, 'survey');
		}
		expect(() =>
			add({ domain: 'people', subdomain: pip.id, claim: 'Pip fact number 99.' }, 'survey')
		).toThrow(ProfileError);
	});

	it(`refuses anything past ${LIMITS.entriesPerUser} entries, stated or not`, () => {
		const rows = Array.from({ length: LIMITS.entriesPerUser }, (_, i) => ({
			id: `fill${String(i).padStart(4, '0')}`,
			userId: ALICE,
			domain: 'interests' as const,
			subdomain: 'pursuits',
			kind: 'fact' as const,
			claim: nth(i),
			source: 'survey' as const,
			createdAt: NOW,
			confirmedAt: NOW
		}));
		db.insert(profileEntries).values(rows).run();
		expect(() => add({ claim: 'Uses one more tool.' }, 'stated')).toThrow(/full at 500/);
		db.delete(profileEntries).run();
	});

	it(`holds a profile to ${LIMITS.entitiesPerUser} people and things`, () => {
		for (let i = 0; i < LIMITS.entitiesPerUser; i++) {
			createEntity(ALICE, { kind: 'place', name: `Place ${i}` });
		}
		expect(() => createEntity(ALICE, { kind: 'place', name: 'One more place' })).toThrow(ProfileError);
	});

	it(`allows ${LIMITS.customSubdomainsPerDomain} subdomains of a person’s own per domain`, () => {
		for (const name of ['boats', 'birds', 'bread', 'baking']) addSubdomain(ALICE, 'interests', name);
		expect(() => addSubdomain(ALICE, 'interests', 'bees')).toThrow(ProfileError);
		expect(() => addSubdomain(BOB, 'interests', 'taste')).toThrow(/already exists/);
		expect(() => addSubdomain(BOB, 'people', 'family')).toThrow(/added as people/);
		expect(subdomainsOf(ALICE, 'interests')).toEqual([
			'pursuits',
			'taste',
			'learning',
			'baking',
			'birds',
			'boats',
			'bread'
		]);
	});

	it('bounds an entity’s names and relation', () => {
		expect(() => createEntity(ALICE, { kind: 'person', name: 'x'.repeat(LIMITS.nameMax + 1) })).toThrow();
		expect(() =>
			createEntity(ALICE, { kind: 'person', name: 'Aroha', aka: ['a', 'b', 'c', 'd', 'e'] })
		).toThrow(/other names/);
		expect(() =>
			createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'x'.repeat(LIMITS.relationMax + 1) })
		).toThrow(/relation/);
	});

	it('keeps names unique across names and other names, ignoring case', () => {
		createEntity(ALICE, { kind: 'person', name: 'Aroha', aka: ['Ro'] });
		expect(() => createEntity(ALICE, { kind: 'person', name: 'aroha' })).toThrow(/already names/);
		expect(() => createEntity(ALICE, { kind: 'person', name: 'RO' })).toThrow(/already names/);
		// Bob's profile is his own.
		expect(createEntity(BOB, { kind: 'person', name: 'Aroha' }).name).toBe('Aroha');
	});
});

describe('the pinned brief', () => {
	it('never holds a private entry', () => {
		expect(() =>
			add({ domain: 'life', subdomain: 'health', claim: 'Coeliac; avoids gluten.', pinned: true })
		).toThrow(/private entry cannot be pinned/);
		const { entry } = add({ claim: 'Uses Neovim daily.', pinned: true });
		expect(setSensitivity(ALICE, entry.id, 'private').pinned).toBe(false);
	});

	it(`refuses a pin past ${LIMITS.briefChars} characters rather than unpinning something else`, () => {
		const long = (i: number) => `${i} `.padEnd(LIMITS.claimMax, 'x');
		let i = 0;
		const subs = ['tools', 'expertise', 'role', 'organisation', 'projects'];
		try {
			for (;;) {
				add({ subdomain: subs[i % subs.length], claim: long(i), pinned: true });
				i++;
			}
		} catch (err) {
			expect(String(err)).toMatch(/brief is full/);
		}
		expect(listEntries(ALICE, NOW).filter((e) => e.pinned).length).toBe(i);
		const unpinned = add({ claim: long(999) }).entry;
		expect(() => setPinned(ALICE, unpinned.id, true)).toThrow(/brief is full/);
	});
});

describe('corrections and forgetting', () => {
	it('supersedes rather than overwrites, and keeps the history in order', () => {
		const first = add({ claim: 'Works at Acme as an engineer.', pinned: true }).entry;
		const second = correctEntry(ALICE, first.id, { claim: 'Works at Acme as a staff engineer.' }, { source: 'stated', now: NOW });
		const third = correctEntry(ALICE, second.id, { claim: 'Works at Globex as a staff engineer.' }, { source: 'stated', now: NOW });
		expect(third.pinned).toBe(true);
		expect(listEntries(ALICE, NOW).map((e) => e.claim)).toEqual(['Works at Globex as a staff engineer.']);
		expect(history(ALICE, second.id).map((e) => e.claim)).toEqual([
			'Works at Acme as an engineer.',
			'Works at Acme as a staff engineer.',
			'Works at Globex as a staff engineer.'
		]);
		// Agents see only the current one.
		expect(lookup(ALICE, 'chat', { query: 'Acme' }).lines).toHaveLength(0);
		expect(lookup(ALICE, 'chat', { query: 'Globex' }).lines).toHaveLength(1);
	});

	it('does not count a correction against the cap its entry already uses', () => {
		for (let i = 0; i < LIMITS.entriesPerSubdomain; i++) add({ claim: nth(i) }, 'survey');
		const last = listEntries(ALICE, NOW).at(-1)!;
		expect(() =>
			correctEntry(ALICE, last.id, { claim: 'Uses tool number 24 weekly.' }, { source: 'survey', now: NOW })
		).not.toThrow();
	});

	it('forgets an entry with every version of it', () => {
		const first = add({ claim: 'Lives with a flatmate called Sam.' }).entry;
		const second = correctEntry(ALICE, first.id, { claim: 'Lives alone since August.' }, { source: 'stated', now: NOW });
		expect(deleteEntry(ALICE, first.id)).toBe(2);
		expect(history(ALICE, second.id)).toEqual([]);
		expect(lookup(ALICE, 'chat', { query: 'flatmate Sam alone' }).lines).toEqual([]);
	});

	it('answers as not found for someone else’s entry', () => {
		const { entry } = add({ claim: 'Uses Neovim daily.' });
		expect(() => correctEntry(BOB, entry.id, { claim: 'Uses Emacs daily.' }, { source: 'stated' })).toThrow(
			/No current entry/
		);
		expect(() => setPinned(BOB, entry.id, true)).toThrow(/No current entry/);
		expect(deleteEntry(BOB, entry.id)).toBe(0);
		expect(listEntries(ALICE, NOW)).toHaveLength(1);
	});

	it('wipes one person’s profile and nobody else’s', () => {
		add({ claim: 'Uses Neovim daily.' });
		add({ claim: 'Uses Emacs daily.' }, 'stated', BOB);
		createEntity(ALICE, { kind: 'person', name: 'Aroha' });
		wipeProfile(ALICE);
		expect(listEntries(ALICE, NOW)).toEqual([]);
		expect(findEntity(ALICE, 'Aroha')).toBeNull();
		expect(listEntries(BOB, NOW)).toHaveLength(1);
	});
});

describe('entities', () => {
	it('finds claims about someone by any of their names, after a rename too', () => {
		const aroha = createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'partner' });
		add({ domain: 'life', subdomain: 'routines', about: 'aroha', claim: 'Cooks with Aroha on Sundays.' });
		updateEntity(ALICE, aroha.id, { aka: ['Ro'] });
		expect(lookup(ALICE, 'chat', { query: 'Ro' }).lines).toHaveLength(1);
		expect(lookup(ALICE, 'chat', { about: 'Ro' }).lines[0]).toBe('Aroha: person, partner (also Ro)');
	});

	it('takes a person’s card with them and leaves their other claims about no one', () => {
		const nikau = createEntity(ALICE, { kind: 'person', name: 'Nikau', relation: 'son' });
		add({ domain: 'people', subdomain: nikau.id, claim: 'Nikau is at Kōwhai School.' });
		const run = add({ domain: 'life', subdomain: 'routines', about: nikau.id, claim: 'Does the school run on Tuesdays.' }).entry;
		expect(deleteEntity(ALICE, nikau.id)).toBe(true);
		expect(listEntries(ALICE, NOW).map((e) => [e.id, e.about])).toEqual([[run.id, null]]);
		expect(lookup(ALICE, 'chat', { query: 'Nikau' }).lines).toEqual([]);
	});
});

describe('the block', () => {
	const seed = () => {
		createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'partner' });
		createEntity(ALICE, { kind: 'project', name: 'Galaxy', relation: 'project' });
		add({ domain: 'identity', subdomain: 'basics', claim: 'Tama; lives in Auckland (NZDT).', pinned: true });
		add({ domain: 'life', subdomain: 'constraints', kind: 'constraint', claim: 'Vegetarian.', pinned: true });
		add({ domain: 'life', subdomain: 'health', kind: 'constraint', claim: 'Coeliac; avoids gluten.' });
		for (let i = 0; i < 5; i++) add({ claim: nth(i) });
		add({ claim: 'Uses Neovim daily.', pinned: true });
		add({
			domain: 'life',
			subdomain: 'home',
			kind: 'goal',
			claim: 'Moving house to Raglan.',
			pinned: true,
			expiresAt: new Date('2026-11-01T00:00:00Z')
		});
		add({ domain: 'interests', subdomain: 'pursuits', claim: 'Trail runs most weekends.', quote: 'I run the trails' }, 'inferred');
	};

	it('is empty for an empty profile and for a task with no scope', () => {
		expect(profileBlock(ALICE, 'chat', NOW)).toBe('');
		seed();
		expect(profileBlock(ALICE, 'visual', NOW)).toBe('');
	});

	it('is the same bytes until something changes', () => {
		seed();
		const a = profileBlock(ALICE, 'chat', NOW);
		expect(profileBlock(ALICE, 'chat', NOW)).toBe(a);
		add({ claim: 'Uses Docker for every service.' });
		expect(profileBlock(ALICE, 'chat', NOW)).not.toBe(a);
	});

	it('maps what is held, names who matters, and carries what is pinned in a fixed order', () => {
		seed();
		const lines = profileBlock(ALICE, 'chat', NOW).split('\n');
		expect(lines[0]).toMatch(/^\[Profile: .*profile_lookup\.\]$/);
		expect(lines[1]).toBe('map: identity: basics | work: tools 6 | life: home · constraints · health | interests: pursuits | now 1');
		expect(lines[2]).toBe('names: Aroha (partner)');
		expect(lines.slice(3)).toEqual([
			'- Tama; lives in Auckland (NZDT).',
			'- Uses Neovim daily.',
			'- until 2026-11-01: Moving house to Raglan.',
			'- Vegetarian.'
		]);
	});

	it('shows a coding agent its tools and nothing of a life', () => {
		seed();
		const block = profileBlock(ALICE, 'coding', NOW);
		expect(block).toContain('map: work: tools 6');
		expect(block).toContain('- Uses Neovim daily.');
		for (const absent of ['Aroha', 'Vegetarian', 'Raglan', 'Coeliac', 'Tama', 'names:']) {
			expect(block).not.toContain(absent);
		}
	});

	it('offers no lookup to a task that has no tools', () => {
		seed();
		expect(profileBlock(ALICE, 'deep-research', NOW).split('\n')[0]).not.toContain('profile_lookup');
	});

	it('leaves an expired entry out without waiting for a sweep', () => {
		seed();
		expect(profileBlock(ALICE, 'chat', new Date('2026-11-02T00:00:00Z'))).not.toContain('Raglan');
	});

	it(`names at most ${LIMITS.namesShown} people and things`, () => {
		for (let i = 0; i < 20; i++) createEntity(ALICE, { kind: 'person', name: `Friend ${i}` });
		const names = profileBlock(ALICE, 'chat', NOW).split('\n')[1];
		expect(names.split(' · ')).toHaveLength(LIMITS.namesShown);
		expect(names.length).toBeLessThanOrEqual(LIMITS.namesChars + 'names: '.length);
	});
});

describe('lookup', () => {
	it('finds a claim by a different form of the word', () => {
		add({ domain: 'interests', subdomain: 'pursuits', claim: 'Trail running most weekends.' });
		expect(lookup(ALICE, 'chat', { query: 'runs' }).lines).toHaveLength(1);
	});

	it(`shows at most ${LIMITS.searchLines} search results and says how many more there were`, () => {
		for (let i = 0; i < 20; i++) add({ subdomain: i < 10 ? 'tools' : 'expertise', claim: `Uses Docker setup ${i}.` });
		const res = lookup(ALICE, 'chat', { query: 'docker' });
		expect(res.lines).toHaveLength(LIMITS.searchLines);
		expect(res.omitted).toBeGreaterThan(0);
		expect(res.text).toMatch(/more not shown/);
	});

	it('summarises a domain and reads a subdomain whole', () => {
		for (let i = 0; i < 6; i++) add({ claim: nth(i) });
		add({ subdomain: 'role', claim: 'Staff engineer on the platform team.', pinned: true });
		const domain = lookup(ALICE, 'chat', { path: 'work' }).lines;
		expect(domain).toContain('work/role: 1');
		expect(domain).toContain('work/tools: 6');
		// Pinned plus the newest three, not all six.
		expect(domain.filter((l) => l.includes('Uses tool number'))).toHaveLength(3);
		expect(lookup(ALICE, 'chat', { path: 'work/tools' }).lines).toHaveLength(6);
	});

	it('reads a person’s card by name and lists what is current', () => {
		const aroha = createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'partner' });
		add({ domain: 'people', subdomain: aroha.id, claim: 'Aroha is a GP on weekend shifts.' });
		add({ claim: 'Moving house to Raglan.', expiresAt: new Date('2026-11-01T00:00:00Z') });
		expect(lookup(ALICE, 'chat', { path: 'people/aroha' }).lines[0]).toMatch(
			/Aroha is a GP on weekend shifts\. \(people\/Aroha\)$/
		);
		expect(lookup(ALICE, 'chat', { path: 'now' }, NOW).lines[0]).toContain('until 2026-11-01:');
	});

	it('answers the same for out of scope as for absent', () => {
		const aroha = createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'partner' });
		add({ domain: 'people', subdomain: aroha.id, claim: 'Aroha is a GP on weekend shifts.' });
		const absent = lookup(ALICE, 'coding', { about: 'Nobody' });
		expect(lookup(ALICE, 'coding', { about: 'Aroha' })).toEqual(absent);
		expect(lookup(ALICE, 'coding', { path: 'people/aroha' })).toEqual(absent);
		expect(lookup(ALICE, 'coding', { query: 'GP weekend' })).toEqual(absent);
	});

	it('marks a private entry so the agent handles it with care', () => {
		add({ domain: 'life', subdomain: 'health', claim: 'Coeliac; avoids gluten.' });
		expect(lookup(ALICE, 'chat', { query: 'gluten' }).lines[0]).toMatch(/\(life\/health\) \(private\)$/);
	});
});

describe('undoing a note', () => {
	it('takes a new entry away', () => {
		const { entry } = add({ claim: 'Uses Neovim daily.' });
		expect(undoNote(ALICE, entry.id)).toBe(true);
		expect(listEntries(ALICE, NOW)).toEqual([]);
		expect(lookup(ALICE, 'chat', { query: 'Neovim' }).lines).toEqual([]);
	});

	it('puts back what a correction replaced', () => {
		const first = add({ claim: 'Works at Acme.' }).entry;
		const second = correctEntry(ALICE, first.id, { claim: 'Works at Globex.' }, { source: 'stated', now: NOW });
		expect(undoNote(ALICE, second.id)).toBe(true);
		expect(listEntries(ALICE, NOW).map((e) => [e.id, e.claim])).toEqual([[first.id, 'Works at Acme.']]);
		expect(lookup(ALICE, 'chat', { query: 'Acme' }).lines).toHaveLength(1);
	});

	it('does nothing for someone else, or twice', () => {
		const { entry } = add({ claim: 'Uses Neovim daily.' });
		expect(undoNote(BOB, entry.id)).toBe(false);
		expect(undoNote(ALICE, entry.id)).toBe(true);
		expect(undoNote(ALICE, entry.id)).toBe(false);
	});
});

describe('not found', () => {
	it('is a ProfileNotFound for a missing entry and for someone else’s alike', () => {
		const { entry } = add({ claim: 'Uses Neovim daily.' });
		for (const [user, id] of [[BOB, entry.id], [ALICE, 'nosuchid']]) {
			expect(() => setPinned(user, id, true)).toThrow(ProfileNotFound);
			expect(() => setSensitivity(user, id, 'private')).toThrow(ProfileNotFound);
			expect(() => correctEntry(user, id, { claim: 'Uses Emacs daily.' }, { source: 'stated' })).toThrow(
				ProfileNotFound
			);
		}
		// A refusal of something that is there is not a not-found.
		expect(() => add({ claim: 'short' })).toThrow(ProfileError);
		expect(() => add({ claim: 'short' })).not.toThrow(ProfileNotFound);
	});
});

describe('export', () => {
	it('writes the profile out by domain, with people by name and anything unusual marked', () => {
		const aroha = createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'partner', aka: ['Ro'] });
		createEntity(ALICE, { kind: 'organisation', name: 'Acme', relation: 'employer' });
		add({ domain: 'people', subdomain: aroha.id, claim: 'Aroha is a GP on weekend shifts.' });
		add({ domain: 'life', subdomain: 'health', kind: 'constraint', claim: 'Coeliac; avoids gluten.' });
		add({ domain: 'life', subdomain: 'routines', about: aroha.id, claim: 'Swims with her on Mondays.' });
		add({ claim: 'Uses Neovim daily.', pinned: true });
		const md = exportMarkdown(ALICE, NOW);
		expect(md).toContain('## work\n\n### tools\n- Uses Neovim daily. (pinned)');
		expect(md).toContain('### Aroha (person, partner; also Ro)\n- Aroha is a GP on weekend shifts.');
		expect(md).toContain('### Acme (organisation, employer)');
		expect(md).toContain('- Coeliac; avoids gluten. (constraint, private)');
		expect(md).toContain('- Swims with her on Mondays. (about Aroha)');
		expect(exportMarkdown(BOB, NOW)).not.toContain('Neovim');
	});
});

describe('reading an export back', () => {
	/** A profile with something of every shape the file has to carry. */
	function fill(user: string) {
		const aroha = createEntity(user, { kind: 'person', name: 'Aroha', relation: 'partner', aka: ['Ro'] });
		createEntity(user, { kind: 'pet', name: 'Pip', relation: 'dog' });
		createEntity(user, { kind: 'organisation', name: 'Acme (NZ)', relation: 'employer' });
		addSubdomain(user, 'interests', 'sailing');
		const put = (input: Partial<EntryInput> & { claim: string }) => add(input, 'stated', user);
		put({ claim: 'Uses Neovim daily.', pinned: true });
		put({ domain: 'people', subdomain: aroha.id, claim: 'Aroha is a GP on weekend shifts.' });
		put({ domain: 'life', subdomain: 'health', kind: 'constraint', claim: 'Coeliac; avoids gluten.' });
		put({ domain: 'life', subdomain: 'home', claim: 'Rents a villa in Grey Lynn.', sensitivity: 'normal' });
		put({ domain: 'life', subdomain: 'routines', about: aroha.id, claim: 'Swims with her on Mondays.' });
		put({ domain: 'interests', subdomain: 'sailing', kind: 'goal', claim: 'Racing a Laser this summer.' });
		put({ domain: 'interests', subdomain: 'taste', claim: 'Uses metric (mostly).' });
		put({
			domain: 'life',
			subdomain: 'commitments',
			kind: 'goal',
			claim: 'Moving house to Raglan.',
			pinned: true,
			expiresAt: new Date('2026-11-01T00:00:00Z')
		});
	}

	it('gives back the same file once saved into an empty profile', () => {
		fill(ALICE);
		const md = exportMarkdown(ALICE, NOW);
		const draft = parseExport(md)!;
		expect(draft.leftOut).toEqual([]);
		expect(confirmDraft(BOB, draft, 'imported', NOW)).toMatchObject({ ok: true, added: 8, people: 3 });
		expect(exportMarkdown(BOB, NOW)).toBe(md);
		expect(listEntries(BOB, NOW).every((e) => e.source === 'imported')).toBe(true);
	});

	it('keeps a bracket that is not marks as part of what was said', () => {
		fill(ALICE);
		const draft = parseExport(exportMarkdown(ALICE, NOW))!;
		expect(draft.entries.find((e) => e.claim.startsWith('Uses metric'))?.claim).toBe('Uses metric (mostly).');
		expect(draft.people.find((p) => p.name === 'Acme (NZ)')).toMatchObject({ kind: 'organisation' });
	});

	it('is not fooled by text that is not an export, and says what it could not place', () => {
		expect(parseExport('I like sailing and I work at Acme.')).toBeNull();
		expect(parseExport('# Profile\n\nNothing under any domain.')).toBeNull();
		const draft = parseExport('# Profile\n\n## work\n\n### tools\n- Uses Neovim daily.\n\n## hobbies\n\n### x\n- Plays chess on Sundays.')!;
		expect(draft.entries).toHaveLength(1);
		expect(draft.leftOut[0]).toMatch(/1 line was under a heading/);
	});
});

describe('saving a draft', () => {
	const line = (over: Partial<DraftEntry> & { claim: string }): DraftEntry => ({
		path: 'work/tools',
		kind: 'fact',
		pinned: false,
		until: null,
		about: null,
		sensitivity: null,
		...over
	});
	const draftOf = (entries: DraftEntry[], people: Draft['people'] = []): Draft => ({
		people,
		entries,
		notCarried: [],
		leftOut: []
	});

	it('writes nothing when one line is refused, and says which', () => {
		const result = confirmDraft(
			ALICE,
			draftOf(
				[line({ claim: 'Uses Neovim daily.' }), line({ claim: 'short' }), line({ path: 'work/nowhere/x', claim: 'Filed nowhere at all.' })],
				[{ name: 'Aroha', kind: 'person', relation: 'partner', aka: [] }]
			),
			'survey',
			NOW
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.refusals.map((r) => [r.at, r.index])).toEqual([
			['entry', 1],
			['entry', 2]
		]);
		expect(listEntries(ALICE, NOW)).toEqual([]);
		expect(findEntity(ALICE, 'Aroha')).toBeNull();
		expect(subdomainsOf(ALICE, 'work')).not.toContain('nowhere-x');
	});

	it('skips a line already held word for word, and reuses someone already there', () => {
		const aroha = createEntity(ALICE, { kind: 'person', name: 'Aroha', relation: 'partner' });
		add({ claim: 'Uses Neovim daily.' });
		const result = confirmDraft(
			ALICE,
			draftOf(
				[
					line({ claim: 'uses neovim  daily.' }),
					line({ path: 'people/aroha', claim: 'Works weekend shifts.' }),
					line({ path: 'life/routines', about: 'Aroha', claim: 'Swims with her on Mondays.' })
				],
				[{ name: 'aroha', kind: 'person', relation: '', aka: [] }]
			),
			'survey',
			NOW
		);
		expect(result).toEqual({ ok: true, added: 2, skipped: 1, people: 0 });
		expect(listEntries(ALICE, NOW).filter((e) => e.about === aroha.id)).toHaveLength(2);
		expect(listEntries(ALICE, NOW).find((e) => e.subdomain === 'routines')?.source).toBe('survey');
	});

	it('creates a subdomain of their own that a line names, and someone new before their card', () => {
		const result = confirmDraft(
			ALICE,
			draftOf(
				[
					line({ path: 'people/Nikau', claim: 'Started school in 2025.' }),
					line({ path: 'interests/Board games', claim: 'Plays Catan on Fridays.' })
				],
				[{ name: 'Nikau', kind: 'person', relation: 'son', aka: [] }]
			),
			'survey',
			NOW
		);
		expect(result).toMatchObject({ ok: true, added: 2, people: 1 });
		expect(subdomainsOf(ALICE, 'interests')).toContain('board-games');
	});

	it('takes the path’s privacy unless the line says otherwise, and never a fourth kind of privacy', () => {
		confirmDraft(ALICE, draftOf([line({ path: 'life/health', claim: 'Coeliac; avoids gluten.' })]), 'survey', NOW);
		expect(listEntries(ALICE, NOW)[0].sensitivity).toBe('private');
		const bad = confirmDraft(
			ALICE,
			draftOf([line({ claim: 'Uses Neovim daily.', sensitivity: 'secret' as never })]),
			'survey',
			NOW
		);
		expect(!bad.ok && bad.refusals[0].message).toMatch(/one of: normal, personal, private/);
		expect(() => setSensitivity(ALICE, listEntries(ALICE, NOW)[0].id, 'secret' as never)).toThrow(ProfileError);
	});

	it('reads a draft sent over the wire as the types it claims', () => {
		const draft = cleanDraft({ entries: [{ path: 'work/tools', claim: 7, pinned: 'yes', until: 3 }], people: 'Aroha' });
		expect(draft).toEqual({
			people: [],
			entries: [{ path: 'work/tools', kind: '', claim: '', pinned: false, until: null, about: null, sensitivity: null }],
			notCarried: [],
			leftOut: []
		});
		expect(() => cleanDraft({ entries: Array(LIMITS.entriesPerUser + 1).fill({}) })).toThrow(ProfileError);
	});
});
