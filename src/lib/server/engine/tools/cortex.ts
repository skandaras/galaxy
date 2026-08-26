import type { LoopTool } from '../loop';
import {
	activate,
	cortexWritesAllowed,
	findNodeByName,
	getNode,
	listAssociations,
	saveAssociation,
	saveNode,
	type CortexNode
} from '$lib/server/cortex';
import { toolResultMaxChars } from '../limits';

/**
 * Lattice access for agents.
 *
 * `userId` scopes every call to what that person may see. It is not optional:
 * Cortex is a store whose contents reach a *different* user's prompt if it is
 * read carelessly, which puts it in the same class as the Library and memory.
 *
 * Writes are gated on the `cortex.agentWrites` setting, and unlike boards it
 * ships off. An agent free to mint nodes produces near-duplicates faster than
 * anyone merges them, and the grooming agent that would merge them does not
 * exist yet.
 *
 * Two tools rather than the seven originally proposed. A chat turn already
 * carries around nineteen and every definition is re-sent on every turn, so a
 * new feature has to justify its place in that list; query, activate, traverse
 * and read were one operation reached four ways, and `depth`/`from_node` cover
 * the difference.
 */
export function cortexTools(userId: string, writes = cortexWritesAllowed()): LoopTool[] {
	const tools: LoopTool[] = [
		{
			parallelSafe: true,
			def: {
				name: 'cortex_query',
				description:
					'Search the knowledge lattice and follow its connections. Returns the concepts a ' +
					'question activates plus how they relate — including ones the question never ' +
					'named, reached through the mesh. Use it when a request leans on background ' +
					'about the person, their work or their world. Pass from_node instead of query ' +
					'to explore outward from one concept you already have.',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'What to activate the lattice with' },
						from_node: {
							type: 'string',
							description: 'Node id to start from, instead of a text query'
						},
						depth: {
							type: 'number',
							description: 'How many hops to spread, 1-4. Default 2.'
						}
					}
				}
			},
			describe: (a) => String(a.query ?? a.from_node ?? ''),
			execute: async (a, report) => {
				const query = String(a.query ?? '').trim();
				const fromNodeId = String(a.from_node ?? '').trim() || undefined;
				if (!query && !fromNodeId) throw new Error('query or from_node is required');

				const result = activate({
					userId,
					query,
					fromNodeId,
					depth: a.depth === undefined ? undefined : Number(a.depth)
				});

				// Counts only. Node names and descriptions never reach an event
				// detail — the same rule the alignment module holds itself to, and
				// for the same reason: the Observatory is not the place for the
				// contents of someone's private store.
				report?.({
					seeds: result.seeds.length,
					activated: result.nodes.length,
					maxHops: result.nodes.reduce((m, n) => Math.max(m, n.hops), 0)
				});

				if (!result.nodes.length) {
					return fromNodeId
						? `No node "${fromNodeId}", or nothing connected to it.`
						: 'Nothing in the lattice activated on that.';
				}

				const out = result.nodes.map((a) => renderNode(a.node, a.activation, a.hops, userId));
				const text = out.join('\n\n');
				const cap = toolResultMaxChars();
				return text.length > cap ? `${text.slice(0, cap)}\n\n[truncated]` : text;
			}
		}
	];

	if (!writes) return tools;

	tools.push({
		def: {
			name: 'cortex_write',
			description:
				'Record a concept in the knowledge lattice and connect it to what it relates to. ' +
				'For durable ideas worth carrying across conversations, not scratch notes — a ' +
				'concept, not a fact (facts belong in memory). Connecting it is the point: an ' +
				'unconnected node is invisible to every future query.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Short name for the concept' },
					description: { type: 'string', description: 'What it is and why it matters' },
					connect_to: {
						type: 'array',
						description: 'Existing nodes this relates to',
						items: {
							type: 'object',
							properties: {
								node: { type: 'string', description: 'Node id or exact name' },
								weight: { type: 'number', description: '0.0-1.0, how strongly. Default 0.5.' },
								why: { type: 'string', description: 'Why they connect, in a sentence' }
							},
							required: ['node']
						}
					}
				},
				required: ['name']
			}
		},
		describe: (a) => String(a.name ?? ''),
		execute: async (a, report) => {
			const name = String(a.name ?? '').trim();
			if (!name) throw new Error('name is required');

			// Resolve before creating, so a concept the lattice already holds gains a
			// description rather than a near-identical twin sitting beside it.
			const existing = findNodeByName(name, userId);
			const node = saveNode({
				id: existing?.id,
				name,
				description: String(a.description ?? '') || undefined,
				ownerId: userId,
				actor: 'agent'
			});

			const links = Array.isArray(a.connect_to) ? a.connect_to : [];
			const made: string[] = [];
			const failed: string[] = [];
			for (const raw of links) {
				const link = raw as Record<string, unknown>;
				const ref = String(link.node ?? '').trim();
				if (!ref) continue;
				const target = getNode(ref, userId) ?? findNodeByName(ref, userId);
				if (!target || target.id === node.id) {
					failed.push(ref);
					continue;
				}
				try {
					saveAssociation({
						sourceId: node.id,
						targetId: target.id,
						weight: link.weight === undefined ? undefined : Number(link.weight),
						description: String(link.why ?? '') || undefined,
						userId,
						actor: 'agent'
					});
					made.push(target.name);
				} catch (err) {
					failed.push(`${ref} (${err instanceof Error ? err.message : 'refused'})`);
				}
			}

			report?.({ created: !existing, links: made.length, refused: failed.length });

			const lines = [`${existing ? 'Updated' : 'Created'} "${node.name}" (id: ${node.id})`];
			if (made.length) lines.push(`Connected to: ${made.join(', ')}`);
			if (failed.length) lines.push(`Could not connect to: ${failed.join(', ')}`);
			if (!made.length && !failed.length) {
				lines.push('No connections made — an unconnected node will not surface in a query.');
			}
			return lines.join('\n');
		}
	});

	return tools;
}

function renderNode(node: CortexNode, activation: number, hops: number, userId: string): string {
	const edges = listAssociations(node.id, userId)
		.sort((a, b) => b.weight - a.weight)
		.slice(0, 5)
		.map((e) => {
			const otherId = e.sourceId === node.id ? e.targetId : e.sourceId;
			const other = getNode(otherId, userId);
			if (!other) return null;
			return `  → ${other.name} (${e.weight.toFixed(2)})${e.description ? `: ${e.description}` : ''}`;
		})
		.filter(Boolean);

	return [
		`## ${node.name} (id: ${node.id})`,
		`activation ${activation.toFixed(2)} · ${hops} hop${hops === 1 ? '' : 's'}${node.isConvergence ? ' · bridges domains' : ''}`,
		node.description,
		...(edges.length ? ['connects to:', ...edges] : [])
	]
		.filter(Boolean)
		.join('\n');
}
