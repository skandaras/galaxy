import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '$lib/server/db';
import { mcpServers, mcpTools } from '$lib/server/db/schema';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';
import type { LoopTool } from '../loop';
import type { ToolDescriptor } from './registry';

export type McpServer = typeof mcpServers.$inferSelect;
export type McpTool = typeof mcpTools.$inferSelect;

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
/** Close a connection that hasn't been used for this long. */
const IDLE_MS = 5 * 60_000;

interface Pooled {
	client: Client;
	idleTimer: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, Pooled>();

/** How much of a child's stderr to keep. Enough for a stack, not a logfile. */
const STDERR_TAIL_CHARS = 2000;
/**
 * A dying child's last stderr write and the pipe closing are separate events
 * with no guaranteed order, so the failure path waits this long for the words
 * to land before giving up on explaining itself.
 */
const STDERR_SETTLE_MS = 50;

/**
 * Tail of the most recent child's stderr, per server.
 *
 * Module-level rather than a local in connect(), which is where it used to
 * live. A stdio server that dies *after* the handshake — a rejected API token,
 * an out-of-memory read — closes the pipe, and the client reports only
 * "MCP error -32000: Connection closed". The one account of why is what the
 * child printed on its way out, and that was being captured and then dropped
 * on the floor: connect() consulted it solely when the handshake itself
 * failed. Keeping it here means a failure at any point can still reach it,
 * including after disconnect() has torn the pool entry down.
 */
const lastStderr = new Map<string, string>();

// --- config ----------------------------------------------------------------

export function listServers(): McpServer[] {
	return db.select().from(mcpServers).all();
}

export function getServer(id: string): McpServer | undefined {
	return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
}

export function listServerTools(serverId?: string): McpTool[] {
	const q = db.select().from(mcpTools);
	return serverId ? q.where(eq(mcpTools.serverId, serverId)).all() : q.all();
}

export interface ServerInput {
	name: string;
	transport: 'http' | 'stdio';
	url?: string | null;
	headers?: Record<string, string> | null;
	command?: string | null;
	args?: string[] | null;
	env?: Record<string, string> | null;
	toolPrefix?: string;
	tasks?: string[] | null;
	enabled?: boolean;
}

export class McpConfigError extends Error {}

function validate(input: ServerInput): void {
	if (!input.name?.trim()) throw new McpConfigError('Name is required');
	if (input.transport === 'http') {
		if (!input.url?.trim()) throw new McpConfigError('URL is required for an HTTP server');
		let parsed: URL;
		try {
			parsed = new URL(input.url);
		} catch {
			throw new McpConfigError('URL is not valid');
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new McpConfigError('URL must be http or https');
		}
	} else if (!input.command?.trim()) {
		throw new McpConfigError('Command is required for a stdio server');
	}
}

export function createServer(input: ServerInput): McpServer {
	validate(input);
	const row: McpServer = {
		id: randomUUID(),
		name: input.name.trim(),
		transport: input.transport,
		url: input.url?.trim() || null,
		headersEnc: input.headers ? encryptSecret(JSON.stringify(input.headers)) : null,
		envEnc: input.env ? encryptSecret(JSON.stringify(input.env)) : null,
		command: input.command?.trim() || null,
		args: input.args ?? null,
		toolPrefix: (input.toolPrefix || defaultPrefix(input.name)).trim(),
		tasks: input.tasks ?? null,
		enabled: input.enabled ?? true,
		status: 'unknown',
		lastError: null,
		lastSyncAt: null,
		createdAt: new Date()
	};
	db.insert(mcpServers).values(row).run();
	return row;
}

export function updateServer(id: string, patch: Partial<ServerInput>): McpServer {
	const existing = getServer(id);
	if (!existing) throw new McpConfigError('Server not found');
	const merged: ServerInput = {
		name: patch.name ?? existing.name,
		transport: patch.transport ?? existing.transport,
		url: patch.url !== undefined ? patch.url : existing.url,
		command: patch.command !== undefined ? patch.command : existing.command,
		args: patch.args !== undefined ? patch.args : existing.args,
		toolPrefix: patch.toolPrefix ?? existing.toolPrefix,
		tasks: patch.tasks !== undefined ? patch.tasks : existing.tasks,
		enabled: patch.enabled ?? existing.enabled
	};
	validate(merged);

	db.update(mcpServers)
		.set({
			name: merged.name.trim(),
			transport: merged.transport,
			url: merged.url?.trim() || null,
			command: merged.command?.trim() || null,
			args: merged.args ?? null,
			toolPrefix: merged.toolPrefix?.trim() || defaultPrefix(merged.name),
			tasks: merged.tasks ?? null,
			enabled: merged.enabled ?? true,
			// Omitted headers/env keep the stored ones; an empty object clears them.
			...(patch.headers !== undefined
				? { headersEnc: patch.headers ? encryptSecret(JSON.stringify(patch.headers)) : null }
				: {}),
			...(patch.env !== undefined
				? { envEnc: patch.env ? encryptSecret(JSON.stringify(patch.env)) : null }
				: {})
		})
		.where(eq(mcpServers.id, id))
		.run();
	disconnect(id);
	return getServer(id)!;
}

export function deleteServer(id: string): void {
	disconnect(id);
	db.delete(mcpTools).where(eq(mcpTools.serverId, id)).run();
	db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
}

// --- naming ----------------------------------------------------------------

/** Providers require tool names to match /^[a-zA-Z0-9_-]{1,64}$/. */
function sanitize(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
}

function defaultPrefix(name: string): string {
	return sanitize(name).slice(0, 24).toLowerCase();
}

export function qualifiedName(server: { toolPrefix: string }, remoteName: string): string {
	const prefix = sanitize(server.toolPrefix);
	const base = sanitize(remoteName);
	return (prefix ? `${prefix}__${base}` : base).slice(0, 64);
}

// --- connections -----------------------------------------------------------

function headersOf(server: McpServer): Record<string, string> {
	if (!server.headersEnc) return {};
	try {
		return JSON.parse(decryptSecret(server.headersEnc)) as Record<string, string>;
	} catch {
		return {};
	}
}

function envOf(server: McpServer): Record<string, string> {
	if (!server.envEnc) return {};
	try {
		return JSON.parse(decryptSecret(server.envEnc)) as Record<string, string>;
	} catch {
		return {};
	}
}

async function connect(server: McpServer): Promise<Client> {
	const pooled = pool.get(server.id);
	if (pooled) {
		clearTimeout(pooled.idleTimer);
		pooled.idleTimer = setTimeout(() => disconnect(server.id), IDLE_MS);
		return pooled.client;
	}

	const client = new Client({ name: 'galaxy', version: '0.1.0' }, { capabilities: {} });

	// Whatever the previous child said belongs to the previous child.
	lastStderr.delete(server.id);
	let transport: StdioClientTransport | StreamableHTTPClientTransport;
	if (server.transport === 'stdio') {
		const stdio = new StdioClientTransport({
			command: server.command ?? '',
			args: server.args ?? [],
			// Spread process.env so PATH/HOME etc. still reach the child — the
			// SDK replaces the environment entirely when env is set — then layer
			// the server's decrypted env vars on top. Drop undefined values so
			// the result is a clean Record<string, string>.
			env: Object.fromEntries(
				Object.entries({ ...process.env, ...envOf(server) }).filter(([, v]) => v !== undefined)
			) as Record<string, string>,
			// Default is 'inherit', which dumps a misconfigured server's crash
			// output into Galaxy's own log. Pipe it and keep the tail so the
			// admin sees the actual reason instead of "Connection closed".
			stderr: 'pipe'
		});
		stdio.stderr?.on('data', (chunk: Buffer | string) => {
			const tail = ((lastStderr.get(server.id) ?? '') + String(chunk)).slice(-STDERR_TAIL_CHARS);
			lastStderr.set(server.id, tail);
		});
		transport = stdio;
	} else {
		transport = new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
			requestInit: { headers: headersOf(server) }
		});
	}

	// A transport can fail long after connect resolves — the child exits, the
	// socket drops. Unhandled, that error terminates the whole process, so it
	// has to be absorbed here. Protocol.connect chains onto this handler, and
	// client.onerror covers everything after the handshake.
	const absorb = (err: unknown) => {
		recordServerError(server.id, messageOf(err));
		disconnect(server.id);
	};
	transport.onerror = absorb;
	client.onerror = absorb;

	try {
		await withTimeout(
			client.connect(transport),
			CONNECT_TIMEOUT_MS,
			`Timed out connecting to ${server.name}`
		);
	} catch (err) {
		await transport.close().catch(() => {});
		const detail = await stderrDetail(server.id);
		// Rethrow as-is when there's nothing to add, so callers keep the
		// transport's HTTP status — flattening this to a plain Error is what hid
		// the 401 from explainAuthFailure.
		if (!detail) throw err;
		const wrapped = new Error(`${messageOf(err)} — ${detail}`, { cause: err });
		(wrapped as { code?: unknown }).code = (err as { code?: unknown })?.code;
		throw wrapped;
	}

	pool.set(server.id, {
		client,
		idleTimer: setTimeout(() => disconnect(server.id), IDLE_MS)
	});
	return client;
}

