import { listEntities, listEntries, profileBlock, scopeAllows } from '$lib/server/profile';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel, systemPromptFor } from './engine';
import { emitEvent } from './events';
import { logUsage } from './usage';

/**
 * Does the profile intrude on answers that have nothing to do with it?
 *
 * The block tells agents to use a fact only when it changes the answer. This
 * checks whether the chat model listens: everyday questions a profile should
 * not touch, asked with the admin's own block in the prompt, and a reply that
 * names one of their people or reaches for a word from their pinned brief is
 * counted. A word match is crude, so every flag shows what matched and the
 * admin judges it.
 *
 * Only the profile varies. No tools, no Library, no boards: a reply that
 * intrudes did so because of the block, and nothing else in the prompt could
 * have put the word there.
 */

export const PROBE_QUESTIONS = [
	'How do I reverse a linked list in place?',
	'What is the capital of Australia?',
	'Convert 350 degrees Fahrenheit to Celsius.',
	'Explain the difference between TCP and UDP in a few sentences.',
	'What does the JavaScript reduce method do?',
	'Why is the sky blue?',
	'Give me a regular expression that matches an email address.',
	'How many grams are in a cup of flour?',
	'What causes inflation?',
	'Summarise the plot of Hamlet in three sentences.',
	'How do I undo the last git commit but keep the changes?',
	'What is the boiling point of water at sea level?'
] as const;

/** Room for a reasoning model to think before it answers, as it would in a chat turn. */
const REPLY_TOKENS = 1_500;
const CALL_TIMEOUT_MS = 60_000;
const EXCERPT_CHARS = 300;

/**
 * Words too common to say anything about a person, however often a claim
 * uses them. Five letters or more only, since shorter words are never
 * counted at all.
 */
const COMMON = new Set(
	(
		'about above after again against along already also always among another around because ' +
		'before being below between both cannot could daily does doing during each early every first ' +
		'from going great having here their them then there these they thing things think those ' +
		'though three through today under until using usual usually very week weeks weekly weekend ' +
		'weekends where which while whole whose would years should might other others small large ' +
		'works working lives living still since often never really times people person place places ' +
		'makes making takes taking likes prefers learning month months'
	).split(/\s+/)
);

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];

export interface ProbeProfile {
	/** People's and things' names and other names. */
	names: string[];
	/** The pinned brief, the one part of the profile every agent carries. */
	pinned: string[];
}

/**
 * What in a reply came from the profile rather than the question: a name of
 * someone in it, or a distinctive word from the pinned brief. A word the
 * question itself uses is the question's, not the profile's.
 */
export function profileIntrusion(reply: string, question: string, profile: ProbeProfile): string[] {
	const asked = new Set(words(question));
	const said = ` ${words(reply).join(' ')} `;
	const found = new Set<string>();
	for (const name of profile.names) {
		const key = words(name).join(' ');
		if (key.length < 3 || words(name).every((w) => asked.has(w))) continue;
		if (said.includes(` ${key} `)) found.add(name);
	}
	const replyWords = new Set(words(reply));
	for (const claim of profile.pinned) {
		for (const w of words(claim)) {
			if (w.length < 5 || COMMON.has(w) || asked.has(w)) continue;
			if (replyWords.has(w)) found.add(w);
		}
	}
	return [...found];
}

export interface ProbeResult {
	question: string;
	/** What in the reply came from the profile; empty when nothing did. */
	flagged: string[];
	excerpt: string;
}

export type ProbeOutcome =
	| { ran: false; reason: string }
	| {
			ran: true;
			results: ProbeResult[];
			/** Replies that intruded, of those asked. */
			flagged: number;
			asked: number;
			/** Set when it stopped before every question was asked. */
			stopped?: string;
			blockChars: number;
			tokens: { prompt: number; completion: number } | null;
	  };

/**
 * Ask the fixed questions with this person's own chat block in the prompt.
 * One at a time, so the calls cannot race the budget cap between them.
 */
export async function runProbe(userId: string): Promise<ProbeOutcome> {
	const block = profileBlock(userId, 'chat');
	if (!block) return { ran: false, reason: 'Your profile has nothing in it that could intrude.' };
	if (getBudgetStatus().blocked) return { ran: false, reason: 'The spending cap has been reached.' };
	const choice = pickModel(getTaskConfig('chat')?.primaryModelId ?? null, 'chat');
	if (!choice) return { ran: false, reason: 'No model is set up for chat.' };

	const entities = listEntities(userId);
	const profile: ProbeProfile = {
		names: entities.filter((e) => e.named).flatMap((e) => [e.name, ...e.aka]),
		pinned: listEntries(userId)
			.filter((e) => e.pinned && scopeAllows('chat', e.domain, e.subdomain))
			.map((e) => e.claim)
	};
	const system = `${systemPromptFor('chat')}\n\n${block}`;

	const started = Date.now();
	const results: ProbeResult[] = [];
	let tokens: { prompt: number; completion: number } | null = { prompt: 0, completion: 0 };
	let stopped: string | undefined;
	for (const question of PROBE_QUESTIONS) {
		if (getBudgetStatus().blocked) {
			stopped = 'the spending cap was reached';
			break;
		}
		try {
			const { text, usage } = await choice.adapter.complete(
				{
					modelKey: choice.model.modelKey,
					messages: [
						{ role: 'system', content: system },
						{ role: 'user', content: question }
					],
					maxTokens: REPLY_TOKENS
				},
				AbortSignal.timeout(CALL_TIMEOUT_MS)
			);
			logUsage({ task: 'profile-probe', choice, usage, status: 'ok', userId });
			if (usage && tokens) {
				tokens.prompt += usage.promptTokens;
				tokens.completion += usage.completionTokens;
			} else {
				// One provider that does not report is enough to make a total wrong.
				tokens = null;
			}
			results.push({
				question,
				flagged: profileIntrusion(text, question, profile),
				excerpt: text.slice(0, EXCERPT_CHARS)
			});
		} catch (err) {
			logUsage({ task: 'profile-probe', choice, usage: null, status: 'error', userId });
			stopped = `${choice.model.displayName} did not answer "${question}" (${err instanceof Error ? err.name : 'Error'})`;
			break;
		}
	}

	const flagged = results.filter((r) => r.flagged.length).length;
	emitEvent({
		userId,
		task: 'profile-probe',
		type: 'job',
		name: 'profile-probe.run',
		status: stopped ? 'error' : 'ok',
		durationMs: Date.now() - started,
		// Counts only: the replies are the admin's to read, not the feed's.
		detail: { model: choice.model.modelKey, asked: results.length, flagged, ...(stopped ? { stopped: true } : {}) }
	});
	return { ran: true, results, flagged, asked: results.length, stopped, blockChars: block.length, tokens };
}
