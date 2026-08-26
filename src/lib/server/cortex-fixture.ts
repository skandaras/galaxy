import { saveAssociation, saveNode } from '$lib/server/cortex';

/**
 * A lattice to measure retrieval against. Fiction, and imported only by tests.
 *
 * It belongs to nobody real: a coastal naturalist who also runs a letterpress
 * and teaches evening classes. Three clusters that do not share vocabulary,
 * bridged by three convergence nodes, plus one deliberate orphan.
 *
 * The shape is the point. A lattice whose clusters share words would let plain
 * search score well and prove nothing, so the vocabularies are kept apart and
 * several nodes can only be reached by walking an edge. Those are the cases the
 * eval exists to watch — if traversal breaks, search alone still answers the
 * easy half, and only the hard half will say so.
 */

interface FixtureNode {
	name: string;
	description: string;
	modalities: string[];
	convergence?: boolean;
	priority?: number;
}

const NODES: FixtureNode[] = [
	// Coastal fieldwork.
	{
		name: 'Tide pools',
		description: 'Rockpool surveying at low water, species counts by quadrat',
		modalities: ['field', 'scientific'],
		priority: 0.8
	},
	{
		name: 'Seabird counts',
		description: 'The annual colony census on the headland',
		modalities: ['field', 'scientific']
	},
	{
		name: 'Storm logs',
		description: 'Recording wind, swell and damage after each blow',
		modalities: ['field', 'scientific']
	},
	{
		name: 'Shoreline erosion',
		description: 'Tracking how far the cliff edge retreats each winter',
		modalities: ['field', 'scientific']
	},
	{
		name: 'Salinity readings',
		description: 'Weekly samples drawn at the estuary mouth',
		modalities: ['field', 'scientific']
	},

	// Letterpress.
	{
		name: 'Hand-set type',
		description: 'Composing lines letter by letter out of the case',
		modalities: ['craft', 'making'],
		priority: 0.8
	},
	{
		name: 'Ink mixing',
		description: 'Matching a colour by eye and holding it across batches',
		modalities: ['craft', 'making']
	},
	{
		name: 'Paper stock',
		description: 'Choosing weight and grain direction for a press run',
		modalities: ['craft', 'making']
	},
	{
		name: 'Press maintenance',
		description: 'Keeping an old platen press in register and running',
		modalities: ['craft', 'making']
	},
	{
		name: 'Edition binding',
		description: 'Sewing and casing a finished run by hand',
		modalities: ['craft', 'making']
	},

	// Teaching.
	{
		name: 'Evening classes',
		description: 'Weekly sessions in the village hall, mixed ability',
		modalities: ['teaching', 'social'],
		priority: 0.7
	},
	{
		name: 'Workshop planning',
		description: 'Sequencing a day so that beginners finish something',
		modalities: ['teaching', 'social']
	},
	{
		name: 'Apprentices',
		description: 'Two people learning the press across a year',
		modalities: ['teaching', 'social']
	},
	{
		name: 'Explaining to novices',
		description: 'Finding words for something you normally do by feel',
		modalities: ['teaching', 'social']
	},

	// Convergence: the bridges the whole design is a bet on.
	{
		name: 'Patient observation',
		description: 'Returning to the same thing repeatedly until it gives something up',
		modalities: ['field', 'craft', 'teaching'],
		convergence: true,
		priority: 0.75
	},
	{
		name: 'Making things legible',
		description: 'Turning what you notice into something another person can read',
		modalities: ['field', 'craft', 'teaching'],
		convergence: true,
		priority: 0.75
	},
	{
		name: 'Working to a tide',
		description: 'Planning around a constraint that pays no attention to your schedule',
		modalities: ['field', 'craft'],
		convergence: true,
		priority: 0.7
	},

	// The orphan. Nothing connects to it, and a query for it should return it
	// and nothing else — an unconnected node is invisible to traversal, which is
	// worth having a case for.
	{
		name: 'Bicycle repair',
		description: 'A weekend habit unrelated to everything else here',
		modalities: ['other']
	}
];

type Edge = [string, string, number, string[]];

