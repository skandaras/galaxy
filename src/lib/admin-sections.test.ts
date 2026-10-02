import { describe, expect, it } from 'vitest';
import { CORE_TASKS } from '$lib/server/db/schema';
import { ADMIN_SECTIONS, adminPath, sectionOfTask, taskPath } from './admin-sections';

describe('admin sections', () => {
	it('edits every core task in exactly one place', () => {
		// The failure this guards: a task added to CORE_TASKS with no section
		// would have no prompt editor anywhere, and one listed twice would have
		// two editors writing the same row.
		for (const task of CORE_TASKS) {
			const homes = ADMIN_SECTIONS.filter((s) => (s.tasks as readonly string[]).includes(task));
			expect(homes.map((s) => s.label), task).toHaveLength(1);
		}
	});

	it('names no task that does not exist', () => {
		const known = new Set<string>(CORE_TASKS);
		for (const s of ADMIN_SECTIONS) for (const t of s.tasks) expect(known.has(t), t).toBe(true);
	});

	it('has unique labels, since the label is the URL', () => {
		const labels = ADMIN_SECTIONS.map((s) => s.label.toLowerCase());
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('writes paths the way the rest of the app reads them', () => {
		expect(adminPath('Coding', 'GitHub')).toBe('Admin → Coding → GitHub');
		expect(adminPath('Spend')).toBe('Admin → Spend');
		expect(sectionOfTask('cortex-groom')).toBe('Cortex');
		expect(taskPath('vision')).toBe('Admin → General tasks → vision');
	});
});
