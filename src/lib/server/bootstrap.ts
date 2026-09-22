import { db } from '$lib/server/db';
import {
	getSetting,
	migrateResearchSettings,
	migrateWebSearchSettings,
	setSetting,
	type ResearchSettings,
	type WebSearchSettings
} from '$lib/server/settings';
import { taskConfigs, CORE_TASKS, skills } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { saveSkill } from '$lib/server/skills';
import { deleteEmptyChats } from '$lib/server/chats';
import { DEFAULT_PROMPTS } from '$lib/server/engine/prompts';


const TYPST_SKILL_BODY = `## When to use

Load this before calling **\`create_pdf\`**. That tool typesets [Typst](https://typst.app) markup — not Markdown and not LaTeX. It is close enough to both to be misleading, so the differences below are where documents actually fail.

## The shape of a document

Content is plain text. Commands start with \`#\`. Set-rules configure everything after them and belong at the top:

\`\`\`typst
#set page(paper: "a4", margin: 2cm, numbering: "1")
#set text(font: "Libertinus Serif", size: 11pt)
#set par(justify: true)

= Title of the document

Ordinary prose. A blank line starts a new paragraph, exactly as in Markdown.

== A section

== Another section
\`\`\`

- Headings are \`=\`, \`==\`, \`===\` — **not** \`#\`, which is how a command starts. \`# Heading\` is the commonest mistake here and it fails loudly.
- \`*bold*\` and \`_italic_\`. Note the underscore for italic.
- Inline code in backticks; a fenced block for more, with the language after the fence.
- Lists: \`-\` for bullets, \`+\` for numbered. Indent two spaces to nest.
- A link is \`#link("https://example.com")[the text]\`.
- Escape with a backslash: \`\\#\`, \`\\$\`, \`\\@\`.

## Worth knowing

**Tables** take their cells as a flat run of content, filled row by row:

\`\`\`typst
#table(
  columns: (auto, 1fr, auto),
  [*Item*], [*What it is*], [*Cost*],
  [Widget], [The usual sort], [12.00],
)
\`\`\`

**Maths** sits between dollars: \`$x^2 + y^2 = z^2$\` inline, and \`$ ... $\` with spaces inside the delimiters for a display equation.

**Page furniture.** \`#pagebreak()\`, \`#v(1cm)\` for vertical space, \`#align(center)[...]\`, \`#outline()\` for a table of contents.

**Fonts.** Only what the compiler embeds: *Libertinus Serif*, *New Computer Modern*, *DejaVu Sans Mono*. Naming anything else falls back silently and the document will not look as you intended.

## Packages

\`#import "@preview/..."\` works. The package is downloaded from the registry the first time any document asks for it and kept after that, so the first use of one is slower than the rest. Two are worth knowing:

- **cetz** — drawn diagrams: \`#import "@preview/cetz:0.3.1"\`, then \`#cetz.canvas({ ... })\` for boxes, arrows, plots and trees. This is what to reach for when a table will not do.
- **tablex** — tables past what \`#table\` handles comfortably: merged cells, per-cell styling, rows that repeat across a page break.

Pin the version, as in the examples above; an unpinned import will not resolve. And keep to packages you are sure exist — a wrong name costs a failed compile and a round trip. If the instance has no outbound network the import fails with a network error naming the package, in which case write it in plain Typst instead.

## Other limits

- **No local files.** The compile happens in an empty scratch directory, so \`image("logo.png")\` has nothing to read, and nothing outside that directory can be read either. Draw the shape you want with Typst's own \`#rect\`, \`#circle\` and \`#line\`, or with cetz.
- **One file.** Nothing is included that you have not written into \`source\`.

## When it fails

You get the compiler's own diagnostics, which name the line and the problem. Read them and fix the markup rather than starting again — Typst errors are unusually precise, and \`unclosed delimiter\` almost always means a missing \`)\` or \`]\` a few lines above where it points.`;

/** Idempotent boot seeding: make sure every core task has a config row. */
export function seedTaskConfigs(): void {
	const existing = new Map(
		db
			.select({ task: taskConfigs.task, promptOverride: taskConfigs.promptOverride })
			.from(taskConfigs)
			.all()
			.map((r) => [r.task, r.promptOverride])
	);
	for (const task of CORE_TASKS) {
		// `system_prompt` is nothing but a rollback copy now — see the column's own
		// comment. Nothing reads it, and it is rewritten here on every boot so the
		// previous image, which does read it, never finds a task holding text this
		// release stopped shipping.
		const resolved = existing.get(task) ?? DEFAULT_PROMPTS[task] ?? '';
		if (existing.has(task)) {
			db.update(taskConfigs)
				.set({ systemPrompt: resolved })
				.where(eq(taskConfigs.task, task))
				.run();
			continue;
		}
		db.insert(taskConfigs)
			.values({ task, systemPrompt: resolved, promptOverride: null, options: null })
			.run();
	}
}