const EDGES: Edge[] = [
	// Fieldwork.
	['tide-pools', 'salinity-readings', 0.8, ['field']],
	['tide-pools', 'shoreline-erosion', 0.6, ['field']],
	['seabird-counts', 'storm-logs', 0.7, ['field']],
	['shoreline-erosion', 'storm-logs', 0.8, ['field']],

	// Letterpress.
	['hand-set-type', 'ink-mixing', 0.7, ['craft']],
	['hand-set-type', 'paper-stock', 0.75, ['craft']],
	['ink-mixing', 'paper-stock', 0.6, ['craft']],
	['press-maintenance', 'hand-set-type', 0.65, ['craft']],
	['edition-binding', 'paper-stock', 0.8, ['craft']],

	// Teaching.
	['evening-classes', 'workshop-planning', 0.85, ['teaching']],
	['evening-classes', 'apprentices', 0.7, ['teaching']],
	['workshop-planning', 'explaining-to-novices', 0.8, ['teaching']],
	['apprentices', 'explaining-to-novices', 0.75, ['teaching']],

	// Patient observation bridges field and craft.
	['patient-observation', 'tide-pools', 0.85, ['field']],
	['patient-observation', 'seabird-counts', 0.8, ['field']],
	['patient-observation', 'ink-mixing', 0.75, ['craft']],
	['patient-observation', 'hand-set-type', 0.7, ['craft']],

	// Making things legible bridges all three.
	['making-things-legible', 'storm-logs', 0.7, ['field']],
	['making-things-legible', 'hand-set-type', 0.8, ['craft']],
	['making-things-legible', 'explaining-to-novices', 0.85, ['teaching']],
	['making-things-legible', 'evening-classes', 0.7, ['teaching']],

	// Working to a tide bridges field and craft.
	['working-to-a-tide', 'tide-pools', 0.9, ['field']],
	['working-to-a-tide', 'press-maintenance', 0.65, ['craft']],
	['working-to-a-tide', 'edition-binding', 0.6, ['craft']]
];

export function seedFixtureLattice(userId: string): void {
	for (const n of NODES) {
		saveNode({
			name: n.name,
			description: n.description,
			modalities: n.modalities,
			isConvergence: n.convergence ?? false,
			activationPriority: n.priority ?? 0.5,
			ownerId: userId
		});
	}
	for (const [source, target, weight, tags] of EDGES) {
		saveAssociation({ sourceId: source, targetId: target, weight, contextTags: tags, userId });
	}
}

export interface EvalQuery {
	/** What the query is testing, so a failure names its own cause. */
	kind: 'search' | 'traversal' | 'convergence' | 'negative';
	query: string;
	/** Node ids a person says should surface. Empty means "nothing should". */
	expect: string[];
}

/**
 * Twenty questions and the answers a human would give.
 *
 * `search` cases are the easy half — the words are in the node. `traversal`
 * cases name one node and expect its neighbourhood. `convergence` cases are the
 * design's actual claim: a question landing on a bridge should pull both sides
 * of it. `negative` cases are here because a lattice that answers everything is
 * as useless as one that answers nothing.
 */
export const EVAL_QUERIES: EvalQuery[] = [
	{ kind: 'search', query: 'rockpool surveying quadrat', expect: ['tide-pools'] },
	{ kind: 'search', query: 'colony census headland', expect: ['seabird-counts'] },
	{ kind: 'search', query: 'matching a colour by eye', expect: ['ink-mixing'] },
	{ kind: 'search', query: 'village hall weekly sessions', expect: ['evening-classes'] },
	{ kind: 'search', query: 'weight and grain direction', expect: ['paper-stock'] },

	{
		kind: 'traversal',
		query: 'rockpool',
		expect: ['tide-pools', 'salinity-readings', 'working-to-a-tide', 'patient-observation']
	},
	{
		kind: 'traversal',
		query: 'platen press register',
		expect: ['press-maintenance', 'hand-set-type', 'working-to-a-tide']
	},
	{
		kind: 'traversal',
		query: 'sewing and casing',
		expect: ['edition-binding', 'paper-stock']
	},
	{
		kind: 'traversal',
		query: 'cliff edge retreating each winter',
		expect: ['shoreline-erosion', 'storm-logs', 'tide-pools']
	},
	{
		kind: 'traversal',
		query: 'wind and swell after a blow',
		expect: ['storm-logs', 'shoreline-erosion', 'seabird-counts', 'making-things-legible']
	},
	{
		kind: 'traversal',
		query: 'estuary samples',
		expect: ['salinity-readings', 'tide-pools']
	},
	{
		kind: 'traversal',
		query: 'composing lines out of the case',
		expect: ['hand-set-type', 'ink-mixing', 'paper-stock', 'making-things-legible']
	},
	{
		kind: 'traversal',
		query: 'sequencing a day for beginners',
		expect: ['workshop-planning', 'evening-classes', 'explaining-to-novices']
	},
	{
		kind: 'traversal',
		query: 'people learning the press across a year',
		expect: ['apprentices', 'explaining-to-novices', 'evening-classes']
	},

	{
		kind: 'convergence',
		query: 'returning to the same thing repeatedly',
		expect: ['patient-observation', 'tide-pools', 'seabird-counts']
	},
	{
		kind: 'convergence',
		query: 'turning what you notice into something readable',
		expect: ['making-things-legible', 'explaining-to-novices', 'hand-set-type']
	},
	{
		kind: 'convergence',
		query: 'planning around a constraint you do not control',
		expect: ['working-to-a-tide', 'tide-pools', 'press-maintenance']
	},
	{
		kind: 'convergence',
		query: 'words for something you do by feel',
		expect: ['explaining-to-novices', 'making-things-legible', 'workshop-planning']
	},

	{ kind: 'negative', query: 'quantum chromodynamics', expect: [] },
	{ kind: 'negative', query: 'sourdough starter hydration', expect: [] }
];
