/**
 * Command line for the evaluation runner. Run from the repository root:
 *
 *   npm run eval -- --data-dir /path/to/scratch-copy --cases cases.jsonl
 *
 * The script runs vite-node with every module in SSR mode; without that,
 * SvelteKit's guard reads $lib/server imports as browser code and refuses them.
 *
 * Point it at a scratch copy of an instance, never the live data directory:
 * every case writes chats there. docs/EVAL.md has the copying steps and every
 * flag.
 *
 * Everything is imported after the arguments are read, because the database
 * module opens DATA_DIR the moment it loads, and this sets DATA_DIR. It never
 * imports hooks.server.ts, which would start the scheduler.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Set once the data directory is confirmed and the database is open. Cleanup
 * imports the MCP module only then: it imports the database module, and an
 * early exit must not open a directory this refused, or create ./data for --help.
 */
let opened = false;

function parse(argv: string[]) {
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) flags.set(a.slice(2), true);
		else {
			flags.set(a.slice(2), next);
			i++;
		}
	}
	const str = (k: string) => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
	return { flags, str };
}

const USAGE = `Usage: npm run eval -- --data-dir <scratch copy> [options]
  --cases <file.jsonl>        cases to run (see src/lib/server/eval/cases.sample.jsonl)
  --from-chat <chat id>       add a case from a chat in the copy (its last question is the prompt)
  --list-feedback down|up     list replies people rated, as candidates for cases, and stop
  --user <user id>            whose chats and profile the cases run as (default: the chat's owner, or the first admin)
  --variants a,b,...          baseline, short-language, effort:low|medium|high, lean, no-evidence, pinned:<slug>, model:<id>
  --model <model id>          run every variant on this model
  --pin <provider slug>       the endpoint for a bare "pinned" variant
  --repeat <k>                run each case k times, to see whether a difference holds
  --max-usd <n>               stop calling models once this much is spent (default 1)
  --live-tools                let tools run for real instead of from the cases' fixtures
  --dump-request              print each case's request body for the first variant, call nothing
  --out <dir>                 where to write (default eval-out/<timestamp>)`;