function messageOf(err: unknown): string {
	return String(err instanceof Error ? err.message : err);
}

/** The child's dying words, if it left any. Empty for an HTTP server. */
async function stderrDetail(id: string): Promise<string> {
	await new Promise((resolve) => setTimeout(resolve, STDERR_SETTLE_MS));
	return summariseStderr(lastStderr.get(id) ?? '');
}

/**
 * Why a server call failed, in terms an admin can act on.
 *
 * "Connection closed" says a stdio child went away and nothing about why —
 * an expired token, a file the token cannot reach, a payload big enough to
 * exhaust its memory all look identical. Appending what the child printed is
 * the difference between a reason and a shrug.
 */
async function describeFailure(serverId: string, err: unknown): Promise<string> {
	const base = explainAuthFailure(err) ?? messageOf(err);
	const detail = await stderrDetail(serverId);
	// The handshake path already appends the detail, so don't say it twice.
	return detail && !base.includes(detail) ? `${base} — ${detail}` : base;
}

/**
 * Turn an auth rejection into something an admin can act on. The raw transport
 * string ("Error POSTing to endpoint: Unauthorized") says nothing about what the
 * server actually wants, and the most common cause — a server that requires an
 * OAuth login rather than a token — isn't something Galaxy supports at all.
 */
export function explainAuthFailure(err: unknown): string | null {
	const message = messageOf(err);
	// Read `code` structurally rather than via `instanceof StreamableHTTPError`:
	// the bundler can end up with two copies of the SDK's class, so the identity
	// check fails at runtime even though the field is there. Node system errors
	// use string codes ('ENOTFOUND'), hence the typeof guard.
	const raw = (err as { code?: unknown })?.code;
	const code =
		typeof raw === 'number' ? raw : Number(/\b(401|403)\b/.exec(message)?.[1]) || undefined;
	const unauthorized = code === 401 || code === 403 || /unauthorized|forbidden/i.test(message);
	if (!unauthorized) return null;
	return [
		`The server rejected Galaxy's credentials (HTTP ${code ?? '401/403'}).`,
		'Usually the Authorization header is missing or wrong — check the headers field.',
		'Servers that require an OAuth sign-in instead of a token are not supported;',
		'see docs/MCP.md for which servers work with a static token.'
	].join(' ');
}

