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
		}
	]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === 'explode') {
		return { content: [{ type: 'text', text: 'boom' }], isError: true };
	}
	const city = req.params.arguments?.city ?? 'nowhere';
	return { content: [{ type: 'text', text: `Forecast for ${city}: 18C and clear.` }] };
});

await server.connect(new StdioServerTransport());
