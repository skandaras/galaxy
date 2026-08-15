import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db, runMigrations } from '$lib/server/db';
import { mcpServers, mcpTools } from '$lib/server/db/schema';
import {
	createServer,
	deleteServer,
	disconnect,
	explainAuthFailure,
	listServerTools,
	mcpDescriptors,
	mcpLoopTools,
	McpConfigError,
	qualifiedName,
	summariseStderr,
	syncServer,
	updateServer
} from './mcp';

const FIXTURE = resolve('src/lib/server/fixtures/mcp-test-server.mjs');

function addFixtureServer(overrides: Record<string, unknown> = {}) {
	return createServer({
		name: 'Weather',
		transport: 'stdio',
		command: process.execPath,
		args: [FIXTURE],
		...overrides
	});
}

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const s of db.select().from(mcpServers).all()) disconnect(s.id);
	db.delete(mcpTools).run();
	db.delete(mcpServers).run();
});

afterAll(() => {
	for (const s of db.select().from(mcpServers).all()) disconnect(s.id);
});

describe('validation', () => {
	it('requires a url for http servers', () => {
		expect(() => createServer({ name: 'x', transport: 'http' })).toThrow(McpConfigError);
	});

	it('rejects non-http urls', () => {
		expect(() => createServer({ name: 'x', transport: 'http', url: 'ftp://a/b' })).toThrow(
			/http or https/
		);
	});

	it('requires a command for stdio servers', () => {
		expect(() => createServer({ name: 'x', transport: 'stdio' })).toThrow(/Command is required/);
	});

	it('keeps stored headers when a patch omits them', () => {
		const server = createServer({
			name: 'x',
			transport: 'http',
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer t' }
		});
		expect(server.headersEnc).toBeTruthy();
		expect(updateServer(server.id, { name: 'y' }).headersEnc).toBe(server.headersEnc);
		// An explicit null clears them.
		expect(updateServer(server.id, { headers: null }).headersEnc).toBeNull();
	});

	it('encrypts headers rather than storing them in the clear', () => {
		const server = createServer({
			name: 'x',
			transport: 'http',
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer super-secret' }
		});
		expect(server.headersEnc).not.toContain('super-secret');
	});

	it('keeps stored env when a patch omits it', () => {
		const server = createServer({
			name: 'x',
			transport: 'stdio',
			command: process.execPath,
			args: [FIXTURE],
			env: { FIGMA_API_KEY: 'figd_test-key' }
		});
		expect(server.envEnc).toBeTruthy();
		expect(updateServer(server.id, { name: 'y' }).envEnc).toBe(server.envEnc);
		// An explicit null clears it.
		expect(updateServer(server.id, { env: null }).envEnc).toBeNull();
	});

	it('encrypts env rather than storing it in the clear', () => {
		const server = createServer({
			name: 'x',
			transport: 'stdio',
			command: process.execPath,
			args: [FIXTURE],
			env: { FIGMA_API_KEY: 'figd_super-secret' }
		});
		expect(server.envEnc).not.toContain('super-secret');
	});
});

describe('qualifiedName', () => {
	it('prefixes and sanitises so provider name rules are met', () => {
		expect(qualifiedName({ toolPrefix: 'linear' }, 'create_issue')).toBe('linear__create_issue');
		expect(qualifiedName({ toolPrefix: 'my server!' }, 'do.thing')).toBe('my_server__do_thing');
		expect(qualifiedName({ toolPrefix: '' }, 'plain')).toBe('plain');
		expect(qualifiedName({ toolPrefix: 'p' }, 'x'.repeat(200)).length).toBeLessThanOrEqual(64);
	});

	it('derives a default prefix from the server name', () => {
		expect(addFixtureServer({ name: 'My Weather API' }).toolPrefix).toBe('my_weather_api');
	});
});

