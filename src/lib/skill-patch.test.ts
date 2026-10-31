import { describe, expect, it } from 'vitest';
import { applySkillPatch, lineDiff, MAX_SKILL_EDITS, readEdits } from './skill-patch';

const BODY = '## Steps\n1. Build the image\n2. Promote dev to prod\n3. Watch the logs';

describe('applySkillPatch', () => {
	it('replaces the one place each old text names, in order', () => {
		const res = applySkillPatch(BODY, [
			{ old: '2. Promote dev to prod', new: '2. Run the smoke suite\n3. Promote dev to prod' },
			{ old: '3. Watch the logs', new: '4. Watch the logs' }
		]);
		expect(res).toEqual({
			ok: true,
			body: '## Steps\n1. Build the image\n2. Run the smoke suite\n3. Promote dev to prod\n4. Watch the logs'
		});
	});

	it('refuses old text that is missing, or that appears more than once, overlaps included', () => {
		expect(applySkillPatch(BODY, [{ old: 'Deploy', new: 'x' }])).toMatchObject({ ok: false, problem: /not in the skill/ });
		expect(applySkillPatch('aaa', [{ old: 'aa', new: 'b' }])).toMatchObject({ ok: false, problem: /appears 2 times/ });
	});

	it('names the edit that failed', () => {
		const res = applySkillPatch(BODY, [
			{ old: '1. Build the image', new: '1. Build it' },
			{ old: 'nowhere', new: 'x' }
		]);
		expect(res).toMatchObject({ ok: false, problem: /^edit 2:/ });
	});

	it('keeps a dollar sign in the new text literal', () => {
		const res = applySkillPatch('cost: X', [{ old: 'X', new: '$& and $1' }]);
		expect(res).toEqual({ ok: true, body: 'cost: $& and $1' });
	});

	it('refuses an empty old text, a no-op, and a change that would leave nothing or too much', () => {
		expect(applySkillPatch(BODY, [{ old: '', new: 'x' }])).toMatchObject({ ok: false });
		expect(applySkillPatch(BODY, [{ old: 'Steps', new: 'Steps' }])).toMatchObject({ ok: false });
		expect(applySkillPatch('only', [{ old: 'only', new: '  ' }])).toMatchObject({ ok: false, problem: /empty/ });
		expect(applySkillPatch('x', [{ old: 'x', new: 'y'.repeat(30_000) }])).toMatchObject({ ok: false });
	});
});

describe('readEdits', () => {
	it('takes either spelling, and a list encoded as a string', () => {
		expect(readEdits([{ old_string: 'a', new_string: 'b' }])).toEqual([{ old: 'a', new: 'b' }]);
		expect(readEdits([{ old: 'a', new: 'b' }])).toEqual([{ old: 'a', new: 'b' }]);
		expect(readEdits('[{"old_string":"a","new_string":"b"}]')).toEqual([{ old: 'a', new: 'b' }]);
	});

	it('says what is wrong with anything else', () => {
		expect(readEdits([])).toHaveProperty('problem');
		expect(readEdits('not json')).toHaveProperty('problem');
		expect(readEdits([{ old_string: 'a' }])).toHaveProperty('problem');
		expect(readEdits(Array(MAX_SKILL_EDITS + 1).fill({ old: 'a', new: 'b' }))).toHaveProperty('problem');
	});
});

describe('lineDiff', () => {
	it('shows what went and what came, with context, folding long unchanged runs', () => {
		const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
		const after = ['one', 'two', 'three', 'four', 'FIVE', 'six', 'seven'].join('\n');
		expect(lineDiff(before, after, 1)).toEqual([
			{ kind: 'gap', count: 3 },
			{ kind: 'same', text: 'four' },
			{ kind: 'del', text: 'five' },
			{ kind: 'add', text: 'FIVE' },
			{ kind: 'same', text: 'six' },
			{ kind: 'gap', count: 1 }
		]);
	});

	it('folds a change that changes nothing into one gap', () => {
		expect(lineDiff('a\nb', 'a\nb', 2)).toEqual([{ kind: 'gap', count: 2 }]);
	});
});
