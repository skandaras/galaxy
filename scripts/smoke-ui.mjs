/**
 * Browser smoke: the things HTTP 200 cannot tell you.
 *
 * scripts/smoke-e2e.sh proves the API and the engine work. It cannot see a
 * page that renders blank because hydration threw, a control that has drifted
 * on top of another, or an interaction that never fires — and every UI bug
 * this project has actually shipped was one of those three.
 *
 *   node scripts/smoke-ui.mjs      (requires `npm run build` first)
 *
 * Runs the app in authelia mode so there are two real identities, which is
 * what lets one of them raise a notification the other has to look at.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHOTS = 'test-results';
const ALICE = 'alice';
const BOB = 'bob';

const fail = [];
const check = (label, actual, expected = true) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(
		`${ok ? 'ok:' : 'FAIL:'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`
	);
	if (!ok) fail.push(label);
};

const as = async (user, path, init = {}) => {
	const res = await fetch(B + path, {
		...init,
		headers: { 'content-type': 'application/json', 'Remote-User': user, ...(init.headers ?? {}) }
	});
	if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} as ${user} -> ${res.status}`);
	return res.json();
};

/**
 * Claim a port nothing else is on, from a band below the ephemeral range.
 *
 * A fixed port is how this suite once tested a *previous* run's leftover
 * server: the spawn lost the bind, died unnoticed, and the health check found
 * the old process still answering with stale data. Every assertion after that
 * was measuring the wrong thing.
 */
async function freePort(from = 18904, to = 18960) {
	for (let port = from; port <= to; port++) {
		const free = await new Promise((resolve) => {
			const probe = createServer();
			probe.once('error', () => resolve(false));
			probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
		});
		if (free) return port;
	}
	throw new Error(`no free port between ${from} and ${to}`);
}

