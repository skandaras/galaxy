import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import {
	alignmentAssessments,
	alignmentEntries,
	alignmentPrincipleRevisions,
	alignmentPrincipleTensions,
	alignmentPrinciples,
	alignmentSyntheses,
	events
} from '$lib/server/db/schema';
import { saveEntry, savePrinciple } from '$lib/server/alignment';
import { bootstrapContext } from '$lib/server/engine/tools/knowledge';
import { assessEntry } from '$lib/server/engine/alignment';

/**
 * Alignment holds the most private data in the platform, and the promise made
 * on its settings page is specific: it is never read by the memory agent, never
 * added to any other agent's context, and never visible to an admin.
 *
 * That promise currently holds because of what the other modules *don't* do,
 * which is exactly the kind of guarantee that evaporates the day somebody adds
 * a table to a digest without realising what is in it. These tests fail loudly
 * when that happens, on the pull request rather than in production.
 */

const ALICE = 'user-alice';

// Distinctive enough that a substring check is meaningful.
const SECRET_PRINCIPLE = 'zebracrossing-principle-marker';
const SECRET_STATEMENT = 'quokkasunrise-statement-marker';
const SECRET_ENTRY = 'narwhalthursday-journal-marker';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(alignmentAssessments).run();
	db.delete(alignmentEntries).run();
	db.delete(alignmentPrincipleRevisions).run();
	db.delete(alignmentPrincipleTensions).run();
	db.delete(alignmentPrinciples).run();
	db.delete(alignmentSyntheses).run();
	db.delete(events).run();

	savePrinciple(ALICE, {
		title: SECRET_PRINCIPLE,
		statement: SECRET_STATEMENT,
		exemplar: 'a marked exemplar',
		counterExemplar: 'a marked counter-exemplar'
	});
	saveEntry(ALICE, { title: 'a day', body: `${SECRET_ENTRY} and something I regret` });
});

describe('the context bootstrap', () => {
	it('carries nothing from the constitution or the journal', () => {
		// This string is prepended to the system prompt of every chat and coding
		// turn. Anything here is shipped to a model on every single message.
		const context = bootstrapContext(ALICE);
		expect(context).not.toContain(SECRET_PRINCIPLE);
		expect(context).not.toContain(SECRET_STATEMENT);
		expect(context).not.toContain(SECRET_ENTRY);
	});
});

describe('the Observatory feed', () => {
	it('records that an assessment happened without recording any of it', async () => {
		// No model is configured in tests, so this takes the refusal path — which
		// is precisely a path that emits an event, and the one most likely to be
		// written carelessly because "it's only an error".
		await assessEntry(ALICE, db.select().from(alignmentEntries).all()[0].id);

		const rows = db.select().from(events).all();
		expect(rows.length).toBeGreaterThan(0);
		const serialised = JSON.stringify(rows);
		// The Observatory is shared with admins. Counts and flags only.
		expect(serialised).not.toContain(SECRET_ENTRY);
		expect(serialised).not.toContain(SECRET_PRINCIPLE);
		expect(serialised).not.toContain(SECRET_STATEMENT);
	});
});

describe('the memory agent', () => {
	it('does not read alignment tables when gathering activity', async () => {
		// gatherActivity is private, so this exercises the whole run: with no model
		// configured it either finds nothing to do or fails at the model call, and
		// in both cases nothing from Alignment may appear in what it recorded.
		const { runMemory } = await import('$lib/server/engine/memory');
		await runMemory('manual', ALICE);

		const serialised = JSON.stringify(db.select().from(events).all());
		expect(serialised).not.toContain(SECRET_ENTRY);
		expect(serialised).not.toContain(SECRET_STATEMENT);
	});

	it('has no alignment table in its source', async () => {
		// The belt to the braces above: the memory digest is assembled from a
		// fixed list of tables, and this asserts alignment is not on it even in a
		// branch the tests above never reach.
		const { readFileSync } = await import('node:fs');
		const source = readFileSync('src/lib/server/engine/memory.ts', 'utf8');
		expect(source).not.toMatch(/alignment/i);
	});
});

describe('the UX audit', () => {
	it('has no alignment table in its source', async () => {
		// The audit reads telemetry and interface source. It must never grow a
		// reader for this, whatever a future idea about "engagement" suggests.
		const { readFileSync } = await import('node:fs');
		const source = readFileSync('src/lib/server/engine/ux-audit.ts', 'utf8');
		expect(source).not.toMatch(/alignmentPrinciples|alignmentEntries|alignmentAssessments/);
	});
});
