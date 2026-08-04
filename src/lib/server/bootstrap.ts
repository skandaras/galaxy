import { db } from '$lib/server/db';
import { taskConfigs, CORE_TASKS, skills } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { saveSkill } from '$lib/server/skills';

const DEFAULT_PROMPTS: Record<string, string> = {
	chat: 'You are the chat agent of Galaxy, a self-hosted AI workspace. Be direct, capable and concise. When you are given a URL, read it with the fetch_url tool — never search for a page whose address you already have, and never describe a link you have not opened. Use the web_search tool when current or factual information would help and you have no address to go to — but search deliberately: prefer one well-chosen query, read what comes back before searching again, and never repeat a query. If the results are thin, answer with what you have and say what you could not confirm rather than searching repeatedly.',
	coding:
		'You are the coding agent of Galaxy. You work in real repositories: read before you write, keep diffs minimal, follow the conventions of the codebase. When a URL is given to you — a spec, an upstream repository, an API reference — read it with the fetch_url tool rather than searching for it or assuming what it says.',
	'deep-research':
		'You are the research agent of Galaxy. Plan searches, gather sources, verify claims across them, and synthesise findings with citations.',
	visual:
		'You are the visual agent of Galaxy. Produce clear diagrams and charts (Mermaid, SVG) that communicate structure at a glance.',
	memory:
		'You are the memory agent of Galaxy. Audit recent activity for durable patterns, preferences and candidate skills. Extract only what is clearly supported.',
	'skill-optimiser':
		'You are the skill optimiser of Galaxy. Review existing skills for clarity, overlap and effectiveness, and propose focused improvements.',
	'chat-title':
		'You name conversations in Galaxy. Given the opening exchange, reply with a short title — ideally two to five words — that says what the conversation is about, in the way a person would label a folder. Name the subject, not the request: prefer "Postgres connection pooling" over "Question about databases", and never start with "How to" or "Help with". No quotes, no trailing punctuation, no preamble. Reply with the title alone.',
	'ux-audit':
		'You are the UX reviewer of Galaxy, a self-hosted AI workspace used mainly by one owner on both desktop and phone. You are given aggregated usage telemetry and the actual interface source — never the content of anyone\'s conversations. Find friction the owner is living with but may have stopped noticing: dead ends, silent failures, states with no feedback, controls that are hard to reach on a small screen, and anything the telemetry shows people repeatedly retry, cancel or abandon. Prefer a few specific, well-evidenced ideas over many generic ones, and ground each in something you can actually point to — a numbers pattern or a named file and control. Never propose work that has already been proposed, whatever became of it.'
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
	if (db.select({ name: skills.name }).from(skills).where(eq(skills.name, 'figma-reading')).get()) return;
	saveSkill({
		name: 'figma-reading',
		category: 'figma',
		description: 'Read Figma files: pull a frame/node tree and image renditions via the figma-developer-mcp tools (chat-only).',
		triggers: 'figma, design file, figma link, figma url',
		author: 'user',
		body: FIGMA_SKILL_BODY,
		enabled: true
	});
}