const FIGMA_SKILL_BODY = `## When to use

Use this skill when the user shares a **Figma file or frame** (a figma.com URL, a file key, or a node id) and wants you to read or describe its structure, extract design data, or pull image renditions of specific frames. Only the chat agent has the Figma tools — they are scoped to the \`chat\` task.

## The two tools

Galaxy connects to Figma through the community \`figma-developer-mcp\` server (Framelink), which talks to Figma's REST API with a personal access token. It exposes exactly **two** tools — a real step down from Figma's official ~40-tool server, which we cannot reach because Figma blocks non-catalogued OAuth clients (see \`docs/MCP.md\`):

- **\`figma__get_figma_data\`** — returns the node tree of a file (or a single node) as JSON: layers, text, styles, component refs, layout. This is your primary read tool.
- **\`figma__download_figma_images\`** — pulls PNG/SVG image renditions of specific nodes. Use it when the user wants to *see* a frame, not just read its metadata.

There is **no** write path, no live selection context, no design-system variables by name, no Code Connect, and no screenshot tool. This is "read a file's node tree and pull its assets", not a design-system integration.

## How to call them well

1. **Always pass a \`nodeId\`.** A whole-file read with no node id can return a payload large enough to blow the context window. Ask the user for a specific frame if they haven't given one, or read the top-level \`document\` node first to discover child node ids, then drill into the one you need.
2. **Mind the file-key / node-id format.** A Figma URL like \`https://www.figma.com/file/1234-5678/Name?node-id=9:10\` uses a hyphenated file key (\`1234-5678\`) and a colon node id (\`9:10\`). The API and these tools want the file key as-is (\`1234-5678\` works as the \`fileKey\`), and the node id with its colon preserved (\`9:10\`). Don't convert hyphens to colons in the file key.
3. **\`get_figma_data\` first, \`download_figma_images\` second.** Read the structure to find the node you care about, then request an image of that node's id. Don't pull images for every node — only what the user asked to see.
4. **Summarise, don't dump.** The JSON tree can be large and deeply nested. Return a concise description of what's there (frame names, layout, text content, key styles) rather than pasting the raw JSON back at the user.

## If a call fails

- **"Connection closed" / 0 tools after Sync** — the \`figma-developer-mcp\` binary isn't installed in the container, or \`--stdio\` is missing from the server args. Check Admin → Tools → MCP servers.
- **401 / "Unauthorized"** — the \`FIGMA_API_KEY\` env var is wrong, expired, or lacks the \`file_content:read\` scope. The token comes from Figma → Settings → Security → Personal access tokens.
- **Empty result for a node** — the node id is wrong, or the token's scope doesn't cover that file (e.g. a library file needs \`library_content:read\`).
`;

/**
 * Idempotent boot seeding for bundled skills. These are written once (if
 * absent) and from then on owned by the user — editing or deleting them in
 * Admin is respected, so we never overwrite an existing row.
 */
export function seedSkills(): void {
	// Checked per skill rather than behind one early return, so a skill added
	// later still lands on an install that already has the earlier ones.
	seedSkill('figma-reading', {
		category: 'figma',
		description:
			'Read Figma files: pull a frame/node tree and image renditions via the figma-developer-mcp tools (chat-only).',
		triggers: 'figma, design file, figma link, figma url',
		body: FIGMA_SKILL_BODY
	});
	seedSkill('typst', {
		category: 'documents',
		description:
			'Typst markup for the create_pdf tool: document structure, tables, maths, and what this instance cannot do.',
		triggers: 'pdf, create_pdf, typst, document, report, letter, typeset',
		body: TYPST_SKILL_BODY
	});
}

/**
 * Move an install off seeded prompts and onto overrides. One shot.
 *
 * Every row's `system_prompt` was written at first boot from whatever default
 * that release shipped, so a row still holding a shipped default is an install
 * that never edited it: that becomes no override at all, and from here it
 * tracks DEFAULT_PROMPTS. Anything else is text somebody wrote, and becomes
 * theirs.
 *
 * The historical defaults sit inside this file rather than in an exported
 * table, which is the difference from the SUPERSEDED_PROMPTS this replaces.
 * That table needed a new entry for every future reword, and an entry built
 * from a live constant stopped matching the day the constant changed, with a
 * no-op migration looking exactly like an owner's edit. This list is closed: it
 * only names text shipped before the override column existed, so nothing is
 * added to it and the whole function can be deleted a release or two from now.
 */
