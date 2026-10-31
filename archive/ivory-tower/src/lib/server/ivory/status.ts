import type { ShelfClient } from './github';
import { ensureProjectIssue, getIssue, updateIssueBody } from './board';
import { projectFromBrief, SLUG } from './shelf';

/**
 * A project's status: one or two lines on where it stands, kept in a marked
 * section at the top of its project issue.
 *
 * On the board rather than in Galaxy, because status lives on the board and
 * nowhere else. The latest run writes it (an agent through set_status, or
 * Galaxy itself when a plan is approved or rejected), and GitHub's edit history
 * on the issue is the record of what it said before. Only the marked section is
 * ever replaced; whatever else the owner writes in the issue stays theirs.
 */

const START = '<!-- galaxy:status -->';
const END = '<!-- /galaxy:status -->';
const SECTION = /<!-- galaxy:status -->[\s\S]*?<!-- \/galaxy:status -->\n*/;

export const STATUS_MAX_CHARS = 300;

export interface ProjectStatus {
	text: string;
	/** `YYYY-MM-DD HH:MM` in UTC. */
	at: string;
	/** Which run wrote it: `ivory-read + <model>`, or `Galaxy`. */
	by: string;
}

/**
 * The text an agent offered, made fit to publish, or the reason it is not.
 *
 * An agent writes this after reading untrusted material, and it lands in a
 * GitHub issue body, so it is flattened to two short lines, the section
 * markers are removed, and @-mentions are broken so a page cannot make the
 * status ping somebody.
 */
export function cleanStatus(raw: unknown): { text: string } | { problem: string } {
	const text = String(raw ?? '')
		.replaceAll(START, '')
		.replaceAll(END, '')
		.replace(/<!--|-->/g, '')
		.replace(/@(?=[\w-])/g, '@​')
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join('\n');
	if (!text) return { problem: 'The status is empty.' };
	if (text.split('\n').length > 2) return { problem: 'Keep the status to one or two lines.' };
	if (text.length > STATUS_MAX_CHARS) return { problem: `Keep the status under ${STATUS_MAX_CHARS} characters.` };
	return { text };
}

export function readStatus(body: string | null | undefined): ProjectStatus | null {
	const m = SECTION.exec(body ?? '');
	if (!m) return null;
	const lines = m[0].replace(START, '').replace(END, '').trim().split('\n');
	const head = /^\*\*Status\*\* \((.+), (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\)$/.exec(lines[0] ?? '');
	const text = lines.slice(1).join('\n').trim();
	if (!head || !text) return null;
	return { by: head[1], at: head[2], text };
}

export function statusStamp(now: Date): string {
	return now.toISOString().slice(0, 16).replace('T', ' ');
}

/** The body with its status section replaced, or placed at the top if it had none. */
export function withStatus(body: string, status: ProjectStatus): string {
	const section = `${START}\n**Status** (${status.by}, ${status.at} UTC)\n${status.text}\n${END}\n\n`;
	// A function replacer, so a `$` in the text is not read as a replacement pattern.
	return SECTION.test(body) ? body.replace(SECTION, () => section) : section + body.replace(/^\n+/, '');
}

/**
 * Set a project's status, creating its project issue first if it has none.
 * Throws on a GitHub failure; callers report it rather than fail a run over it.
 */
export async function writeProjectStatus(
	client: ShelfClient,
	slug: string,
	status: { text: string; by: string },
	now = new Date()
): Promise<void> {
	if (!SLUG.test(slug)) throw new Error('No such project');
	const cleaned = cleanStatus(status.text);
	if ('problem' in cleaned) throw new Error(cleaned.problem);
	const brief = await client.file(`projects/${slug}/brief.md`, { fresh: true });
	if (brief === null) throw new Error(`The project ${slug} is not on the Shelf`);
	const number = await ensureProjectIssue(client, projectFromBrief(slug, brief));
	const issue = await getIssue(client, number);
	if (!issue) throw new Error(`Project issue #${number} could not be read`);
	await updateIssueBody(client, number, withStatus(issue.body, { text: cleaned.text, by: status.by, at: statusStamp(now) }));
}
