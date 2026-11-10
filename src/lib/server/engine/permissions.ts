import { inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { mcpTools } from '$lib/server/db/schema';
import { deleteSetting, getSetting, setSetting } from '$lib/server/settings';
import type { LiveJob } from './jobs';
import { parkOnPrompt, settlePrompt } from './park';

/**
 * Asking before a tool runs.
 *
 * An MCP tool is code Galaxy does not own, run on the person's behalf against
 * accounts Galaxy cannot see into, so the first call to one stops the run and
 * asks. The answer is remembered at the width the person chose: this call, this
 * chat, or every chat until they take it back in Settings.
 *
 * Built on the same park as `ask_user`, so a pending request holds the job open
 * with no timeout, ends with Stop, and survives a reconnect by replaying its
 * chunk.
 */

export type PermissionDecision = 'once' | 'session' | 'always' | 'deny';

/** What a tool presents itself as. `key` is what a grant is stored against. */
export interface ToolPermission {
	key: string;
	label: string;
	server?: string;
}

/** The only values a client may send; anything else is treated as not answered. */
const DECISIONS: readonly PermissionDecision[] = ['once', 'session', 'always', 'deny'];

/**
 * The argument summary shown on the sheet and in the bell.
 *
 * Bounded because it is a model's arguments: a write_file-sized payload on a
 * phone notification is not something a person can read to decide.
 */
export const SUMMARY_MAX_CHARS = 300;

const GRANTS_KEY = 'tool-grants';

interface AlwaysGrant extends ToolPermission {
	at: number;
}

/**
 * Session grants for hidden chats.
 *
 * Kept off the database because the settings row is scoped by chat id, and a
 * hidden chat's id is stored nowhere. A restart forgets them, which for a chat
 * that was never going to be saved is the same lifetime as the chat.
 */
const hiddenSessionGrants = new Map<string, Set<string>>();

function alwaysGrants(userId: string): AlwaysGrant[] {
	return getSetting<AlwaysGrant[]>(GRANTS_KEY, [], userId);
}

function sessionKeys(chatId: string, persist: boolean): string[] {
	if (!persist) return [...(hiddenSessionGrants.get(chatId) ?? [])];
	return getSetting<string[]>(GRANTS_KEY, [], chatId);
}

function grantForSession(chatId: string, persist: boolean, key: string): void {
	if (!persist) {
		const keys = hiddenSessionGrants.get(chatId) ?? new Set<string>();
		keys.add(key);
		hiddenSessionGrants.set(chatId, keys);
		return;
	}
	const keys = sessionKeys(chatId, true);
	if (!keys.includes(key)) setSetting(GRANTS_KEY, [...keys, key], chatId);
}

function grantAlways(userId: string, permission: ToolPermission): void {
	const rest = alwaysGrants(userId).filter((g) => g.key !== permission.key);
	const grant: AlwaysGrant = {
		key: permission.key,
		label: permission.label,
		...(permission.server ? { server: permission.server } : {}),
		at: Date.now()
	};
	setSetting(GRANTS_KEY, [...rest, grant], userId);
}

export interface PermissionRequest {
	/** The job the browser is attached to, which for a nested worker is its parent's. */
	job: LiveJob;
	userId: string;
	/** Scope of a session grant: the chat the person is looking at. */
	chatId: string;
	persist: boolean;
	permission: ToolPermission;
	summary: string;
	/** Ends the wait too, for a nested run stopped while its parent job carries on. */
	signal?: AbortSignal;
}

export async function requestPermission(opts: PermissionRequest): Promise<'allow' | 'deny'> {
	const { job, userId, chatId, persist, permission } = opts;
	const { key } = permission;
	if (alwaysGrants(userId).some((g) => g.key === key)) return 'allow';
	if (sessionKeys(chatId, persist).includes(key)) return 'allow';
	// Nothing to ask of a run that is already over, and a prompt opened now
	// would never get its abort event.
	if (job.controller.signal.aborted || opts.signal?.aborted) return 'deny';

	const summary = opts.summary.slice(0, SUMMARY_MAX_CHARS);
	const decision = await parkOnPrompt<PermissionDecision>({
		kind: 'permission',
		job,
		userId,
		open: (id) => ({
			type: 'permission',
			id,
			tool: permission.label,
			...(permission.server ? { server: permission.server } : {}),
			summary
		}),
		close: (id, decision) => ({ type: 'permission_done', id, decision }),
		onStop: { value: 'deny' },
		notice: {
			title: 'An agent wants to use a tool',
			body: `${permission.label}${permission.server ? ` (${permission.server})` : ''}${summary ? `: ${summary}` : ''}`,
			link: `/chat?chat=${job.chatId}`
		},
		signal: opts.signal
	});

	if (decision === 'session') grantForSession(chatId, persist, key);
	else if (decision === 'always') grantAlways(userId, permission);
	return decision === 'deny' ? 'deny' : 'allow';
}

/**
 * Settle an open request. False for anything that is not a live request of
 * this person's, and for a decision outside the four, which is refused rather
 * than guessed at: a mangled value must not become a grant.
 */
export function answerPermission(requestId: string, userId: string, decision: unknown): boolean {
	if (!DECISIONS.includes(decision as PermissionDecision)) return false;
	return settlePrompt('permission', requestId, userId, decision);
}

/**
 * The tools this person has allowed everywhere.
 *
 * A grant whose tool is gone (server deleted, tool no longer advertised) is
 * dropped and removed, so Settings never lists a permission for something that
 * cannot run.
 */
export function listGrants(userId: string): AlwaysGrant[] {
	const grants = alwaysGrants(userId);
	if (!grants.length) return [];
	const live = new Set(
		db
			.select({ id: mcpTools.id })
			.from(mcpTools)
			.where(
				inArray(
					mcpTools.id,
					grants.map((g) => g.key)
				)
			)
			.all()
			.map((r) => r.id)
	);
	const kept = grants.filter((g) => live.has(g.key));
	if (kept.length !== grants.length) {
		if (kept.length) setSetting(GRANTS_KEY, kept, userId);
		else deleteSetting(GRANTS_KEY, userId);
	}
	return kept;
}

/** Take back an "always". False when there was no such grant. */
export function revokeGrant(userId: string, key: string): boolean {
	const grants = alwaysGrants(userId);
	const kept = grants.filter((g) => g.key !== key);
	if (kept.length === grants.length) return false;
	if (kept.length) setSetting(GRANTS_KEY, kept, userId);
	else deleteSetting(GRANTS_KEY, userId);
	return true;
}
