import { describe, expect, it } from 'vitest';
import { fmList, fmString, parseFrontmatter, setFrontmatterFields } from './frontmatter';
import { seedFiles } from './setup';

describe('parseFrontmatter', () => {
	it('reads every shipped template', () => {
		const seed = seedFiles();
		const brief = parseFrontmatter(seed['templates/brief.md']);
		expect(brief.present).toBe(true);
		expect(brief.meta.disciplines).toEqual([]);
		expect(brief.meta.validation_tier).toBe('reading');
		expect(brief.body).toContain('## Question');

		const claim = parseFrontmatter(seed['templates/claim-mapping.md']);
		expect(claim.meta.status).toBe('draft');
		expect(claim.meta.reviewed_by).toEqual([]);

		const example = parseFrontmatter(seed['templates/examples/C-example-kin-selection.md']);
		expect(example.meta.status).toBe('survived');
		expect(example.meta.reviewed_by).toEqual(['example']);
		expect(example.meta.source_domain).toBe('evolutionary biology (social behaviour in animals)');

		const note = parseFrontmatter(seed['templates/note.md']);
		expect(note.meta.access).toBe('full-text');
		expect(note.meta.year).toBeNull();
		expect(note.meta.title).toBe('');
	});

	it('drops trailing comments but keeps a # inside quotes or a word', () => {
		const { meta } = parseFrontmatter(
			'---\na: one # gone\nb: "x # kept"\nc: C# stays\nd: https://x.org/p#frag\n---\n'
		);
		expect(meta).toEqual({ a: 'one', b: 'x # kept', c: 'C# stays', d: 'https://x.org/p#frag' });
	});

	it('reads flow and block lists, numbers and quoted commas', () => {
		const { meta } = parseFrontmatter(
			'---\ndisciplines: [marine-biology, "aero, nautics"]\nauthors:\n  - Ada\n  - Bob\nyear: 1998\n---\nbody'
		);
		expect(meta.disciplines).toEqual(['marine-biology', 'aero, nautics']);
		expect(meta.authors).toEqual(['Ada', 'Bob']);
		expect(meta.year).toBe(1998);
	});

	it('treats text with no fence as all body', () => {
		expect(parseFrontmatter('# Just a heading')).toEqual({ meta: {}, body: '# Just a heading', present: false });
	});

	it('coerces for display', () => {
		expect(fmList('solo')).toEqual(['solo']);
		expect(fmList(null)).toEqual([]);
		expect(fmString(['a'])).toBe('');
	});
});

describe('setFrontmatterFields', () => {
	it('replaces what the model wrote and adds what it left out', () => {
		const out = setFrontmatterFields('---\nid: N-001\nproject: wrong # hm\ntask:\n  - x\n---\nbody', {
			project: 'right',
			task: 'https://github.com/o/r/issues/3',
			read_by: 'ivory-read + m/1'
		});
		const { meta, body } = parseFrontmatter(out);
		expect(meta).toEqual({
			id: 'N-001',
			project: 'right',
			task: 'https://github.com/o/r/issues/3',
			read_by: 'ivory-read + m/1'
		});
		expect(body).toBe('body');
	});
});
