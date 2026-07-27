import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { toolSettings } from '$lib/server/db/schema';
import type { LoopTool } from '../loop';
import { codingTools } from '../coding/tools';
import { attachmentTools } from './attachments';
import { knowledgeTools } from './knowledge';
import { webSearchToolDef } from './web-search';

export type ToolSource = 'builtin' | 'mcp';

export interface ToolDescriptor {
	name: string;
	source: ToolSource;
	/** Grouping for the admin list: knowledge, attachments, web, coding, or a server name. */
	group: string;
	/** Tasks that normally offer this tool. */
	tasks: string[];
	description: string;
	parameters: Record<string, unknown>;
	/** Caveat worth showing in the UI, e.g. "implement mode only". */
	note?: string;
	/** Set for MCP tools, so the UI can link back to the server. */
	serverId?: string;
}

export interface ToolSetting {
	enabled: boolean;
	descriptionOverride: string | null;
	tasks: string[] | null;
}

export interface ToolCatalogEntry extends ToolDescriptor {
	/** Description after any admin override. */
	effectiveDescription: string;
	enabled: boolean;
	descriptionOverride: string | null;
	taskOverride: string[] | null;
}

/**
 * The built-in catalogue, read off the tool factories themselves rather than
 * kept as a parallel list — a new tool shows up in admin without anyone
 * remembering to register it twice.
 */
export function builtinDescriptors(): ToolDescriptor[] {
	const out: ToolDescriptor[] = [];
	const add = (tools: LoopTool[], group: string, tasks: string[], note?: string) => {
		for (const t of tools) {
			out.push({
				name: t.def.name,
				source: 'builtin',
				group,
				tasks,
				note,
				description: t.def.description,
				parameters: t.def.parameters
			});
		}
	};

	add(knowledgeTools(), 'knowledge', ['chat', 'coding']);
	// The chat id only affects execution, never the declaration.
	add(attachmentTools('*'), 'attachments', ['chat', 'coding']);
	add([{ def: webSearchToolDef, execute: async () => '' }], 'web', ['chat']);

	// Constructing both modes is how we know which tools plan mode withholds.
	const ctx = { workspaceRel: '', mode: 'plan' as const, repoUrl: '' };
	const planTools = codingTools(ctx);
	const planNames = new Set(planTools.map((t) => t.def.name));
	add(planTools, 'coding', ['coding']);
	add(
		codingTools({ ...ctx, mode: 'implement' }).filter((t) => !planNames.has(t.def.name)),
		'coding',
		['coding'],
		'implement mode only'
	);

	return out;
}

export function loadToolSettings(): Map<string, ToolSetting> {
	return new Map(
		db
			.select()
			.from(toolSettings)
			.all()
			.map((r) => [
				r.name,
				{
					enabled: r.enabled,
					descriptionOverride: r.descriptionOverride,
					tasks: r.tasks ?? null
				}
			])
	);
}

export function saveToolSetting(name: string, patch: Partial<ToolSetting>): void {
	const existing = db.select().from(toolSettings).where(eq(toolSettings.name, name)).get();
	const next = {
		name,
		enabled: patch.enabled ?? existing?.enabled ?? true,
		descriptionOverride:
			patch.descriptionOverride !== undefined
				? patch.descriptionOverride || null
				: (existing?.descriptionOverride ?? null),
		tasks: patch.tasks !== undefined ? patch.tasks : (existing?.tasks ?? null),
		updatedAt: new Date()
	};
	if (existing) {
		db.update(toolSettings).set(next).where(eq(toolSettings.name, name)).run();
	} else {
		db.insert(toolSettings).values(next).run();
	}
}

/** Drop the override row, returning the tool to its coded defaults. */
export function resetToolSetting(name: string): void {
	db.delete(toolSettings).where(eq(toolSettings.name, name)).run();
}

export function toCatalog(
	descriptors: ToolDescriptor[],
	settings: Map<string, ToolSetting>
): ToolCatalogEntry[] {
	return descriptors.map((d) => {
		const s = settings.get(d.name);
		return {
			...d,
			effectiveDescription: s?.descriptionOverride || d.description,
			enabled: s?.enabled ?? true,
			descriptionOverride: s?.descriptionOverride ?? null,
			taskOverride: s?.tasks ?? null
		};
	});
}

/**
 * Gate and relabel a turn's toolset from the admin overrides. Applied at every
 * point where an agent's tools are assembled.
 */
export function applyToolPolicy(tools: LoopTool[], task: string): LoopTool[] {
	const settings = loadToolSettings();
	const out: LoopTool[] = [];
	for (const tool of tools) {
		const s = settings.get(tool.def.name);
		if (!s) {
			out.push(tool);
			continue;
		}
		if (!s.enabled) continue;
		if (s.tasks && !s.tasks.includes(task)) continue;
		out.push(
			s.descriptionOverride
				? { ...tool, def: { ...tool.def, description: s.descriptionOverride } }
				: tool
		);
	}
	return out;
}
