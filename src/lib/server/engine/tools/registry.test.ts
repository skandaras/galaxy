import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { toolSettings } from '$lib/server/db/schema';
import type { LoopTool } from '../loop';
import {
	applyToolPolicy,
	builtinDescriptors,
	loadToolSettings,
	resetToolSetting,
	saveToolSetting,
	toCatalog
} from './registry';

/**
 * Every tool the platform ships. If a tool is added or renamed this list must
 * change too — which is the point: new capabilities should be a deliberate
 * decision about what admins can see and switch off, not a silent addition.
 */
const EXPECTED = [
	// knowledge
	'skill_load',
	'library_search',
	'library_read',
	'library_write',
	// attachments
	'list_attachments',
	'read_attachment',
	// web
	'web_search',
	// coding, available while planning
	'list_files',
	'read_file',
	'grep_files',
	'git_status',
	// coding, implement mode only
	'write_file',
	'edit_file',
	'bash',
	'git_commit',
	'git_push'
];

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(toolSettings).run();
});

describe('builtinDescriptors', () => {
	it('lists every built-in tool exactly once', () => {
		const names = builtinDescriptors().map((d) => d.name);
		expect([...names].sort()).toEqual([...EXPECTED].sort());
		expect(new Set(names).size).toBe(names.length);
	});

	it('marks the tools plan mode withholds', () => {
		const byName = new Map(builtinDescriptors().map((d) => [d.name, d]));
		expect(byName.get('read_file')?.note).toBeUndefined();
		expect(byName.get('bash')?.note).toBe('implement mode only');
		expect(byName.get('git_push')?.note).toBe('implement mode only');
	});

	it('scopes tools to the tasks that offer them', () => {
		const byName = new Map(builtinDescriptors().map((d) => [d.name, d]));
		expect(byName.get('web_search')?.tasks).toEqual(['chat']);
		expect(byName.get('list_files')?.tasks).toEqual(['coding']);
		expect(byName.get('library_read')?.tasks).toEqual(['chat', 'coding']);
	});

	it('carries a parameter schema for each tool', () => {
		for (const d of builtinDescriptors()) {
			expect(d.parameters, d.name).toHaveProperty('type', 'object');
		}
	});
});

const tool = (name: string, description = 'original'): LoopTool => ({
	def: { name, description, parameters: { type: 'object', properties: {} } },
	execute: async () => 'ok'
});

describe('applyToolPolicy', () => {
	it('passes tools through untouched when nothing is configured', () => {
		const tools = [tool('web_search'), tool('read_file')];
		expect(applyToolPolicy(tools, 'chat')).toEqual(tools);
	});

	it('removes a disabled tool', () => {
		saveToolSetting('web_search', { enabled: false });
		const out = applyToolPolicy([tool('web_search'), tool('read_file')], 'chat');
		expect(out.map((t) => t.def.name)).toEqual(['read_file']);
	});

	it('restricts a tool to the chosen tasks', () => {
		saveToolSetting('library_write', { tasks: ['coding'] });
		expect(applyToolPolicy([tool('library_write')], 'chat')).toHaveLength(0);
		expect(applyToolPolicy([tool('library_write')], 'coding')).toHaveLength(1);
	});

	it('substitutes the description override without mutating the original', () => {
		saveToolSetting('web_search', { descriptionOverride: 'Only search internal docs.' });
		const original = tool('web_search');
		const [out] = applyToolPolicy([original], 'chat');
		expect(out.def.description).toBe('Only search internal docs.');
		expect(original.def.description).toBe('original');
	});

	it('ignores rows for tools that no longer exist', () => {
		saveToolSetting('removed_tool', { enabled: false });
		expect(applyToolPolicy([tool('web_search')], 'chat')).toHaveLength(1);
	});
});

describe('tool settings', () => {
	it('merges partial updates instead of clobbering', () => {
		saveToolSetting('bash', { descriptionOverride: 'Careful.' });
		saveToolSetting('bash', { enabled: false });
		const s = loadToolSettings().get('bash');
		expect(s).toEqual({ enabled: false, descriptionOverride: 'Careful.', tasks: null });
	});

	it('reset removes the override', () => {
		saveToolSetting('bash', { enabled: false });
		resetToolSetting('bash');
		expect(loadToolSettings().has('bash')).toBe(false);
	});

	it('reports effective values in the catalogue', () => {
		saveToolSetting('web_search', { descriptionOverride: 'Custom', tasks: ['chat'] });
		const entry = toCatalog(builtinDescriptors(), loadToolSettings()).find(
			(t) => t.name === 'web_search'
		)!;
		expect(entry.effectiveDescription).toBe('Custom');
		expect(entry.description).not.toBe('Custom');
		expect(entry.taskOverride).toEqual(['chat']);
		expect(entry.enabled).toBe(true);
	});
});
