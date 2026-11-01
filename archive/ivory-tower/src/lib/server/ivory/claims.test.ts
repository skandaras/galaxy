import { describe, expect, it } from 'vitest';
import { GOOD_CLAIM } from './github-fixture';
import { authoredFamily, modelFamily, noteFileName, parseClaim, validateClaim } from './claims';
import { seedFiles } from './setup';

const SHELF = { project: 'bees', notesOnShelf: ['projects/bees/notes/N-002-seeley-1995.md'] };

describe('validateClaim', () => {
	it('passes a claim written to the template', () => {
		expect(validateClaim(GOOD_CLAIM, SHELF)).toEqual([]);
		expect(parseClaim(GOOD_CLAIM)).toMatchObject({
			id: 'C-001',
			status: 'draft',
			authoredBy: 'ivory-synthesise + z-ai/glm-5.3',
			reviewedBy: [],
			notes: ['N-002-seeley-1995.md'],
			title: 'C-001: Waggle dances allocate foragers like a load balancer'
		});
	});

	it('accepts the shipped kin-selection example as well formed, apart from its own project', () => {
		const problems = validateClaim(seedFiles()['templates/examples/C-example-kin-selection.md'], {
			project: 'example',
			notesOnShelf: []
		});
		// The example is historical: it cites no notes and has no id of the C-001 kind.
		expect(problems).toEqual(['`id` must look like C-001.', '`notes` must list the notes/ files the claim relies on.']);
	});

	it('names a bad status, a missing section and a note that is not on the Shelf', () => {
		const bad = GOOD_CLAIM.replace('status: draft', 'status: promising')
			.replace('## Prior art in the target field', '## Related work')
			.replace('notes: [N-002-seeley-1995.md]', 'notes: [N-002-seeley-1995.md, N-009-made-up]');
		expect(validateClaim(bad, SHELF)).toEqual([
			'`status` must be one of draft, challenged, survived, known, refuted.',
			"`notes` cites N-009-made-up, which is not in this project's notes/.",
			'The "## Prior art in the target field" section is missing.'
		]);
	});

	it('reads a note reference however it is written', () => {
		expect(noteFileName('notes/N-001-a.md')).toBe('N-001-a.md');
		expect(noteFileName('N-001-a')).toBe('N-001-a.md');
	});
});

describe('model families', () => {
	it.each([
		['z-ai/glm-5.3', 'z-ai'],
		['~openai/gpt-luna-latest', 'openai'],
		['anthropic/claude-sonnet-5', 'anthropic'],
		['claude-sonnet-5', 'anthropic'],
		['gpt-4o', 'openai'],
		['o3-mini', 'openai'],
		['glm-4.6', 'z-ai'],
		['meta-llama/llama-3.3-70b', 'meta-llama'],
		['nousresearch/hermes-4', 'nousresearch'],
		['mymodel-7b', 'mymodel']
	])('%s is %s', (key, family) => {
		expect(modelFamily(key)).toBe(family);
	});

	it('reads the author from authored_by, and a person has none', () => {
		expect(authoredFamily('ivory-synthesise + z-ai/glm-5.3')).toBe('z-ai');
		expect(authoredFamily('Sam')).toBeNull();
		expect(authoredFamily('')).toBeNull();
	});
});
