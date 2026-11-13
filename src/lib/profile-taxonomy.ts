/**
 * The shape of a profile: its domains, kinds and bounds.
 *
 * Its own module, with no server imports, because the survey and the review
 * step in the browser need the same lists the store enforces. The page used to
 * keep its own copy of the kinds, which is one edit away from offering a kind
 * the store refuses.
 */

export const DOMAINS = ['identity', 'work', 'people', 'life', 'interests'] as const;
export type Domain = (typeof DOMAINS)[number];

/** A pattern is something seen across separate conversations, never said outright. */
export const KINDS = ['fact', 'preference', 'constraint', 'goal', 'pattern'] as const;
export type Kind = (typeof KINDS)[number];

export const ENTITY_KINDS = ['person', 'pet', 'organisation', 'project', 'place'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const SENSITIVITIES = ['normal', 'personal', 'private'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/**
 * Suggestions, in the order a person reads them. `people` has none: its second
 * level is the person, because a relation-named bucket ("family") would hold a
 * son and a dog together and a partner alone.
 */
export const SEED_SUBDOMAINS: Record<Exclude<Domain, 'people'>, readonly string[]> = {
	identity: ['basics', 'background', 'culture', 'replies'],
	work: ['role', 'organisation', 'expertise', 'tools', 'projects'],
	life: ['home', 'routines', 'commitments', 'logistics', 'constraints', 'health', 'money'],
	interests: ['pursuits', 'taste', 'learning']
};

/**
 * Decided by the path, so a model filing a claim never decides how private it
 * is. A person can change it per entry. People's cards are personal; anything
 * not named here is normal. The review shows it, so a person sees which lines
 * will be private before they save them.
 */
export const PATH_SENSITIVITY: Record<string, Sensitivity> = {
	'identity/culture': 'personal',
	'life/home': 'personal',
	'life/health': 'private',
	'life/money': 'private'
};

/**
 * Where a person's preferences about replies are kept: length, tone, units,
 * spelling. The one place in a profile that is about the assistant rather
 * than the person, so it is held small and rendered apart from the rest.
 */
export const REPLIES_PATH = 'identity/replies';

/** Places held tighter than the subdomain cap. */
const PATH_CAPS: Record<string, number> = { [REPLIES_PATH]: 8 };

export function capFor(domain: string, subdomain: string): number {
	if (domain === 'people') return LIMITS.entriesPerPerson;
	return PATH_CAPS[`${domain}/${subdomain}`] ?? LIMITS.entriesPerSubdomain;
}

type Tiered = { kind: string; domain: string; subdomain: string; source: string; expiresAt: unknown };

const FLUID_KINDS: readonly string[] = ['preference', 'goal', 'pattern'];
const isProject = (e: Tiered) => e.domain === 'work' && e.subdomain === 'projects';

/**
 * The two tiers. A fact or a constraint the person told Galaxy is durable: it
 * changes only when they say otherwise. Everything else is fluid, and the
 * learning job may reword or retire it as the picture shifts.
 *
 * Derived from what an entry is rather than stored beside it. A tier column
 * would have to be kept in step with the kind and the path, and an entry
 * moved or re-kinded would carry the wrong one.
 */
export function isFluid(e: Tiered): boolean {
	return FLUID_KINDS.includes(e.kind) || isProject(e) || !!e.expiresAt || e.source === 'inferred';
}

/**
 * Whether an entry goes when nothing has borne it out for `lapseDays`. Narrower
 * than fluid: a preference the person stated ("prefers trains to flying")
 * stays true for years with nobody repeating it, where a goal, a project and
 * anything read between the lines do not.
 */
export function lapses(e: Tiered & { pinned: boolean }): boolean {
	if (e.pinned || e.expiresAt) return false;
	return e.source === 'inferred' || e.kind === 'goal' || e.kind === 'pattern' || isProject(e);
}

export const LIMITS = {
	entriesPerUser: 500,
	entriesPerSubdomain: 25,
	/** A person's card, `people/<id>`. Their claims elsewhere count where they are filed. */
	entriesPerPerson: 8,
	entitiesPerUser: 60,
	customSubdomainsPerDomain: 4,
	/** The pinned brief, in characters: tokens depend on the provider, characters do not. */
	briefChars: 2_400,
	namesShown: 12,
	namesChars: 400,
	claimMin: 8,
	claimMax: 160,
	quoteMax: 280,
	nameMax: 40,
	akaCount: 4,
	relationMax: 32,
	subdomainMax: 24,
	expiryDays: 90,
	/** A lapsing entry nothing has borne out for this long is retired. */
	lapseDays: 180,
	searchLines: 12,
	/** A subdomain read shows the whole subdomain, so it is held to the subdomain's cap. */
	pathLines: 25,
	lookupChars: 4_000
} as const;
