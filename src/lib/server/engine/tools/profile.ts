import type { LoopTool } from '../loop';
import { db } from '$lib/server/db';
import { findUserQuote } from '$lib/server/chats';
import {
	addEntry,
	correctEntry,
	createEntity,
	ENTITY_KINDS,
	getEntry,
	KINDS,
	lookup,
	PROFILE_SCOPES,
	ProfileError,
	resolvePath,
	scopeAllows,
	type EntityKind,
	type Kind
} from '$lib/server/profile';

/** Notes one turn may make: a fourth in a single reply is a list, not something said. */
const NOTES_PER_TURN = 3;

/**
 * What a call is about, for the trace and the Observatory: never the words.
 * A person's card shows as `people`, because the path would carry their name.
 */
function where(raw: unknown): string {
	const [domain, sub] = String(raw ?? '')
		.trim()
		.toLowerCase()
		.split('/');
	if (!domain) return 'profile';
	if (domain === 'people' || !sub) return domain;
	return `${domain}/${sub}`;
}

/**
 * The agent's side of the Profile: look things up, and note what the person
 * says about themselves.
 *
 * Both are `privateArgs`: their arguments are about a person, and the
 * Observatory is read by admins.
 */
export function profileTools(
	userId: string,
	opts: { task: string; chatId?: string; hidden?: boolean }
): LoopTool[] {
	const scope = PROFILE_SCOPES[opts.task];
	if (!scope?.tools) return [];
	let notes = 0;

	const tools: LoopTool[] = [
		{
			parallelSafe: true,
			privateArgs: true,
			def: {
				name: 'profile_lookup',
				description:
					'Look something up in what this person has told Galaxy about themselves and their world. ' +
					'Give a name (about), a place in the profile (path: "work/tools", "people/Aroha", a whole ' +
					'domain such as "life", or "now" for what is true only for now), or a few words to search ' +
					'for (query). Use it when a fact about them would change your answer and the profile ' +
					'block does not already carry it. Most turns need none.',
				parameters: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'A few words to search for' },
						path: { type: 'string', description: 'domain, domain/subdomain, people/<name>, or now' },
						about: { type: 'string', description: 'A person or thing by name' }
					},
					required: []
				}
			},
			describe: (a) => (a.about ? 'a person' : a.path ? where(a.path) : 'search'),
			execute: async (a, report) => {
				const res = lookup(userId, opts.task, {
					query: typeof a.query === 'string' ? a.query : undefined,
					path: typeof a.path === 'string' ? a.path : undefined,
					about: typeof a.about === 'string' ? a.about : undefined
				});
				report?.({
					mode: a.about ? 'about' : a.path ? 'path' : 'search',
					shown: res.lines.length,
					omitted: res.omitted
				});
				return res.text;
			}
		}
	];

	// A hidden chat is never written down, and a note is a record of it. Without
	// a chat there is no message the quote could be checked against.
	if (opts.hidden || !opts.chatId) return tools;
	const chatId = opts.chatId;

	tools.push({
		privateArgs: true,
		def: {
			name: 'profile_note',
			description:
				'Note something this person has just told you about themselves or their world, so their ' +
				'agents know it from now on: where they live, who is in their life, what they work with, ' +
				'a constraint such as a diet. Only what would change an answer on another day, never what ' +
				'they asked about or something true of this conversation alone. Quote their own words from ' +
				'this conversation; a note whose quote they did not write is refused. To correct an entry, ' +
				'pass its id as replaces. To file something under a person not yet in the profile, use the ' +
				'path "people/<name>" with their relation. At most three a turn.',
			parameters: {
				type: 'object',
				properties: {
					claim: {
						type: 'string',
						description: 'One fact in the third person, 8 to 160 characters'
					},
					path: {
						type: 'string',
						description: 'Where it belongs: domain/subdomain such as "life/constraints", or "people/<name>"'
					},
					kind: { type: 'string', enum: [...KINDS] },
					quote: {
						type: 'string',
						description: 'Their own words from this conversation that say it'
					},
					replaces: { type: 'string', description: 'The id of an entry this corrects' },
					until: {
						type: 'string',
						description: 'For something true only for now: the date it stops being true, YYYY-MM-DD'
					},
					relation: {
						type: 'string',
						description: 'For someone new: who they are to this person, such as "sister"'
					},
					entity: {
						type: 'string',
						enum: [...ENTITY_KINDS],
						description: 'For someone or something new: what it is. A person unless said otherwise'
					}
				},
				required: ['claim', 'path', 'kind', 'quote']
			}
		},
		describe: (a) => where(a.path),
		execute: async (a, report) => {
			if (notes >= NOTES_PER_TURN) {
				return `Not noted: at most ${NOTES_PER_TURN} notes a turn. Mention anything else in your reply.`;
			}
			const claim = String(a.claim ?? '');
			const quote = String(a.quote ?? '');
			const messageId = findUserQuote(userId, chatId, quote);
			if (!messageId) {
				return 'Not noted: those words are not in anything this person wrote in this conversation. Quote what they said.';
			}
			try {
				const replaces = String(a.replaces ?? '').trim();
				const { entry, overCap, corrected } = replaces
					? correct(replaces, claim, quote, messageId)
					: add(a, claim, quote, messageId);
				notes++;
				report?.({
					entryId: entry.id,
					domain: entry.domain,
					corrected,
					overCap,
					display: { noted: { id: entry.id, claim: entry.claim } }
				});
				return (
					`Noted [${entry.id}] ${entry.claim}` +
					(corrected ? ' (replacing the earlier entry, which the person can still see)' : '') +
					(overCap ? ' That part of the profile is now over its cap and will be tidied later.' : '')
				);
			} catch (err) {
				// Returned rather than thrown, so the reason reaches the model and
				// not the Observatory: it can name the person or the place.
				if (err instanceof ProfileError) return `Not noted: ${err.message}`;
				throw err;
			}
		}
	});

	function correct(id: string, claim: string, quote: string, messageId: string) {
		const old = getEntry(userId, id);
		if (old && !scopeAllows(opts.task, old.domain, old.subdomain)) {
			throw new ProfileError(`No current entry ${id}.`);
		}
		const entry = correctEntry(userId, id, { claim, quote, messageId }, { source: 'stated' });
		return { entry, overCap: false, corrected: true };
	}

	function add(a: Record<string, unknown>, claim: string, quote: string, messageId: string) {
		const kind = String(a.kind ?? '') as Kind;
		const until = String(a.until ?? '').trim();
		let expiresAt: Date | null = null;
		if (until) {
			expiresAt = new Date(`${until}T00:00:00Z`);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(expiresAt.getTime())) {
				throw new ProfileError('until is a date written YYYY-MM-DD.');
			}
		}
		// One transaction, so someone new is not left in the profile with an
		// empty card when the claim about them is refused.
		return db.transaction(() => {
			const { domain, subdomain } = target(String(a.path ?? ''), quote, a);
			if (!scopeAllows(opts.task, domain, subdomain)) {
				const allowed = scope.paths === '*' ? [] : scope.paths;
				throw new ProfileError(`this agent notes only ${allowed.join(' and ')}.`);
			}
			const { entry, overCap } = addEntry(
				userId,
				{ domain, subdomain, kind, claim, quote, messageId, expiresAt },
				{ source: 'stated' }
			);
			return { entry, overCap, corrected: false };
		});
	}

	/** The path, or for `people/<name>` someone new, if the person named them. */
	function target(path: string, quote: string, a: Record<string, unknown>) {
		try {
			return resolvePath(userId, path);
		} catch (err) {
			const person = /^people\/(.+)$/i.exec(path.trim());
			const relation = String(a.relation ?? '').trim();
			if (!(err instanceof ProfileError) || !person || !relation || !scope.names) throw err;
			const name = person[1].trim();
			if (!quote.toLowerCase().includes(name.toLowerCase())) {
				throw new ProfileError(`to add ${name}, the quote has to name them.`);
			}
			const kind = (ENTITY_KINDS as readonly string[]).includes(String(a.entity))
				? (a.entity as EntityKind)
				: 'person';
			const entity = createEntity(userId, { kind, name, relation });
			return { domain: 'people' as const, subdomain: entity.id };
		}
	}

	return tools;
}
