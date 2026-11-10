/**
 * The tool-permission request a run is waiting on, reduced from the chunks the
 * server streams. Client-importable on purpose: the chat and code pages both
 * hold the same state and a page cannot be tested without a DOM.
 */

export type PermissionDecision = 'once' | 'session' | 'always' | 'deny';

export interface OpenPermission {
	id: string;
	tool: string;
	server?: string;
	summary: string;
}

export type PermissionChunk =
	| { type: 'permission'; id: string; tool: string; server?: string; summary: string }
	| { type: 'permission_done'; id: string; decision: PermissionDecision };

/**
 * Chunks replay in full on every reconnect, so an open followed by its close
 * arrives together and must leave nothing open. A close for some other id is
 * ignored: it belongs to a request this page is not showing, and clearing on it
 * would drop a prompt the person has not answered.
 */
export function applyPermissionChunk(
	current: OpenPermission | null,
	chunk: { type: string; [key: string]: unknown }
): OpenPermission | null {
	const c = chunk as PermissionChunk;
	if (c.type === 'permission') {
		return { id: c.id, tool: c.tool, server: c.server, summary: c.summary };
	}
	if (c.type === 'permission_done') return current?.id === c.id ? null : current;
	return current;
}

/**
 * What the prompt shows as the tool's name: the server's tools are namespaced
 * by the server that owns them, and a bare `search` could be any of them.
 */
export function permissionTitle(tool: string, server?: string): string {
	return server ? `${tool} on ${server}` : tool;
}

/** When an always-grant was given, for the Settings list. */
export function grantedOn(at: number): string {
	return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