const SHIPPED_BEFORE_OVERRIDES: Record<string, string[]> = {
	chat: [
		'You are the chat agent of Galaxy, a self-hosted AI workspace. Be direct, capable and concise. When you are given a URL, read it with the fetch_url tool \u2014 never search for a page whose address you already have, and never describe a link you have not opened. Use the web_search tool when current or factual information would help and you have no address to go to \u2014 but search deliberately: open broadly, read the titles and domains that come back, then search again aimed at what they showed you, and never repeat a query. If the results are thin, answer with what you have and say what you could not confirm rather than searching repeatedly.\n\n' +
			'Format your replies to be read on a screen, not parsed out of a paragraph. Use short paragraphs of two or three sentences, separated by a blank line. Use a bulleted list whenever you are reporting more than one thing \u2014 files changed, options considered, problems found \u2014 one item per line, never as a run-on sentence. Give each bullet or section a short bold lead-in naming what it is about, so the reply can be skimmed. Use a heading only when the reply has genuinely distinct sections. Never answer with a single long paragraph.',
		'You are the chat agent of Galaxy, a self-hosted AI workspace. Be direct, capable and concise. When you are given a URL, read it with the fetch_url tool \u2014 never search for a page whose address you already have, and never describe a link you have not opened. Use the web_search tool when current or factual information would help and you have no address to go to \u2014 and search one query at a time. Open broadly, read the titles and domains that come back, open the two or three worth reading with fetch_url, and let what they actually say decide the next query. That is the whole method: a query written before the last one returned is a guess, and the one you write after reading is a different and better query. Never repeat a query, and never rest an answer on snippets when the page was a click away. If the results are thin, answer with what you have and say what you could not confirm rather than searching repeatedly.\n\n' +
			'Format your replies to be read on a screen, not parsed out of a paragraph. Use short paragraphs of two or three sentences, separated by a blank line. Use a bulleted list whenever you are reporting more than one thing \u2014 files changed, options considered, problems found \u2014 one item per line, never as a run-on sentence. Give each bullet or section a short bold lead-in naming what it is about, so the reply can be skimmed. Use a heading only when the reply has genuinely distinct sections. Never answer with a single long paragraph.'
	],
	'deep-research': [
		'You are the research agent of Galaxy. Plan searches, gather sources, verify claims across them, and synthesise findings with citations.'
	],
	memory: [
		'You are the memory agent of Galaxy. Audit recent activity for durable patterns, preferences and candidate skills. Extract only what is clearly supported.'
	]
};

const PROMPT_OVERRIDE_KEY = 'tasks.promptOverrideVersion';

/** Stamped like the settings migrations, so it runs on one boot and never again. */
export function migrateToPromptOverrides(): void {
	if (getSetting<number>(PROMPT_OVERRIDE_KEY, 0) >= 1) return;
	let kept = 0;
	for (const row of db.select().from(taskConfigs).all()) {
		if (row.promptOverride !== null) continue;
		const stored = row.systemPrompt ?? '';
		const shipped = [DEFAULT_PROMPTS[row.task] ?? '', ...(SHIPPED_BEFORE_OVERRIDES[row.task] ?? [])];
		if (!stored || shipped.includes(stored)) continue;
		db.update(taskConfigs)
			.set({ promptOverride: stored })
			.where(eq(taskConfigs.task, row.task))
			.run();
		kept += 1;
	}
	setSetting(PROMPT_OVERRIDE_KEY, 1);
	if (kept) console.log(`Kept ${kept} edited task prompt(s) as overrides.`);
}

/** Write a skill unless one of that name is already there — never overwrite. */
function seedSkill(
	name: string,
	spec: { category: string; description: string; triggers: string; body: string }
): void {
	if (db.select({ name: skills.name }).from(skills).where(eq(skills.name, name)).get()) return;
	saveSkill({ name, author: 'user', enabled: true, ...spec });
}


/**
 * Bring stored settings up to the current defaults, once per version.
 *
 * A stored row beats the default on every read, so raising a default reaches
 * only installs that have never saved that key — which, after the first visit
 * to the admin panel, is none of them. This is the one place that gap is
 * closed, and it closes it conservatively: see `migrateWebSearchSettings`,
 * which moves a value only while it still equals the default it replaces.
 */
/**
 * One-time cleanups that belong with the settings migrations.
 *
 * Stamped like them, so a sweep runs on the boot after the change that needs it
 * and never again — a person who later wants an empty chat is entitled to keep
 * one.
 */
export function migrateChats(): void {
	if (getSetting<number>(EMPTY_CHAT_SWEEP_KEY, 0) >= 1) return;
	const removed = deleteEmptyChats();
	setSetting(EMPTY_CHAT_SWEEP_KEY, 1);
	if (removed) console.log(`Removed ${removed} chat(s) that were created and never used.`);
}

const EMPTY_CHAT_SWEEP_KEY = 'chats.emptySweepVersion';

export function migrateSettings(): void {
	const search = migrateWebSearchSettings(
		getSetting<Partial<WebSearchSettings> | null>('websearch', null)
	);
	if (search) setSetting('websearch', search);
	const research = migrateResearchSettings(
		getSetting<Partial<ResearchSettings> | null>('research', null)
	);
	if (research) setSetting('research', research);
}
