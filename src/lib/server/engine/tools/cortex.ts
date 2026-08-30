import type { LoopTool } from '../loop';
import {
	activate,
	cortexWritesAllowed,
	effectiveWeight,
	findNodeByName,
	getNode,
	listAssociations,
	saveAssociation,
	saveNode,
	type CortexNode
} from '$lib/server/cortex';
import { toolResultMaxChars } from '../limits';
import { rememberActivation } from '../cortex-learn';

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
export function cortexTools(
	userId: string,
	writes = cortexWritesAllowed(),
	/**
	 * Which conversation this toolset belongs to, so a query can be checked
	 * against the reply it fed. Absent for the catalogue in Admin -> Tools, which
	 * builds a toolset only to read its definitions.
	 */
	chatId: string | null = null
): LoopTool[] {
	const tools: LoopTool[] = [
		{
			parallelSafe: true,
			def: {
				name: 'cortex_query',
				description:
					'Read the working map of who you are talking to. The lattice holds their ' +
					'concepts and how those connect — what is currently true of them, their work ' +
					'and their world, not a log of past events. Give it what the conversation is ' +
					'about and it returns the concepts that bear on it plus how they relate, ' +
					'including ones the question never named and you would not have known to ask ' +
					'for. Worth calling before answering anything where the right answer depends ' +
					'on who this person is, which is most things that are not purely factual. ' +
					'Pass from_node instead of query to explore outward from a concept you have.',
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

				// Held until the turn ends, when whichever of these concepts the
				// reply actually used strengthens the connections that delivered it.
				// Nothing is written here: a query is not evidence that its answer
				// was worth anything, which is the whole point of waiting.
				rememberActivation(chatId, userId, result);

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
				// Prescriptive, not descriptive. The first version said what the tool
				// was and what belonged in it, and never when to reach for it — so a
				// model read it as available-on-request and went a whole conversation
				// without noticing an occasion. Asked why, it said exactly that: no
				// behavioural trigger, unlike every skill description it had.
				'Record a concept in the knowledge lattice and connect it to what it relates to.\n\n' +
				'Use this on your own initiative, not only when asked. A concept worth keeping ' +
				'almost always surfaces in the middle of a conversation about something else, so ' +
				'watch for it rather than waiting to be told. Reach for this when: the person ' +
				'argues for a position of their own; they put two ideas together into a synthesis; ' +
				'an interest keeps resurfacing across unrelated topics; or they develop an idea ' +
				'across several turns rather than mentioning it once.\n\n' +
				'A concept, not a fact — facts belong in memory. The test is whether the thing has ' +
				'edges. A named position that connects to other ideas is a concept: "the view that ' +
				"institutions decay by succeeding\", which connects to their reading, their work and " +
				'their scepticism about growth. "Interested in politics" has nowhere to go and ' +
				'belongs in memory. Meta-observations qualify when they connect: "keeps finding the ' +
				'same structure in unrelated fields" is a concept; "asked about physics" is not.\n\n' +
				'Connect it as you create it. An unconnected concept is invisible to every future ' +
				'query, so a concept with no connections is a note nobody will ever read. When in ' +
				'doubt, record it: the lattice is reviewed and pruned, and a missed concept is the ' +
				'more expensive mistake.',
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
		// Effective strength, which is what the traversal actually spent getting
		// here — showing the authored number instead would explain the ordering
		// wrongly whenever learning has moved one.
		.sort((a, b) => effectiveWeight(b) - effectiveWeight(a))
		.slice(0, 5)
		.map((e) => {
			const otherId = e.sourceId === node.id ? e.targetId : e.sourceId;
			const other = getNode(otherId, userId);
			if (!other) return null;
			return `  → ${other.name} (${effectiveWeight(e).toFixed(2)})${e.description ? `: ${e.description}` : ''}`;
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
