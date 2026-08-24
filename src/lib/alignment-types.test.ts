import { describe, expect, it } from 'vitest';
import {
	EXEMPLAR_HINTS,
	EXEMPLAR_LABELS,
	KIND_BLURBS,
	KIND_HEADINGS,
	KIND_ORDER,
	KIND_PLACEHOLDERS,
	KIND_READING_NOTES,
	PRINCIPLE_KINDS
} from './alignment-types';

/**
 * The constitution's copy is the feature, not decoration around it: these
 * strings are the questions someone answers about themselves, and the same
 * labels are what the agent is told those answers mean. A kind added without
 * copy would silently ask nothing and tell the model nothing.
 */
describe('every kind is fully described', () => {
	it('has a heading, a blurb, both labels, both hints and a reading note', () => {
		for (const kind of PRINCIPLE_KINDS) {
			expect(KIND_HEADINGS[kind], `${kind} heading`).toBeTruthy();
			expect(KIND_BLURBS[kind], `${kind} blurb`).toBeTruthy();
			expect(EXEMPLAR_LABELS[kind]?.exemplar, `${kind} label`).toBeTruthy();
			expect(EXEMPLAR_LABELS[kind]?.counter, `${kind} counter label`).toBeTruthy();
			expect(EXEMPLAR_HINTS[kind]?.exemplar, `${kind} hint`).toBeTruthy();
			expect(EXEMPLAR_HINTS[kind]?.counter, `${kind} counter hint`).toBeTruthy();
			expect(KIND_READING_NOTES[kind], `${kind} reading note`).toBeTruthy();
			expect(KIND_PLACEHOLDERS[kind]?.title, `${kind} title example`).toBeTruthy();
			expect(KIND_PLACEHOLDERS[kind]?.statement, `${kind} statement example`).toBeTruthy();
		}
	});

	it('shows every kind in the picker exactly once', () => {
		expect([...KIND_ORDER].sort()).toEqual([...PRINCIPLE_KINDS].sort());
	});
});

describe('the questions are distinct where they need to be', () => {
	it('never asks the same thing twice within a kind', () => {
		for (const kind of PRINCIPLE_KINDS) {
			const { exemplar, counter } = EXEMPLAR_LABELS[kind];
			expect(exemplar, kind).not.toBe(counter);
		}
	});

	it('asks aspirations for the obstacle rather than the current gap', () => {
		// "Still true of me" asked for a paragraph of self-criticism that gave a
		// reading nothing it could detect. An obstacle actually turns up in
		// entries, so it can be noticed when it does.
		expect(EXEMPLAR_LABELS.aspiration.counter).toMatch(/gets in the way/i);
		expect(EXEMPLAR_HINTS.aspiration.counter).not.toMatch(/flinch/i);
	});

	it('asks beliefs what would change their mind', () => {
		expect(EXEMPLAR_LABELS.belief.counter).toMatch(/change my mind/i);
	});
});

describe('the reading notes carry what the labels cannot', () => {
	it('tells the agent a failure mode occurring is the failure, not the keeping', () => {
		// The whole bug: a failure mode's first field describes going wrong, and
		// without this a model reads it beside a value's "in practice this looks
		// like" and treats both as evidence of living well.
		expect(KIND_READING_NOTES['failure-mode']).toMatch(/not the principle being kept/i);
	});

	it('tells the agent an aspiration is judged by movement', () => {
		expect(KIND_READING_NOTES.aspiration).toMatch(/movement/i);
		expect(KIND_READING_NOTES.aspiration).toMatch(/never by whether they have arrived/i);
	});

	it('tells the agent a belief is judged on consistency, not correctness', () => {
		expect(KIND_READING_NOTES.belief).toMatch(/not whether it is correct/i);
	});
});

describe('the examples suit their kind', () => {
	it('gives each kind its own, rather than a value example on all six', () => {
		// A failure mode used to suggest "Honesty" as a title, which is the first
		// thing read and sets what the field appears to want.
		const titles = PRINCIPLE_KINDS.map((k) => KIND_PLACEHOLDERS[k].title);
		expect(new Set(titles).size).toBe(titles.length);
		expect(KIND_PLACEHOLDERS['failure-mode'].title).not.toBe(KIND_PLACEHOLDERS.value.title);
	});

	it('writes each example in the first person, like the field it sits in', () => {
		for (const kind of PRINCIPLE_KINDS) {
			expect(KIND_PLACEHOLDERS[kind].statement.length, kind).toBeGreaterThan(10);
		}
	});
});

describe('the copy stays plain', () => {
	/** Everything a person reads on the form. */
	const onScreen = [
		...Object.values(KIND_BLURBS),
		...Object.values(EXEMPLAR_LABELS).flatMap((l) => [l.exemplar, l.counter]),
		...Object.values(EXEMPLAR_HINTS).flatMap((h) => [h.exemplar, h.counter])
	];

	it('avoids the flourishes that made this read as performance', () => {
		// Named rather than vague, because the failure mode here is a writerly
		// phrase creeping back in one edit at a time. This is a serious exercise
		// and the language should carry it by being plain, not by being literary.
		const flourishes = /flinch|growing edge|the honest half|weather|deepen the groove/i;
		for (const line of [...onScreen, ...Object.values(KIND_READING_NOTES)]) {
			expect(line, line).not.toMatch(flourishes);
		}
	});

	it('keeps what is shown above a form field short enough to read', () => {
		// Only the on-screen copy. The reading notes are prompt text and are
		// allowed the room to be precise, since nobody reads them over an input.
		for (const line of onScreen) {
			expect(line.length, line).toBeLessThanOrEqual(140);
		}
	});

	it('keeps the reading notes to a sentence or two', () => {
		for (const note of Object.values(KIND_READING_NOTES)) {
			expect(note.length, note).toBeLessThanOrEqual(260);
		}
	});
});
