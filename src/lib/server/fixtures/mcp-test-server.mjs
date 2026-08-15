// A minimal stdio MCP server used by mcp.test.ts to exercise the real client:
// discovery, a successful call, and a tool that reports an error.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fake-weather', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: 'get_forecast',
			description: 'Return a fake forecast for a city.',
			inputSchema: {
				type: 'object',
				properties: { city: { type: 'string', description: 'City name' } },
				required: ['city']
			}
		},
		{
			name: 'explode',
			description: 'Always reports an error, to check error handling.',
			inputSchema: { type: 'object', properties: {} }
		},
		{
			name: 'echo_env',
			description: 'Echo a process environment variable, to verify the stdio transport passes env.',
			inputSchema: {
				type: 'object',
				properties: { name: { type: 'string', description: 'Env var name' } },
				required: ['name']
			}
		},
		{
			name: 'die',
			description:
				'Complain on stderr and exit without answering, the way a real server does when its API token is rejected or a read exhausts its memory.',
			inputSchema: { type: 'object', properties: {} }
		}
	]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === 'explode') {
		return { content: [{ type: 'text', text: 'boom' }], isError: true };
	}
	// Dies without answering. The client only sees the pipe close — the reason
	// exists solely on stderr, which is the whole point of capturing it.
	if (req.params.name === 'die') {
		process.stderr.write('Error: 403 Forbidden — token cannot reach this file\n');
		// Give the write a tick to reach the parent before the process goes.
		setTimeout(() => process.exit(1), 10);
		return new Promise(() => {});
	}
	if (req.params.name === 'echo_env') {
		const name = req.params.arguments?.name ?? '';
		return { content: [{ type: 'text', text: process.env[name] ?? '' }] };
	}
	const city = req.params.arguments?.city ?? 'nowhere';
	return { content: [{ type: 'text', text: `Forecast for ${city}: 18C and clear.` }] };
});

await server.connect(new StdioServerTransport());
