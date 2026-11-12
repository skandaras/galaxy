import { profileSettings, type LearningBar } from '$lib/server/settings';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';
import { learn, type Activity } from './profile-learn';
import { logUsage } from './usage';

/**
 * Whether the learning job's bar is where the owner wants it.
 *
 * Nobody approves a learned line, so the only way to know what the job lets
 * through is to show it things whose answer is known. Twenty short messages,
 * each its own conversation: ten say something worth keeping, ten are the
 * trivia a profile fills with when the bar is low. One model call, read as
 * though the profile were empty, and nothing is written.
 *
 * Run it after changing the prompt, the model or the setting, and compare.
 */

interface BarCase {
	/** What the page calls it. */
	label: string;
	keep: boolean;
	text: string;
}

export const BAR_CASES: readonly BarCase[] = [
	{ label: 'a diet', keep: true, text: 'I’m vegetarian, so skip anything with meat when you suggest dinners.' },
	{ label: 'a job', keep: true, text: 'I work as a paediatric nurse at the hospital in Hamilton, mostly on night shifts.' },
	{ label: 'a child and their school', keep: true, text: 'My daughter Mere starts at Kōwhai School in February.' },
	{ label: 'a goal', keep: true, text: 'I’m training for the Tarawera 50 km, so plan my weeks around a long run every Sunday.' },
	{ label: 'where they live', keep: true, text: 'We moved to Raglan last year and I commute to Hamilton three days a week.' },
	{ label: 'how to be answered', keep: true, text: 'Please always give me measurements in metric from now on, I cannot think in cups and ounces.' },
	{ label: 'an access need', keep: true, text: 'I use a wheelchair, so any venue you suggest needs step-free access.' },
	{ label: 'a standing commitment', keep: true, text: 'I’m the treasurer of our rowing club, which takes up most of my Thursday evenings.' },
	{ label: 'what they work with', keep: true, text: 'I write everything in Rust at work these days; we moved off Python two years ago.' },
	{ label: 'something they are learning', keep: true, text: 'I’m learning te reo Māori and have a class every Tuesday night.' },
	{ label: 'a technical question', keep: false, text: 'How does Postgres connection pooling work with PgBouncer?' },
	{ label: 'a one-off task', keep: false, text: 'Can you tighten up this cover letter? It is for a marketing role.' },
	{ label: 'a mood', keep: false, text: 'Ugh, today has been exhausting. What is a quick dinner?' },
	{ label: 'a curiosity', keep: false, text: 'What is the difference between a sourdough starter and a levain?' },
	{ label: 'a stranger', keep: false, text: 'A colleague’s cousin apparently climbed Aoraki last summer. How hard is that climb?' },
	{ label: 'something they read', keep: false, text: 'Summarise this article about interest rates for me.' },
	{ label: 'a complaint about one reply', keep: false, text: 'Make that last answer shorter.' },
	{ label: 'an errand', keep: false, text: 'What time does the supermarket in town close on Sundays?' },
	{ label: 'a snippet of work', keep: false, text: 'I need a regex that matches New Zealand phone numbers.' },
	{ label: 'a passing plan', keep: false, text: 'Is it going to rain in Wellington tomorrow? I might go for a walk.' }
];

export type BarOutcome =
	| { ran: false; reason: string }
	| {
			ran: true;
			bar: LearningBar;
			/** Worth keeping and written, of how many were worth keeping. */
			kept: number;
			worth: number;
			/** Worth keeping, and only watched or dropped. */
			missed: string[];
			/** Trivia that would have been written. */
			letThrough: string[];
			/** Trivia held back to see whether it comes up again. */
			watched: string[];
	  };

export function barActivity(): Activity {
	const said = BAR_CASES.map((c, i) => ({ id: `bar-${i}`, chatId: `bar-chat-${i}`, text: c.text }));
	return {
		text: said.map((m, i) => `## Chat: conversation ${i + 1}\nPerson: ${m.text}`).join('\n\n'),
		empty: false,
		said
	};
}

export async function runBarCheck(userId: string): Promise<BarOutcome> {
	if (getBudgetStatus().blocked) return { ran: false, reason: 'The spending cap has been reached.' };
	const choice = pickModel(getTaskConfig('profile-learn')?.primaryModelId ?? null, 'profile-learn');
	if (!choice) return { ran: false, reason: 'No model is set up for learning.' };

	const started = Date.now();
	try {
		const out = await learn(userId, choice, barActivity(), { source: 'bar-check', dry: true });
		logUsage({ task: 'profile-probe', choice, usage: out.usage, status: 'ok', userId });
		const fate = new Map(out.kept.map((k) => [k.messageId, k.verdict]));
		const of = (keep: boolean, verdict: 'apply' | 'watch' | undefined) =>
			BAR_CASES.filter((c, i) => c.keep === keep && fate.get(`bar-${i}`) === verdict).map((c) => c.label);
		const worth = BAR_CASES.filter((c) => c.keep).length;
		const kept = of(true, 'apply').length;
		const result: BarOutcome = {
			ran: true,
			bar: profileSettings().bar,
			kept,
			worth,
			missed: [...of(true, 'watch'), ...of(true, undefined)],
			letThrough: of(false, 'apply'),
			watched: of(false, 'watch')
		};
		emitEvent({
			userId,
			task: 'profile-probe',
			type: 'job',
			name: 'profile-bar.run',
			status: 'ok',
			durationMs: Date.now() - started,
			detail: { model: choice.model.modelKey, bar: result.bar, kept, letThrough: result.letThrough.length }
		});
		return result;
	} catch (err) {
		logUsage({ task: 'profile-probe', choice, usage: null, status: 'error', userId });
		return {
			ran: false,
			reason: `${choice.model.displayName} did not answer (${err instanceof Error ? err.name : 'Error'}).`
		};
	}
}