/**
 * Pull the one useful line out of a crashed child's stderr. Node prints the
 * error first and a stack trace after, so the tail is the least informative
 * part — reach for the message instead.
 */
export function summariseStderr(text: string): string {
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.length) return '';
	const errorLine = lines.find((l) => /(^|\s)[A-Za-z]*Error\b|error:/i.test(l));
	return (errorLine ?? lines[0]).slice(0, 300);
}

/** Record a failure without letting a DB problem escalate into a crash. */
function recordServerError(id: string, message: string): void {
	try {
		db.update(mcpServers)
			.set({ status: 'error', lastError: message })
			.where(eq(mcpServers.id, id))
			.run();
	} catch {
		// Nothing useful to do from an async error handler.
	}
}

export function disconnect(id: string): void {
	const pooled = pool.get(id);
	if (!pooled) return;
	clearTimeout(pooled.idleTimer);
	pool.delete(id);
	void pooled.client.close().catch(() => {});
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		p.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

// --- discovery -------------------------------------------------------------

export interface SyncResult {
	ok: boolean;
	toolCount: number;
	error?: string;
}

/** Connect, list tools, and cache them. Also the admin "Test" action. */
export async function syncServer(id: string): Promise<SyncResult> {
	const server = getServer(id);
	if (!server) throw new McpConfigError('Server not found');

	try {
		const client = await connect(server);
		const listed = await withTimeout(
			client.listTools(),
			CONNECT_TIMEOUT_MS,
			`Timed out listing tools on ${server.name}`
		);

		const seen = new Set<string>();
		for (const tool of listed.tools) {
			const name = qualifiedName(server, tool.name);
			seen.add(name);
			const row = {
				id: `${server.id}:${tool.name}`,
				serverId: server.id,
				name,
				remoteName: tool.name,
				description: tool.description ?? '',
				parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<
					string,
					unknown
				>
			};
			const existing = db.select().from(mcpTools).where(eq(mcpTools.id, row.id)).get();
			if (existing) db.update(mcpTools).set(row).where(eq(mcpTools.id, row.id)).run();
			else db.insert(mcpTools).values(row).run();
		}
		// Drop tools the server no longer advertises.
		for (const cached of listServerTools(server.id)) {
			if (!seen.has(cached.name)) {
				db.delete(mcpTools).where(eq(mcpTools.id, cached.id)).run();
			}
		}

		db.update(mcpServers)
			.set({ status: 'ok', lastError: null, lastSyncAt: new Date() })
			.where(eq(mcpServers.id, id))
			.run();
		return { ok: true, toolCount: listed.tools.length };
	} catch (err) {
		const message = await describeFailure(id, err);
		disconnect(id);
		db.update(mcpServers)
			.set({ status: 'error', lastError: message, lastSyncAt: new Date() })
			.where(eq(mcpServers.id, id))
			.run();
		return { ok: false, toolCount: 0, error: message };
	}
}

// --- execution -------------------------------------------------------------

function serverOffersTask(server: McpServer, task: string): boolean {
	return !server.tasks || server.tasks.includes(task);
}

/**
 * Tools from every enabled server scoped to this task, built from the cached
 * catalogue so no network call happens while assembling a turn.
 *
 * A server that has gone away is still offered: the failure surfaces as a tool
 * error the model can react to and report, which beats silently losing a
 * capability, and the server row records the error for admin.
 */
export function mcpLoopTools(task: string): LoopTool[] {
	const servers = listServers().filter((s) => s.enabled && serverOffersTask(s, task));
	const out: LoopTool[] = [];

	for (const server of servers) {
		for (const tool of listServerTools(server.id)) {
			out.push({
				def: {
					name: tool.name,
					description: tool.description || `${tool.remoteName} (via ${server.name})`,
					parameters: tool.parameters ?? { type: 'object', properties: {} }
				},
				describe: (args) => {
					const first = Object.values(args)[0];
					return typeof first === 'string' ? first.slice(0, 80) : '';
				},
				execute: async (args, report) => {
					const result = await callRemote(server.id, tool.remoteName, args);
					report?.({ mcpServer: server.name });
					return result;
				}
			});
		}
	}
	return out;
}

async function callRemote(
	serverId: string,
	remoteName: string,
	args: Record<string, unknown>
): Promise<string> {
	const server = getServer(serverId);
	if (!server) throw new Error('MCP server no longer configured');

	try {
		const client = await connect(server);
		const result = await withTimeout(
			client.callTool({ name: remoteName, arguments: args }),
			CALL_TIMEOUT_MS,
			`Timed out calling ${remoteName} on ${server.name}`
		);
		if (result.isError) throw new Error(renderContent(result.content) || 'Tool reported an error');
		return renderContent(result.content) || '(no output)';
	} catch (err) {
		// Read the child's stderr before disconnecting: this is the path where a
		// server dies mid-call, and its complaint is the only thing that
		// distinguishes one cause of "Connection closed" from another.
		const message = await describeFailure(serverId, err);
		// A dead socket must not be reused on the next call.
		disconnect(serverId);
		recordServerError(serverId, message);
		throw new Error(`${server.name}: ${message}`);
	}
}

/** Flatten MCP content blocks to the text the model gets back. */
function renderContent(content: unknown): string {
	if (!Array.isArray(content)) return '';
	return content
		.map((block) => {
			const b = block as { type?: string; text?: string; mimeType?: string };
			if (b.type === 'text') return b.text ?? '';
			if (b.type === 'resource') return JSON.stringify(block);
			return `[${b.type ?? 'unknown'} content omitted]`;
		})
		.filter(Boolean)
		.join('\n');
}

/** Cached MCP tools as catalogue entries for the admin Tools list. */
export function mcpDescriptors(): ToolDescriptor[] {
	const servers = new Map(listServers().map((s) => [s.id, s]));
	return listServerTools()
		.filter((t) => servers.has(t.serverId))
		.map((t) => {
			const server = servers.get(t.serverId)!;
			return {
				name: t.name,
				source: 'mcp' as const,
				group: server.name,
				tasks: server.tasks ?? ['chat', 'coding'],
				description: t.description,
				parameters: t.parameters ?? { type: 'object', properties: {} },
				serverId: server.id,
				note: server.enabled ? undefined : 'server disabled'
			};
		});
}