const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'galaxy-ui-'));
mkdirSync(SHOTS, { recursive: true });
const app = spawn('node', ['build'], {
	env: {
		...process.env,
		AUTH_MODE: 'authelia',
		TRUSTED_PROXY_IPS: '127.0.0.1',
		ADMIN_GROUP: 'galaxy-admins',
		DATA_DIR: dataDir,
		PORT: String(PORT),
		CODING_EXECUTOR: 'local'
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let appLog = '';
let appExited = false;
app.stdout.on('data', (d) => (appLog += d));
app.stderr.on('data', (d) => (appLog += d));
app.on('exit', (code) => (appExited = code ?? true));

const cleanup = () => {
	app.kill();
	rmSync(dataDir, { recursive: true, force: true });
};
process.on('exit', cleanup);

async function waitForApp() {
	for (let i = 0; i < 80; i++) {
		// Our own process dying is the failure, whoever else may be answering.
		if (appExited !== false) {
			console.log(`SMOKE-UI FAILED: the app exited before serving\n${appLog}`);
			process.exit(1);
		}
		try {
			if ((await fetch(`${B}/healthz`)).ok) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	console.log(`SMOKE-UI FAILED: the app never came up at ${B}\n${appLog}`);
	process.exit(1);
}

await waitForApp();

// --- fixture --------------------------------------------------------------
// Bob shares a board with Alice and hands her a card, so Alice has real
// notifications to open. Nothing here writes to the database directly: this
// has to keep working through the same API the app uses.
const alicesBoard = await as(ALICE, '/api/boards', {
	method: 'POST',
	body: JSON.stringify({ name: 'Alice board' })
});
const view = await as(ALICE, `/api/boards/${alicesBoard.id}`);
const [laneA, laneB] = view.lanes;
for (const title of ['alpha', 'bravo', 'charlie']) {
	await as(ALICE, `/api/boards/${alicesBoard.id}/cards`, {
		method: 'POST',
		body: JSON.stringify({ title, laneId: laneA.id })
	});
}

const bobsBoard = await as(BOB, '/api/boards', {
	method: 'POST',
	body: JSON.stringify({ name: 'Shared by Bob' })
});
await as(BOB, `/api/boards/${bobsBoard.id}/members`, {
	method: 'POST',
	body: JSON.stringify({ username: ALICE })
});
const card = await as(BOB, `/api/boards/${bobsBoard.id}/cards`, {
	method: 'POST',
	body: JSON.stringify({ title: 'Take the bins out' })
});

const asAdmin = (path, init = {}) =>
	as('root', path, { ...init, headers: { 'Remote-Groups': 'galaxy-admins', ...(init.headers ?? {}) } });

const users = await asAdmin('/api/admin/users');
const aliceId = users.find((u) => u.username === ALICE).id;
await as(BOB, `/api/cards/${card.id}`, {
	method: 'PATCH',
	body: JSON.stringify({ assignedTo: aliceId })
});
// Coding is a per-user grant. Without it /code legitimately 403s on the repo
// list, which is correct behaviour and tells us nothing — grant it so the
// page under test is the one a coder actually sees.
await asAdmin('/api/admin/users', {
	method: 'PATCH',
	body: JSON.stringify({ id: aliceId, canCode: true })
});

/** Card titles per lane, in board order — read back from the API, not the DOM. */
// Alignment is off until someone turns it on, so the browser would otherwise
// never see the page at all. No model is configured here, which is the more
// interesting state anyway: every one of these views has to render before
// anything has ever been assessed.
await as(ALICE, '/api/alignment/settings', {
	method: 'PUT',
	body: JSON.stringify({ enabled: true })
});
const honesty = await as(ALICE, '/api/alignment/principles', {
	method: 'POST',
	body: JSON.stringify({
		kind: 'value',
		title: 'Honesty',
		statement: 'I say the uncomfortable thing kindly.',
		exemplar: 'Told them the estimate was wrong.',
		weight: 5
	})
});
const presence = await as(ALICE, '/api/alignment/principles', {
	method: 'POST',
	body: JSON.stringify({ kind: 'value', title: 'Presence', statement: 'Attention over output.' })
});
await as(ALICE, '/api/alignment/tensions', {
	method: 'POST',
	body: JSON.stringify({
		aId: honesty.principle.id,
		bId: presence.principle.id,
		note: 'honesty first'
	})
});
await as(ALICE, '/api/alignment/entries', {
	method: 'POST',
	body: JSON.stringify({ title: 'A Tuesday', body: 'I let a wrong number stand because it was late.' })
});

const layout = async () => {
	const v = await as(ALICE, `/api/boards/${alicesBoard.id}`);
	const of = (laneId) =>
		v.cards
			.filter((c) => c.laneId === laneId)
			.sort((a, b) => a.position - b.position)
			.map((c) => c.title);
	return { a: of(laneA.id), b: of(laneB.id) };
};

// --- browser --------------------------------------------------------------
// CI runs `npx playwright install chromium`, so the default resolution is
// right there. GALAXY_CHROMIUM_PATH is for a machine that already has a
// browser Playwright did not put there, and whose build number therefore will
// not match the one this version expects.
const browser = await chromium.launch({
	executablePath: process.env.GALAXY_CHROMIUM_PATH || undefined
});
const context = await browser.newContext({
	viewport: { width: 1400, height: 900 },
	extraHTTPHeaders: { 'Remote-User': ALICE }
});
const page = await context.newPage();

/** Anything the console or an uncaught throw says, per page. */
let problems = [];
page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
page.on('console', (m) => {
	if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});

const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

// 1. Every page renders, and renders quietly. A page that throws during
//    hydration still answers 200, so the bash smoke calls it healthy.
for (const path of ['/chat', '/code', '/boards', '/library', '/settings', '/observatory', '/alignment']) {
	problems = [];
	// Not networkidle: the app holds SSE streams open (notifications, the
	// Observatory feed), so the network is never idle and every goto would sit
	// there until it timed out.
	await page.goto(B + path);
	await page.locator('aside.pane').waitFor();
	await page.waitForTimeout(500);
	check(`${path} renders without errors`, problems, []);
	const body = await page.locator('body').boundingBox();
	check(`${path} draws something`, (body?.height ?? 0) > 100);
}

// 2. Nothing covers the brand. This is the general form of a control escaping
//    its container onto the sidebar — the shape of every layout bug so far.
{
	await page.goto(`${B}/boards`);
	await page.locator('.brand').waitFor();
	const brand = await page.locator('.brand').boundingBox();
	const covering = await page.evaluate(
		({ x, y }) => {
			const el = document.elementFromPoint(x, y);
			return el?.closest('.brand') ? null : (el?.className?.toString?.() ?? el?.tagName ?? 'unknown');
		},
		{ x: brand.x + brand.width / 2, y: brand.y + brand.height / 2 }
	);
	if (covering) await shot('brand-covered');
	check('nothing is floating over the brand', covering, null);
}

// 3. The alerts panel. It lives inside a scrolling pane, so the thing worth
//    asserting is that it is not clipped by it.
{
	await page.locator('.bell').click();
	await page.waitForSelector('.panel');
	const panel = await page.locator('.panel').boundingBox();
	const pane = await page.locator('aside.pane').boundingBox();
	check('the alerts panel is wider than the pane', panel.width > pane.width);
	check('and is not clipped by it', panel.x + panel.width > pane.x + pane.width);

	const titles = await page.locator('.panel .title').allTextContents();
	check('it lists what needs looking at', titles.length > 0);
	const whens = await page.locator('.panel .when').allTextContents();
	check('timestamps are readable', whens.some((w) => /ago|just now/.test(w)));
	check('and none are NaN', whens.some((w) => w.includes('NaN')), false);

	check('mark all as read is reachable', await page.locator('.panel .clear').isVisible());
	await shot('alerts-panel');
	await page.locator('.panel .clear').click();
	await page.waitForTimeout(500);
	check('clearing empties the badge', await page.locator('.bell .count').count(), 0);
	await page.keyboard.press('Escape');
}

// 4. Dragging cards. Press and hold, because that is what the UI asks for.
{
	await page.goto(`${B}/boards`);
	const picker = page.locator('header.bar select').first();
	await picker.waitFor();
	await picker.selectOption({ label: 'Alice board' });

	/**
	 * Wait for a lane to hold exactly `n` cards.
	 *
	 * Alice can see two boards and the page opens whichever the API lists
	 * first, so "any card is on screen" is not enough — and every move
	 * re-reads the board, so measuring too early takes coordinates from a DOM
	 * that is about to be replaced. That is what made this drag miss.
	 */
	const settled = async (laneId, n) => {
		try {
			await page.waitForFunction(
				({ id, n }) => document.querySelectorAll(`[data-lane="${id}"] [data-card]`).length === n,
				{ id: laneId, n },
				{ timeout: 15_000 }
			);
		} catch {
			// A bare timeout says nothing. Report what was on screen instead.
			const seen = await page.locator('[data-lane]').evaluateAll((els) =>
				els.map((e) => `${e.dataset.lane}:${e.querySelectorAll('[data-card]').length}`)
			);
			const board = await page.locator('header.bar select').first().inputValue();
			await shot('board-not-settled');
			throw new Error(
				`lane ${laneId} never held ${n} cards. board=${board} lanes=${JSON.stringify(seen)}`
			);
		}
	};
	await settled(laneA.id, 3);

	/**
	 * Wait for a lane to *show* a given order, not merely a given count.
	 *
	 * `settled()` waits on the number of cards in a lane, which never changes
	 * when a card is reordered within its own lane — so it returned instantly,
	 * and the bounding box read straight afterwards could be taken while the
	 * board still showed the previous order. The next drag then grabbed
	 * whichever card happened to be occupying that slot a moment ago.
	 *
	 * That is what failed CI: asked for `bravo`, it moved `charlie`. The board
	 * itself was fine — `layout()` reads the API and reported the right thing
	 * throughout — so the whole failure lived in the test reading coordinates
	 * from a screen that had not caught up yet. Every drag now waits for the
	 * DOM to match before anything measures it.
	 */
	const settledOrder = async (laneId, titles) => {
		try {
			await page.waitForFunction(
				({ id, want }) =>
					JSON.stringify(
						[...document.querySelectorAll(`[data-lane="${id}"] [data-card] .card-title`)].map(
							(el) => el.textContent.trim()
						)
					) === JSON.stringify(want),
				{ id: laneId, want: titles },
				{ timeout: 15_000 }
			);
		} catch {
			const seen = await page
				.locator(`[data-lane="${laneId}"] [data-card] .card-title`)
				.allTextContents();
			await shot('board-order-not-settled');
			throw new Error(
				`lane ${laneId} never showed ${JSON.stringify(titles)} — on screen: ${JSON.stringify(seen)}`
			);
		}
	};

	const boxOf = async (title) =>
		page.locator('article.card', { hasText: title }).first().boundingBox();

	async function press(title, to) {
		const box = await boxOf(title);
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		// Check what is actually under the point before pressing on it. The board
		// re-renders after every drop (PATCH, then a full reload, with no
		// optimistic update), so a box measured a moment too early describes a
		// slot that now holds a different card — and the drag silently moves the
		// wrong one. This turns that into a legible failure instead of a
		// mystifying assertion about charlie.
		const under = await page.evaluate(
			({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-card]')?.textContent?.trim(),
			{ x, y }
		);
		if (!under || !under.includes(title)) {
			await shot('drag-wrong-card');
			throw new Error(`press("${title}") would have grabbed "${under ?? 'nothing'}" — the board moved under the test`);
		}
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.waitForTimeout(300); // past the hold threshold
		// Stepped, because one jump can skip every hover calculation.
		for (let i = 1; i <= 6; i++) {
			await page.mouse.move(
				box.x + box.width / 2 + ((to.x - box.x - box.width / 2) * i) / 6,
				box.y + box.height / 2 + ((to.y - box.y - box.height / 2) * i) / 6
			);
			await page.waitForTimeout(25);
		}
	}

	// Reorder inside a lane.
	const charlie = await boxOf('charlie');
	await press('alpha', { x: charlie.x + charlie.width / 2, y: charlie.y + charlie.height - 2 });
	check('a drop line shows where it will land', await page.locator('.drop-line').count(), 1);
	await shot('drag-in-flight');
	await page.mouse.up();
	await settledOrder(laneA.id, ['bravo', 'charlie', 'alpha']);
	check('reordered within its lane', (await layout()).a, ['bravo', 'charlie', 'alpha']);

	// Move to another lane.
	const lb = await page.locator(`[data-lane="${laneB.id}"]`).boundingBox();
	await press('bravo', { x: lb.x + lb.width / 2, y: lb.y + 60 });
	await page.mouse.up();
	await settledOrder(laneB.id, ['bravo']);
	await settledOrder(laneA.id, ['charlie', 'alpha']);
	const moved = await layout();
	check('moved into another lane', moved.b, ['bravo']);
	check('and left the one it came from', moved.a, ['charlie', 'alpha']);

	// Released over nothing: unchanged.
	const before = await layout();
	await press('charlie', { x: 30, y: 880 });
	await page.mouse.up();
	await settledOrder(laneA.id, ['charlie', 'alpha']);
	check('a drop outside every lane changes nothing', await layout(), before);

	// And a plain click still opens a card rather than being eaten by the drag.
	await page.locator('article.card', { hasText: 'charlie' }).first().click();
	await page.waitForTimeout(400);
	check('a click still opens the card', await page.locator('.card-detail, dialog, aside').count() > 0);
}

// 5. Alignment. Four tabs that each fetch on mount, a constellation drawn from
//    scratch in SVG, and an editor that loads a principle's track record before
//    it shows a single field. Plenty to render blank.
{
	await page.goto(`${B}/alignment`);
	await page.locator('.tabs').waitFor();
	await page.waitForTimeout(400);

	// Nothing has been assessed, so Standing must explain itself rather than
	// showing an empty chart — the state every new user starts in.
	check('standing greets an empty account', await page.locator('.line, .empty').count() > 0);

	for (const tab of ['Journal', 'Constitution', 'Rubric']) {
		problems = [];
		await page.locator(`.tabs button:text-is("${tab}")`).click();
		await page.waitForTimeout(400);
		check(`the ${tab} tab renders quietly`, problems, []);
		const body = await page.locator('.body').boundingBox();
		check(`the ${tab} tab draws something`, (body?.height ?? 0) > 100);
	}

	// The rubric's anchors are the thing that makes it inspectable rather than a
	// black box, so they have to actually open.
	await page.locator('.tabs button:text-is("Rubric")').click();
	await page.locator('.link:text-is("Show the scale")').first().click();
	check('the rubric shows its 1-5 anchors', await page.locator('.anchors li').count(), 5);

	// Opening a principle must lead with its track record, not the fields.
	await page.locator('.tabs button:text-is("Constitution")').click();
	await page.locator('.row-item').first().click();
	await page.locator('.editor').waitFor();
	check('the editor leads with the track record', await page.locator('.track-record').isVisible());
	check('and relabels the exemplar for the kind', await page
		.locator('.editor .label')
		.allTextContents()
		.then((t) => t.some((x) => x.includes('In practice this looks like'))));

	// A belief asks a different question of the same field — the mechanism that
	// lets one schema serve six kinds.
	await page.selectOption('.editor select', 'belief');
	await page.waitForTimeout(150);
	check('a belief asks what would falsify it', await page
		.locator('.editor .label')
		.allTextContents()
		.then((t) => t.some((x) => x.includes('What would make me doubt it'))));

	await shot('alignment-editor');

	// The journal composer is the whole point of the Journal tab, and a textarea
	// that starts small asks for a small thought.
	await page.locator('.tabs button:text-is("Journal")').click();
	const composer = await page.locator('.composer textarea').boundingBox();
	check('the composer is a roomy box', (composer?.height ?? 0) > 120);
	await shot('alignment-journal');
}

// 6. Fonts. The interface font is now separate from the code font, which puts
//    two things at risk that nothing else in this suite would notice: the ASCII
//    backdrop going proportional, and number columns losing their alignment.
{
	await page.goto(`${B}/settings`);
	await page.locator('.tabs').waitFor();
	await page.waitForTimeout(400);

	const uiSelect = page.locator('.font-field select').first();
	const monoSelect = page.locator('.font-field select').nth(1);
	check('both font dropdowns are there', await page.locator('.font-field select').count(), 2);
	check('and neither is a free-text box', await page.locator('input[bind\\:value]').count(), 0);

	const familyOf = (selector) =>
		page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily);
	const rootVar = (name) =>
		page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

	check('the interface font defaults to Quicksand', (await rootVar('--font-ui')).includes('Quicksand'));

	// The backdrop's font must not move when the code font does. This is the
	// regression that ships silently: it never appears in a diff, and a distorted
	// spiral gets blamed on anything but the font setting.
	const backdropBefore = await familyOf('.backdrop pre');
	await monoSelect.selectOption('courier');
	await page.waitForTimeout(300);
	check('the code font changed', (await rootVar('--font-mono')).includes('Courier'));
	check('but the galaxy backdrop did not', await familyOf('.backdrop pre'), backdropBefore);
	check('the backdrop is still monospace', backdropBefore.includes('SF Mono'));

	// Switching the interface font must not drag code along with it.
	await uiSelect.selectOption('georgia');
	await page.waitForTimeout(300);
	check('the interface font changed', (await rootVar('--font-ui')).includes('Georgia'));
	check('and the backdrop still did not', await familyOf('.backdrop pre'), backdropBefore);
	await shot('fonts-swapped');

	// Back to the shipped defaults before anything else looks at the page.
	await uiSelect.selectOption('quicksand');
	await monoSelect.selectOption('source-code-pro');
	await page.waitForTimeout(300);
}

// 7. Numbers line up. Digits in a proportional face are not equal width, so a
//    figure in a column has to opt into the monospace font.
{
	await page.goto(`${B}/admin`);
	await page.locator('.tabs, nav').first().waitFor();
	await page.getByRole('button', { name: 'Usage' }).click();
	await page.waitForTimeout(500);
	const cell = page.locator('td.num').first();
	if (await cell.count()) {
		const family = await cell.evaluate((el) => getComputedStyle(el).fontFamily);
		check('a figure in the usage table is monospace', family.includes('Source Code Pro'));
	} else {
		// No usage rows in a fresh instance; the rule itself is what matters.
		const declared = await page.evaluate(() => {
			const el = document.createElement('span');
			el.className = 'num';
			document.body.appendChild(el);
			const f = getComputedStyle(el).fontFamily;
			el.remove();
			return f;
		});
		check('the .num utility resolves to the code font', declared.includes('Source Code Pro'));
	}
}

if (fail.length) await shot('final-state');
await browser.close();

if (fail.length) {
	console.log(`\nSMOKE-UI FAILED: ${fail.join(', ')}`);
	process.exit(1);
}
console.log('\nSMOKE-UI PASSED');
process.exit(0);