describe('explainAuthFailure', () => {
	it('explains the 401 a hosted server returns when it wants OAuth', () => {
		// This is what mcp.figma.com produced: a transport string that says
		// nothing about what the server actually wants.
		const err = new StreamableHTTPError(401, 'Error POSTing to endpoint: Unauthorized');
		const out = explainAuthFailure(err)!;
		expect(out).toContain('rejected');
		expect(out).toContain('HTTP 401');
		expect(out).toContain('OAuth');
		expect(out).toContain('docs/MCP.md');
	});

	it('also catches a 403 and a bare message without a code', () => {
		expect(explainAuthFailure(new StreamableHTTPError(403, 'Forbidden'))).toContain('HTTP 403');
		expect(explainAuthFailure(new Error('HTTP 401 Unauthorized'))).toContain('HTTP 401');
	});

	it('recovers the status from the message when the transport drops the code', () => {
		// What actually happens in practice: code is undefined and only the text
		// carries the status.
		const err = new StreamableHTTPError(undefined, 'Error POSTing to endpoint (HTTP 401): Unauthorized');
		expect(explainAuthFailure(err)).toContain('HTTP 401');
	});

	it('leaves unrelated failures alone', () => {
		expect(explainAuthFailure(new Error('fetch failed'))).toBeNull();
		expect(explainAuthFailure(new StreamableHTTPError(500, 'Server error'))).toBeNull();
		expect(explainAuthFailure(new Error('Connection closed'))).toBeNull();
	});
});

describe('summariseStderr', () => {
	it('picks the error line, not the tail of the stack', () => {
		const crash = [
			'node:internal/modules/foo',
			'  throw new ERR_MODULE_NOT_FOUND();',
			"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'",
			'    at Object.getPackageJSONURL',
			'Node.js v22.0.0'
		].join('\n');
		expect(summariseStderr(crash)).toContain("Cannot find package 'x'");
	});

	it('falls back to the first line and handles empty input', () => {
		expect(summariseStderr('something odd\nmore')).toBe('something odd');
		expect(summariseStderr('   \n  ')).toBe('');
	});
});

