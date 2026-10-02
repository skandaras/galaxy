/**
 * The question before something that cannot be taken back.
 *
 * This was `window.confirm()` in twenty-one places. The browser's dialog cannot
 * name its buttons, so every one read OK and Cancel whatever it was guarding;
 * it looks foreign in an installed app; and Playwright dismisses it unasked, so
 * no smoke check could ever exercise a delete. One dialog, mounted once in the
 * layout, answers all three.
 *
 * A single slot, like the page-list registry: two questions can never both be
 * on screen, so a second `ask()` settles the first as a refusal rather than
 * queueing behind it. Saying no is the safe answer to a question nobody saw.
 */

export interface Question {
	/** The question itself, naming the thing: `Delete "Q3 plan"?` */
	title: string;
	/** What follows from yes, when the title alone does not say. */
	body?: string;
	/** The action, as a verb: "Delete chat". Never "OK". */
	confirm: string;
	/** Red, and focus starts on Cancel so Enter does not destroy anything. */
	danger?: boolean;
}

interface Pending extends Question {
	settle: (answer: boolean) => void;
}

let pending = $state<Pending | null>(null);

export const question = {
	get current(): Question | null {
		return pending;
	},
	answer(yes: boolean) {
		const p = pending;
		pending = null;
		p?.settle(yes);
	}
};

export function ask(q: Question): Promise<boolean> {
	question.answer(false);
	return new Promise((resolve) => {
		pending = { ...q, settle: resolve };
	});
}
