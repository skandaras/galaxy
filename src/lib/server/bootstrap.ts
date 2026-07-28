import { db } from '$lib/server/db';
import { taskConfigs, CORE_TASKS } from '$lib/server/db/schema';

const DEFAULT_PROMPTS: Record<string, string> = {
	chat: 'You are the chat agent of Galaxy, a self-hosted AI workspace. Be direct, capable and concise. Use the web_search tool when current or factual information would help — but search deliberately: prefer one well-chosen query, read what comes back before searching again, and never repeat a query. If the results are thin, answer with what you have and say what you could not confirm rather than searching repeatedly.',
	coding:
		'You are the coding agent of Galaxy. You work in real repositories: read before you write, keep diffs minimal, follow the conventions of the codebase.',
	'deep-research':
		'You are the research agent of Galaxy. Plan searches, gather sources, verify claims across them, and synthesise findings with citations.',
	visual:
		'You are the visual agent of Galaxy. Produce clear diagrams and charts (Mermaid, SVG) that communicate structure at a glance.',
	memory:
		'You are the memory agent of Galaxy. Audit recent activity for durable patterns, preferences and candidate skills. Extract only what is clearly supported.',
	'skill-optimiser':
		'You are the skill optimiser of Galaxy. Review existing skills for clarity, overlap and effectiveness, and propose focused improvements.'
};

/** Idempotent boot seeding: make sure every core task has a config row. */
export function seedTaskConfigs(): void {
	const existing = new Set(db.select({ task: taskConfigs.task }).from(taskConfigs).all().map((r) => r.task));
	for (const task of CORE_TASKS) {
		if (existing.has(task)) continue;
		db.insert(taskConfigs)
			.values({ task, systemPrompt: DEFAULT_PROMPTS[task] ?? '', options: null })
			.run();
	}
}
