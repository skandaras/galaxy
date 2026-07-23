import { describe, it, expect } from 'vitest';
import { normalizeSkillName, parseFrontmatter, serializeSkill } from './skills';

describe('skill frontmatter', () => {
	it('round-trips meta and body', () => {
		const raw = serializeSkill(
			{
				name: 'test-skill',
				description: 'Does testing things',
				category: 'coding',
				version: 3,
				author: 'agent',
				triggers: 'test, spec'
			},
			'## When to use\n\nAlways.\n'
		);
		const { meta, body } = parseFrontmatter(raw);
		expect(meta).toEqual({
			name: 'test-skill',
			description: 'Does testing things',
			category: 'coding',
			version: 3,
			author: 'agent',
			triggers: 'test, spec'
		});
		expect(body).toBe('## When to use\n\nAlways.\n');
	});

	it('treats files without frontmatter as pure body', () => {
		const { meta, body } = parseFrontmatter('just some text');
		expect(meta).toEqual({
			name: undefined,
			category: undefined,
			description: undefined,
			triggers: undefined,
			version: undefined,
			author: undefined
		});
		expect(body).toBe('just some text');
	});
});

describe('normalizeSkillName', () => {
	it('kebab-cases arbitrary input', () => {
		expect(normalizeSkillName('My Fancy Skill!')).toBe('my-fancy-skill');
		expect(normalizeSkillName('--already-fine--')).toBe('already-fine');
	});
});
