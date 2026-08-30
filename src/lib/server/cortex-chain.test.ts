import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import {
	chats,
	cortexAssociations,
	cortexChangeLog,
	cortexNodes,
	cortexProposals,
	messages,
	settings as settingsTable
} from '$lib/server/db/schema';
import {
	activate,
	cortexDigest,
	listAssociations,
	listChanges,
	listNodes,
	revertRun,
	saveCircuit,
	saveNode
} from '$lib/server/cortex';

/**
 * One test that walks the whole claim: a conversation becomes a concept becomes
 * context.
 *
 * Every link in this chain has been reported working in a commit message at
 * some point, and two of them were not — undo restored modifications but not
 * creations, and Accept flipped a status flag and changed no lattice. Both were
 * found by writing a test that walked the whole thing rather than the piece in
 * front of me. This is that test, kept.
 */

let scripted = '{"proposals":[]}';

vi.mock('$lib/server/engine/engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/engine/engine')>();
	return {
		...actual,
		getTaskConfig: () => ({ task: 'cortex-groom', systemPrompt: '' }),
		pickModel: () => ({
			model: { modelKey: 'mock/model' },
			provider: {},
			adapter: {
				complete: async () => ({
					text: scripted,
					usage: { promptTokens: 10, completionTokens: 5 },
					finishReason: 'stop'
				})
			}
		})
	};
});

const { runCortexGroom, listProposals, decideProposal } = await import(
	'$lib/server/engine/cortex-groom'
);

const ANA = 'user-ana';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(cortexAssociations).run();
	db.delete(cortexChangeLog).run();
	db.delete(cortexProposals).run();
	db.delete(cortexNodes).run();
	db.delete(messages).run();
	db.delete(chats).run();
	db.delete(settingsTable).run();
	db.run(`DELETE FROM cortex_fts`);
});

/** A conversation for the harvest to find. */
function haveTalkedAbout(text: string) {
	const now = new Date();
	db.insert(chats)
		.values({
			id: 'chat-1',
			userId: ANA,
			title: 'A conversation',
			mode: 'chat',
			createdAt: now,
			updatedAt: now
		})
		.run();
	db.insert(messages)
		.values({
			id: 'msg-1',
			chatId: 'chat-1',
			seq: 1,
			role: 'user',
			content: text,
			createdAt: now
		})
		.run();
}

describe('conversation → concept → context', () => {
	it('walks the whole way, and back again', async () => {
		// An existing concept for the new one to attach to, filed under an area.
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		const anchor = saveNode({
			name: 'Coastal ecology',
			description: 'Shoreline systems',
			ownerId: ANA,
			circuits: [area.id]
		});
		saveNode({ name: 'Storm logs', ownerId: ANA, circuits: [area.id] });

		haveTalkedAbout('I spent the morning surveying rockpools at low water again.');

		// 1. The harvest reads what was said and proposes a concept.
		scripted = JSON.stringify({
			proposals: [
				{
					kind: 'create',
					title: 'Add "Tide pools"',
					rationale: 'came up in conversation and connects to work already here',
					payload: {
						name: 'Tide pools',
						description: 'Rockpool surveying at low water',
						connect: [{ node: anchor.id, weight: 0.8, why: 'where the surveying happens' }]
					}
				}
			]
		});
		const run = await runCortexGroom('schedule', ANA);
		expect(run.ran).toBe(true);
		expect(run.mode).toBe('harvest');

		const proposal = listProposals(ANA).find((p) => p.kind === 'create');
		expect(proposal, 'the harvest should have proposed a concept').toBeTruthy();

		// 2. Accepting applies it — the link that was a status flag for a phase.
		expect(decideProposal(proposal!.id, ANA, 'actioned').ok).toBe(true);

		const made = listNodes(ANA).find((n) => n.name === 'Tide pools');
		expect(made, 'accepting should have created the concept').toBeTruthy();
		// With its connections: an unconnected concept can never surface, so
		// creating one alone would be a null change dressed as progress.
		expect(listAssociations(made!.id, ANA)).toHaveLength(1);

		// 3. It is reachable by a question that never names it.
		const found = activate({ userId: ANA, query: 'rockpool surveying' }).nodes;
		expect(found.map((n) => n.node.id)).toContain(made!.id);
		// And traversal carries the question on to what it connects to.
		expect(found.map((n) => n.node.id)).toContain(anchor.id);

		// 4. It reaches an agent's prompt, under an area it can be found by.
		expect(cortexDigest(ANA)).toContain('Coastal fieldwork');

		// 5. And the whole acceptance comes back out in one go.
		const created = listChanges(ANA).find((c) => c.event === 'created' && c.actor === 'groom');
		expect(created?.runId).toBeTruthy();
		expect(revertRun(created!.runId!, ANA)).toBeGreaterThan(0);
		expect(listNodes(ANA).map((n) => n.name)).not.toContain('Tide pools');
	});

	it('does not reach the lattice on its own', async () => {
		saveNode({ name: 'Coastal ecology', ownerId: ANA });
		haveTalkedAbout('I spent the morning surveying rockpools.');
		scripted = JSON.stringify({
			proposals: [
				{ kind: 'create', title: 'Add "Tide pools"', payload: { name: 'Tide pools' } }
			]
		});

		await runCortexGroom('schedule', ANA);
		// The whole point of a review queue: proposed is not applied, and a
		// harvest that quietly wrote to the lattice would be agent writes by
		// another name.
		//
		// Counted by kind rather than in total, because the free detectors file
		// alongside the model — the orphans and unfiled concepts this fixture
		// deliberately has.
		expect(listProposals(ANA).filter((p) => p.kind === 'create')).toHaveLength(1);
		expect(listNodes(ANA).map((n) => n.name)).not.toContain('Tide pools');
	});

	it('reads the conversation it was given', async () => {
		saveNode({ name: 'Coastal ecology', ownerId: ANA });
		saveNode({ name: 'Storm logs', ownerId: ANA });
		haveTalkedAbout('a distinctive phrase about quadrat sampling');
		await runCortexGroom('schedule', ANA);
		// If the activity window is wired up wrong the harvest still "works" —
		// it just proposes from nothing, forever.
		const { buildGroomPrompt } = await import('$lib/server/engine/cortex-groom');
		const prompt = buildGroomPrompt(ANA, 5, 'harvest', 'a distinctive phrase about quadrat sampling');
		expect(prompt).toContain('quadrat sampling');
	});
});
