/**
 * Where everything lives in Admin, and how the rest of the app names it.
 *
 * Admin was twelve tabs, one of them called Settings holding twelve unrelated
 * cards, and each feature was configured in three to five of them: Cortex's
 * schedule under Cortex, its model under Tasks, its write switch under Tools,
 * its history under Settings → History retention. It is now one section per
 * feature, holding that feature's settings, its task prompts and its retention.
 *
 * The paths are built here because forty-odd messages across the server and
 * the pages spelled "Admin → Settings → GitHub" by hand, and several already
 * pointed at tabs that did not exist ("Admin → Research", "Settings → Memory"). A path written from this file cannot name a section that is gone.
 *
 * No server imports: the admin page reads this as well as the engine.
 */

export type AdminGroup = 'Platform' | 'Features' | 'Operations';

export interface AdminSection {
	label: string;
	group: AdminGroup;
	/** The core tasks whose prompt and models are edited in this section. */
	tasks: readonly string[];
}

export const ADMIN_SECTIONS = [
	{ label: 'Users', group: 'Platform', tasks: [] },
	{ label: 'Providers', group: 'Platform', tasks: [] },
	{ label: 'Models', group: 'Platform', tasks: [] },
	{ label: 'Tools', group: 'Platform', tasks: [] },
	{ label: 'Language', group: 'Platform', tasks: [] },
	{
		label: 'General tasks',
		group: 'Platform',
		tasks: ['chat', 'visual', 'vision', 'chat-title', 'run-summary']
	},
	{ label: 'Research', group: 'Features', tasks: ['deep-research'] },
	{ label: 'Coding', group: 'Features', tasks: ['coding', 'subagent'] },
	{ label: 'Memory and skills', group: 'Features', tasks: ['memory', 'skill-optimiser'] },
	{ label: 'Boards', group: 'Features', tasks: ['board'] },
	{ label: 'Cortex', group: 'Features', tasks: ['cortex-groom'] },
	{
		label: 'Ivory Tower',
		group: 'Features',
		tasks: ['ivory-read', 'ivory-plan', 'ivory-synthesise', 'ivory-redteam']
	},
	{ label: 'Alignment', group: 'Features', tasks: ['alignment', 'alignment-synthesis'] },
	{ label: 'UX audit', group: 'Features', tasks: ['ux-audit'] },
	{ label: 'Spend', group: 'Operations', tasks: [] },
	{ label: 'Conversations', group: 'Operations', tasks: [] },
	{ label: 'Deployment', group: 'Operations', tasks: [] }
] as const satisfies readonly AdminSection[];

export type AdminSectionLabel = (typeof ADMIN_SECTIONS)[number]['label'];

export const ADMIN_SECTION_LABELS: readonly AdminSectionLabel[] = ADMIN_SECTIONS.map(
	(s) => s.label
);

/** "Admin → Coding → GitHub", for a message that sends someone there. */
export function adminPath(section: AdminSectionLabel, card?: string): string {
	return card ? `Admin → ${section} → ${card}` : `Admin → ${section}`;
}

/** The section a task's prompt and models are edited in. */
export function sectionOfTask(task: string): AdminSectionLabel {
	const found = ADMIN_SECTIONS.find((s) => (s.tasks as readonly string[]).includes(task));
	return found?.label ?? 'General tasks';
}

/** Where to point a model at a task: "Admin → General tasks → vision". */
export function taskPath(task: string): string {
	return adminPath(sectionOfTask(task), task);
}

/** The places messages most often send people, named once. */
export const ADMIN_PATHS = {
	github: adminPath('Coding', 'GitHub'),
	shelf: adminPath('Ivory Tower', 'Shelf'),
	push: adminPath('Deployment', 'Push'),
	budget: adminPath('Spend', 'Budget cap'),
	webSearch: adminPath('Research', 'Web search'),
	deepResearch: adminPath('Research', 'Deep research'),
	language: adminPath('Language'),
	memory: adminPath('Memory and skills'),
	skills: adminPath('Memory and skills', 'Skills'),
	usage: adminPath('Spend', 'Usage')
} as const;