describe('against a real MCP server', () => {
	it('discovers tools and caches them', async () => {
		const server = addFixtureServer();
		const result = await syncServer(server.id);
		expect(result).toMatchObject({ ok: true, toolCount: 4 });

		const cached = listServerTools(server.id).map((t) => t.name).sort();
		expect(cached).toEqual([
			'weather__die',
			'weather__echo_env',
			'weather__explode',
			'weather__get_forecast'
		]);

		const forecast = listServerTools(server.id).find((t) => t.remoteName === 'get_forecast')!;
		expect(forecast.description).toBe('Return a fake forecast for a city.');
		expect(forecast.parameters).toMatchObject({ required: ['city'] });
	});

	it('calls a tool and returns its text', async () => {
		const server = addFixtureServer();
		await syncServer(server.id);
		const tool = mcpLoopTools('chat').find((t) => t.def.name === 'weather__get_forecast')!;
		expect(tool).toBeDefined();
		await expect(tool.execute({ city: 'Berlin' })).resolves.toBe(
			'Forecast for Berlin: 18C and clear.'
		);
	});

	it('turns a tool-reported error into a throw the agent loop can relay', async () => {
		const server = addFixtureServer();
		await syncServer(server.id);
		const tool = mcpLoopTools('chat').find((t) => t.def.name === 'weather__explode')!;
		await expect(tool.execute({})).rejects.toThrow(/boom/);
	});

	it('drops tools the server stops advertising', async () => {
		const server = addFixtureServer();
		await syncServer(server.id);
		// Simulate a stale row from an earlier version of the server.
		db.insert(mcpTools)
			.values({
				id: `${server.id}:gone`,
				serverId: server.id,
				name: 'weather__gone',
				remoteName: 'gone',
				description: '',
				parameters: null
			})
			.run();
		await syncServer(server.id);
		expect(listServerTools(server.id).map((t) => t.remoteName).sort()).toEqual([
			'die',
			'echo_env',
			'explode',
			'get_forecast'
		]);
	});

	it('records a useful reason when the server cannot start', async () => {
		const server = addFixtureServer({ args: ['/nonexistent/server.mjs'] });
		const result = await syncServer(server.id);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Cannot find module|MODULE_NOT_FOUND/);
		// And the failure is recorded against the server for the admin UI.
		const row = db.select().from(mcpServers).where(eq(mcpServers.id, server.id)).get()!;
		expect(row.status).toBe('error');
		expect(row.lastError).toBeTruthy();
	});

	it('offers nothing from a disabled server', async () => {
		const server = addFixtureServer();
		await syncServer(server.id);
		updateServer(server.id, { enabled: false });
		expect(mcpLoopTools('chat')).toHaveLength(0);
		// But the admin list still shows them, flagged.
		expect(mcpDescriptors()[0].note).toBe('server disabled');
	});

	it('honours per-server task scoping', async () => {
		const server = addFixtureServer();
		await syncServer(server.id);
		updateServer(server.id, { tasks: ['coding'] });
		expect(mcpLoopTools('chat')).toHaveLength(0);
		expect(mcpLoopTools('coding')).toHaveLength(4);
	});

	it('passes stored env vars through to the stdio child process', async () => {
		const server = addFixtureServer({ env: { GALAXY_TEST_TOKEN: 'figd_reached' } });
		await syncServer(server.id);
		const tool = mcpLoopTools('chat').find((t) => t.def.name === 'weather__echo_env')!;
		expect(tool).toBeDefined();
		await expect(tool.execute({ name: 'GALAXY_TEST_TOKEN' })).resolves.toBe('figd_reached');
		// A var that was never set comes back as the empty-output placeholder —
		// confirms the child sees its own env, not a leaked copy of everything
		// Galaxy was launched with.
		await expect(tool.execute({ name: 'NOT_A_REAL_VAR_xyz' })).resolves.toBe('(no output)');
	});

	it('explains a server that dies mid-call instead of just "Connection closed"', async () => {
		// The bug this pins: stderr was captured into a local in connect() and
		// only read if the *handshake* failed. A child that died after that —
		// rejected token, a file the token cannot reach, a read big enough to
		// exhaust its memory — closed the pipe, and every one of those causes
		// arrived as the same bare "MCP error -32000: Connection closed".
		const server = addFixtureServer({ name: 'Figma (read)' });
		expect((await syncServer(server.id)).ok).toBe(true);

		const die = mcpLoopTools('chat').find((t) => t.def.name.endsWith('__die'))!;
		await expect(die.execute({})).rejects.toThrow(/403 Forbidden — token cannot reach this file/);

		// And the admin panel gets the same reason, not the shrug.
		const row = db.select().from(mcpServers).where(eq(mcpServers.id, server.id)).get()!;
		expect(row.lastError).toMatch(/403 Forbidden/);
		expect(row.lastError).not.toBe('MCP error -32000: Connection closed');
	});

	it('still names the server, so a failure says which one it was', async () => {
		const server = addFixtureServer({ name: 'Figma (read)' });
		await syncServer(server.id);
		const die = mcpLoopTools('chat').find((t) => t.def.name.endsWith('__die'))!;
		await expect(die.execute({})).rejects.toThrow(/^Figma \(read\): /);
	});

	it('does not attribute one child\'s last words to the next one', async () => {
		// A reconnect gets a fresh child; carrying the old tail over would
		// explain a new failure with an old server's complaint.
		const server = addFixtureServer();
		await syncServer(server.id);
		const tools = mcpLoopTools('chat');
		await expect(tools.find((t) => t.def.name.endsWith('__die'))!.execute({})).rejects.toThrow(
			/403 Forbidden/
		);

		// The dead child is gone; the next call reconnects and works normally.
		const forecast = mcpLoopTools('chat').find((t) => t.def.name.endsWith('__get_forecast'))!;
		expect(await forecast.execute({ city: 'Wellington' })).toContain('Forecast for Wellington');
		const row = db.select().from(mcpServers).where(eq(mcpServers.id, server.id)).get()!;
		expect(row.lastError).toMatch(/403 Forbidden/); // recorded, but not re-raised
	});

	it('removes cached tools when the server is deleted', async () => {
		const server = addFixtureServer();
		await syncServer(server.id);
		deleteServer(server.id);
		expect(listServerTools()).toHaveLength(0);
		expect(mcpLoopTools('chat')).toHaveLength(0);
	});
});
