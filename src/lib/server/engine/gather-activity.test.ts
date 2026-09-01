import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import { chats, codeSessions, messages } from '$lib/server/db/schema';
import { gatherActivity } from './memory';

/**
 * What the harvest actually reads.
 *
 * Both the memory audit and the Cortex groomer ask this one question — "what
 * has been said since last time" — and it was answering with the wrong end of
 * each conversation, in an order the database chose.
 */

const ALICE = 'user-alice';
const HOUR = 3_600_000;

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(messages).run();
	db.delete(chats).run();
	db.delete(codeSessions).run();
});

function chat(title: string, updatedAt = new Date()) {
	const id = randomUUID();
	db.insert(chats)
		.values({
			id,
			userId: ALICE,
			mode: 'chat',
			title,
			titleCustom: false,
			createdAt: updatedAt,
			updatedAt
		})
		.run();
	return id;
}

/** Insert messages in a deliberately shuffled order, as a real table would hold them. */
function say(chatId: string, lines: string[], startedAt = Date.now()) {
	const rows = lines.map((content, seq) => ({
		id: randomUUID(),
		chatId,
		seq,
		role: 'user' as const,
		content,
		createdAt: new Date(startedAt + seq * 1000)
	}));
	for (const row of [...rows].reverse()) db.insert(messages).values(row).run();
}

describe('which end of a conversation it reads', () => {
	it('keeps the newest messages, in reading order', () => {
		const id = chat('A long one');
		say(
			id,
			Array.from({ length: 45 }, (_, i) => `line ${i}`)
		);

		const { text } = gatherActivity(ALICE, Date.now() - HOUR);
		// Thirty are kept. They used to be the *oldest* thirty — where a
		// conversation started rather than where it got to — which is the wrong
		// end for a job whose entire question is what is new.
		expect(text).toContain('line 44');
		expect(text).not.toContain('line 0');
		// And in the order they were said, because a transcript running backwards
		// is materially harder to summarise.
		expect(text.indexOf('line 20')).toBeLessThan(text.indexOf('line 44'));
	});

	it('does not let the database decide which messages those are', () => {
		const id = chat('Shuffled');
		say(
			id,
			Array.from({ length: 40 }, (_, i) => `line ${i}`)
		);
		// Inserted newest-row-first above. With no ORDER BY, which thirty survived
		// was whatever came back — stable enough to pass a test and not a promise.
		const { text } = gatherActivity(ALICE, Date.now() - HOUR);
		const kept = [...text.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
		expect(kept).toEqual([...kept].sort((a, b) => a - b));
		expect(Math.max(...kept)).toBe(39);
	});
});

describe('how the window is shared out', () => {
	it('stops one long conversation spending the whole read', () => {
		const hog = chat('The hog', new Date(Date.now() - 1000));
		say(
			hog,
			Array.from({ length: 30 }, () => 'x'.repeat(600))
		);
		const quiet = chat('The quiet one');
		say(quiet, ['something small but worth reading'], Date.now() - 500);

		const { text } = gatherActivity(ALICE, Date.now() - HOUR);
		// The single truncation at the very end was positional, so a busy first
		// chat could silently push every later one out of the digest entirely.
		expect(text).toContain('The quiet one');
		expect(text).toContain('something small but worth reading');
		expect(text).toContain('truncated');
	});

	it('says plainly when there is nothing in the window', () => {
		expect(gatherActivity(ALICE, Date.now() - HOUR)).toEqual({ text: '', empty: true });
	});

	it('reads nobody else’s conversations', () => {
		const mine = chat('Mine');
		say(mine, ['a thing I said']);
		const theirs = randomUUID();
		db.insert(chats)
			.values({
				id: theirs,
				userId: 'user-bob',
				mode: 'chat',
				title: 'Theirs',
				titleCustom: false,
				createdAt: new Date(),
				updatedAt: new Date()
			})
			.run();
		say(theirs, ['a thing Bob said']);

		const { text } = gatherActivity(ALICE, Date.now() - HOUR);
		expect(text).toContain('a thing I said');
		expect(text).not.toContain('a thing Bob said');
	});
});