async function main() {
	const { flags, str } = parse(process.argv.slice(2));
	if (flags.has('help')) {
		console.log(USAGE);
		return;
	}
	const dataDir = str('data-dir') ?? process.env.DATA_DIR;
	if (!dataDir) {
		console.error('Give --data-dir: a scratch copy of the instance, never the live one.\n');
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	// SvelteKit snapshots the environment, .env included, when Vite starts, and
	// the database module prefers that snapshot. A DATA_DIR there would win over
	// this flag and point the run at whatever it names, a live instance
	// included, so the two must agree before the database is even opened.
	const { env } = await import('$env/dynamic/private');
	if (env.DATA_DIR && resolve(env.DATA_DIR) !== resolve(dataDir)) {
		console.error(
			`DATA_DIR is set to ${env.DATA_DIR} in the environment or .env, which would win over --data-dir ${dataDir}. Unset it, or run with DATA_DIR=${dataDir}.`
		);
		process.exitCode = 2;
		return;
	}
	process.env.DATA_DIR = dataDir;

	const { runMigrations, db, dataDir: openedDir } = await import('$lib/server/db');
	if (resolve(openedDir) !== resolve(dataDir)) {
		console.error(`The database opened ${openedDir}, not ${dataDir}. Stopping before anything is written.`);
		process.exitCode = 2;
		return;
	}
	opened = true;
	const { chats, users } = await import('$lib/server/db/schema');
	const { getChat } = await import('$lib/server/chats');
	const runner = await import('./runner');
	runMigrations();

	if (flags.has('list-feedback')) {
		const rating = str('list-feedback') === 'up' ? 'up' : 'down';
		for (const row of runner.listFeedback(rating, str('user'))) {
			console.log(`${row.chatId}  ${row.title}\n  asked:   ${row.asked}\n  replied: ${row.replied}\n`);
		}
		return;
	}

	const cases: import('./runner').EvalCase[] = [];
	const casesFile = str('cases');
	if (casesFile) {
		for (const line of readFileSync(casesFile, 'utf8').split('\n')) {
			if (line.trim()) cases.push(JSON.parse(line));
		}
	}
	const fromChat = str('from-chat');
	if (fromChat) cases.push({ id: `chat-${fromChat.slice(0, 8)}`, fromChat, prompt: str('prompt') ?? '' });
	if (!cases.length) {
		console.error('No cases: give --cases or --from-chat.\n');
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}

	const owner = fromChat ? db.select().from(chats).all().find((c) => c.id === fromChat)?.userId : undefined;
	const userId =
		str('user') ?? owner ?? db.select().from(users).all().find((u) => u.isAdmin)?.id ?? db.select().from(users).get()?.id;
	if (!userId) {
		console.error('No user to run as: give --user.');
		process.exitCode = 2;
		return;
	}
	if (fromChat && !getChat(fromChat, userId)) {
		console.error(`Chat ${fromChat} does not belong to ${userId}.`);
		process.exitCode = 2;
		return;
	}

	const variants = (str('variants') ?? 'baseline')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((v) => runner.parseVariant(v, { pin: str('pin') }));
	// NaN compares false against everything, so a mistyped cap ("0,50") would
	// switch it off rather than set it.
	const maxUsd = Number(str('max-usd') ?? 1);
	if (!Number.isFinite(maxUsd) || maxUsd < 0) {
		console.error(`--max-usd must be a number of dollars, 0 or more; got ${str('max-usd')}.`);
		process.exitCode = 2;
		return;
	}
	const ctx = {
		userId,
		maxUsd,
		spent: { usd: 0, unpriced: 0 },
		liveTools: flags.has('live-tools'),
		modelId: str('model')
	};

	if (flags.has('dump-request')) {
		for (const c of cases) console.log(JSON.stringify({ case: c.id, variant: variants[0].name, body: runner.dumpRequest(c, variants[0], ctx) }, null, 2));
		return;
	}

	const repeat = Math.max(1, Number(str('repeat') ?? 1));
	const results: import('./runner').CaseResult[] = [];
	for (const c of cases) {
		for (let k = 0; k < repeat; k++) {
			for (const v of variants) {
				const r = await runner.runCase(c, v, ctx);
				results.push(repeat > 1 ? { ...r, variant: `${r.variant}#${k + 1}` } : r);
				console.log(`${c.id} · ${r.variant}${repeat > 1 ? ` #${k + 1}` : ''}: ${r.error ? `failed (${r.error})` : `${r.totalMs} ms, ${r.costUsd === null ? 'unpriced' : `$${r.costUsd}`}`}`);
			}
		}
	}
	const runName = new Date().toISOString().replace(/[:.]/g, '-');
	const out = str('out') ?? join('eval-out', runName);
	runner.writeRun(out, results, runName);
	console.log(
		`\nWrote ${results.length} replies to ${out}. Spent $${ctx.spent.usd.toFixed(4)}` +
			(ctx.spent.unpriced ? `, plus ${ctx.spent.unpriced} call(s) with no price.` : '.') +
			(ctx.spent.usd >= ctx.maxUsd ? ` The cap of $${ctx.maxUsd} was reached; later calls were not made.` : '')
	);
}

// Awaited at the top level: vite-node closes its server once this module's
// top level returns, and every import above is still to come at that point.
try {
	await main();
} catch (err) {
	console.error(err);
	process.exitCode = 1;
} finally {
	// A live MCP call leaves a pooled client with an idle timer, and a stdio
	// server as a child process, either of which keeps this process alive.
	if (opened) {
		const { disconnectAll } = await import('$lib/server/engine/tools/mcp');
		disconnectAll();
	}
}
