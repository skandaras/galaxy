<script lang="ts">
	/**
	 * Forge: a list of builds, and one build's tree.
	 *
	 * Deliberately thin. The charter, the sprint records and the task records are
	 * Library documents, so this links to them rather than rendering a second
	 * copy — the Library's own tree view is where somebody reads a build end to
	 * end. What is here is the part the Library cannot show: what each unit's
	 * state is, how many attempts it has had, and which check went red.
	 */
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { ForgeCheckResult, ForgeEpicState } from '$lib/server/db/schema';
	import {
		ago,
		checksInReadingOrder,
		duration,
		epicActivity,
		epicProgress,
		epicTone,
		gateSummary,
		needsApproval,
		progress,
		progressLine,
		say,
		sprintTone,
		sprintsInOrder,
		taskTone,
		type Driver,
		type GateView,
		type SprintView,
		type TaskView
	} from '$lib/forge-view';

	interface EpicRow {
		id: string;
		title: string;
		state: ForgeEpicState;
		stateReason: string;
		repoName: string;
		repoUrl: string;
		baseBranch: string;
		integrationBranch: string;
		brief: string;
		charterDocId: string | null;
		boardId: string | null;
		maxUsdOverride: number;
		standingChecks: { name: string; command: string }[] | null;
		gateChecks: { name: string; command: string }[] | null;
		acceptance: string[] | null;
		approvedAt: string | null;
		lastStepAt: string | null;
		createdAt: string;
		sprints?: number;
		tasks?: number;
		done?: number;
		blocked?: number;
	}
	interface Repo {
		fullName: string;
		cloneUrl: string;
		private: boolean;
	}
	interface EventRow {
		id: string;
		ts: number;
		task?: string | null;
		chatId?: string | null;
		name: string;
		status: 'ok' | 'error' | 'running';
		durationMs?: number | null;
		detail?: Record<string, unknown> | null;
	}
	/** What the approve route answers when the commands will not do. */
	interface Verdict {
		name: string;
		command: string;
		said: string;
	}

	let epics = $state<EpicRow[]>([]);
	let driver = $state<Driver>({ enabled: false, stepsPerTick: 1 });
	let repos = $state<Repo[]>([]);
	let githubConfigured = $state(true);
	let epic = $state<EpicRow | null>(null);
	let sprints = $state<SprintView[]>([]);
	let next = $state<{ kind: string; says: string } | null>(null);
	let gate = $state<(GateView & { results: ForgeCheckResult[] | null }) | null>(null);
	let activity = $state<EventRow[]>([]);
	let busy = $state('');
	let error = $state('');
	let creating = $state(false);

	/** Rejected commands, with what the shell made of each. Never silent. */
	let refused = $state<Verdict[]>([]);
	let red = $state<Verdict[]>([]);
	let amending = $state<{ task: TaskView; text: string; why: string } | null>(null);

	// In the URL rather than in $state so a build can be linked to, Back leaves
	// it, and the notification the driver raises has somewhere to point.
	const openId = $derived(page.url.searchParams.get('epic'));

	const draft = $state({
		title: '',
		repoUrl: '',
		repoName: '',
		brief: '',
		baseBranch: 'main',
		mirror: false
	});
	/** The approval form. Seeded from the charter's proposal, then edited. */
	let approval = $state({ standing: '', gate: '', acceptance: '', feedback: '' });

	const tree = $derived(sprintsInOrder(sprints));
	const overall = $derived(epicProgress(tree));
	const doing = $derived(epic ? epicActivity(epic, tree, driver) : null);
	/** A step is already in flight, so the button must not offer another. */
	const working = $derived(doing?.label === 'working');

	async function api(path: string, init?: RequestInit) {
		const res = await fetch(path, init);
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			// The validation answer is data, not a message: it names each command
			// and quotes the shell, and the form renders it beside the field.
			if (body?.refused || body?.red) {
				refused = body.refused ?? [];
				red = body.red ?? [];
				throw new Error(body.error ?? res.statusText);
			}
			throw new Error((body && (body.message ?? body.error)) || res.statusText);
		}
		return res.status === 204 ? null : res.json();
	}

	async function loadList() {
		try {
			const data = await api('/api/forge');
			epics = data.epics;
			driver = data.driver;
			error = '';
		} catch (e) {
			error = String(e);
		}
	}

	async function loadRepos() {
		const g = await (await fetch('/api/github/repos')).json().catch(() => null);
		githubConfigured = g?.configured ?? false;
		repos = g?.repos ?? [];
	}

	async function loadOne(id: string, quiet = false) {
		try {
			const data = await api(`/api/forge/${id}`);
			epic = data.epic;
			sprints = data.sprints;
			driver = data.driver;
			next = data.next;
			error = '';
			if (needsApproval(data.epic.state) && !quiet) seedApproval(data.epic);
		} catch (e) {
			if (!quiet) epic = null;
			error = String(e);
		}
	}

	function seedApproval(row: EpicRow) {
		const lines = (checks: { name: string; command: string }[] | null) =>
			(checks ?? []).map((c) => `${c.name}: ${c.command}`).join('\n');
		approval = {
			standing: lines(row.standingChecks),
			gate: lines(row.gateChecks),
			acceptance: (row.acceptance ?? []).join('\n'),
			feedback: ''
		};
		refused = [];
		red = [];
	}

	/**
	 * `name: command` per line, because the alternative was a table of paired
	 * inputs and this is the one form a person fills in — the commands are what
	 * they are agreeing to, and they should be able to see all of them at once.
	 *
	 * A line with no colon is taken as a bare command. That is how a sentence
	 * once became a standing check; what stops it now is the server running
	 * every one of these before it freezes anything.
	 */
	function parseChecks(text: string) {
		return text
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
			.map((line) => {
				const at = line.indexOf(':');
				if (at === -1) return { name: line, command: line };
				return { name: line.slice(0, at).trim(), command: line.slice(at + 1).trim() };
			})
			.filter((c) => c.command);
	}

	$effect(() => {
		void loadList();
		void loadRepos();
	});

	$effect(() => {
		const id = openId;
		gate = null;
		activity = [];
		amending = null;
		if (id) void loadOne(id);
		else epic = null;
	});

	/**
	 * Keep the tree current while there is something to be current about.
	 *
	 * A build moves on a five-minute tick with nobody watching, so a page that
	 * only refreshed on a click showed a stale tree for as long as you sat on it
	 * — which read as nothing happening at all. Stops the moment the build does.
	 */
	const POLL_MS = 4_000;
	let poll: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		const id = openId;
		if (poll) clearInterval(poll);
		poll = null;
		if (!id) return;
		// The liveness test is inside the tick rather than in this effect's
		// dependencies: every poll replaces `epic`, so depending on its state
		// would tear the timer down and rebuild it on each one.
		poll = setInterval(() => {
			if (epic?.state === 'running') void loadOne(id, true);
		}, POLL_MS);
	});

	/**
	 * The machinery, live. Forge already files an event for every step it takes,
	 * so this is the Observatory's own feed narrowed to one build rather than
	 * anything new being emitted for the page's benefit.
	 */
	const ACTIVITY_ROWS = 10;
	let source: EventSource | null = null;
	$effect(() => {
		const id = openId;
		source?.close();
		source = null;
		if (!id) return;
		const es = new EventSource('/api/events/stream');
		es.onmessage = (ev) => {
			// A frame that will not parse is not worth a thrown handler: these
			// streams reconnect after every backgrounded resume.
			let e: EventRow;
			try {
				e = JSON.parse(ev.data);
			} catch {
				return;
			}
			const chats = new Set(
				tree.flatMap((s) => s.tasks.map((t) => (t as { chatId?: string | null }).chatId ?? ''))
			);
			const mine =
				(e.detail as { epicId?: string } | null)?.epicId === id ||
				(!!e.chatId && chats.has(e.chatId));
			if (mine) activity = [e, ...activity].slice(0, ACTIVITY_ROWS);
		};
		source = es;
	});
	onDestroy(() => {
		source?.close();
		if (poll) clearInterval(poll);
	});

	const open = (id: string | null) =>
		void goto(id ? `/forge?epic=${id}` : '/forge', { keepFocus: true, noScroll: true });

	async function act<T>(label: string, fn: () => Promise<T>) {
		busy = label;
		error = '';
		try {
			await fn();
		} catch (e) {
			error = String(e);
		} finally {
			busy = '';
		}
	}

	const create = () =>
		act('create', async () => {
			const made = await api('/api/forge', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(draft)
			});
			creating = false;
			draft.title = draft.brief = '';
			await loadList();
			open(made.epic.id);
		});

	const patch = (body: Record<string, unknown>, label: string) =>
		act(label, async () => {
			await api(`/api/forge/${epic!.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			await Promise.all([loadOne(epic!.id), loadList()]);
		});

	const stepNow = () =>
		act('step', async () => {
			await api(`/api/forge/${epic!.id}/step`, { method: 'POST' });
			await Promise.all([loadOne(epic!.id, true), loadList()]);
		});

	const approve = (acceptRed = false) =>
		act('approve', async () => {
			refused = [];
			red = [];
			await api(`/api/forge/${epic!.id}/approve`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					standingChecks: parseChecks(approval.standing),
					gateChecks: parseChecks(approval.gate),
					acceptance: approval.acceptance
						.split('\n')
						.map((a) => a.trim())
						.filter(Boolean),
					acceptRed
				})
			});
			await Promise.all([loadOne(epic!.id), loadList()]);
		});

	const revise = () =>
		act('revise', async () => {
			refused = [];
			red = [];
			await api(`/api/forge/${epic!.id}/revise`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ note: approval.feedback })
			});
			await loadOne(epic!.id);
		});

	const amend = () =>
		act('amend', async () => {
			refused = [];
			const target = amending!;
			await api(`/api/forge/task/${target.task.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					checks: parseChecks(target.text),
					noCheckReason: target.why
				})
			});
			amending = null;
			await loadOne(epic!.id);
		});

	const showGate = (id: string) =>
		act('gate', async () => {
			gate = gate?.id === id ? null : await api(`/api/forge/gate/${id}`);
		});

	const startAmend = (t: TaskView) => {
		refused = [];
		amending = {
			task: t,
			text: ((t as { checks?: { name: string; command: string }[] }).checks ?? [])
				.map((c) => `${c.name}: ${c.command}`)
				.join('\n'),
			why: t.noCheckReason ?? ''
		};
	};

	const chipTone = (r: ForgeCheckResult) => (r.exitCode === 0 ? 'good' : 'warn');
	const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour12: false });
</script>

<div class="forge">
	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}

	{#if !openId}
		<header class="head">
			<h2>Forge</h2>
			<button class="primary" onclick={() => (creating = !creating)}>
				{creating ? 'Cancel' : 'New build'}
			</button>
		</header>
		<p class="hint">
			A brief and a repository. Forge writes a charter, plans a sprint against the repository as it
			stands, and works down the tree — nothing closes on its own opinion of its work, only on a
			list of commands returning exit 0.
		</p>
		{#if !driver.enabled}
			<p class="warn-line">
				The driver is switched off, so a build only advances when you run a step by hand. Admin →
				Forge turns it on.
			</p>
		{/if}

		{#if creating}
			<form
				class="new"
				onsubmit={(e) => {
					e.preventDefault();
					create();
				}}>
				<label>
					what to call it
					<input bind:value={draft.title} placeholder="Offline mode for the mobile app" required />
				</label>
				<label>
					repository
					<!--
					  The same list /code offers, rather than a URL box. A build clones,
					  branches and opens a pull request against whatever is typed here,
					  so "any address you like" was never the right question to ask.
					-->
					<select
						bind:value={draft.repoUrl}
						required
						disabled={!githubConfigured}
						onchange={(e) => {
							draft.repoName =
								repos.find((r) => r.cloneUrl === e.currentTarget.value)?.fullName ?? '';
						}}>
						<option value="" disabled selected>
							{githubConfigured ? 'Choose a repository' : 'No GitHub connection'}
						</option>
						{#each repos as r (r.cloneUrl)}
							<option value={r.cloneUrl}>{r.fullName}{r.private ? ' · private' : ''}</option>
						{/each}
					</select>
				</label>
				<label>
					branch to build from
					<input bind:value={draft.baseBranch} placeholder="main" />
				</label>
				<label class="wide">
					the brief, in your own words
					<textarea
						bind:value={draft.brief}
						rows="4"
						placeholder="What you want, and anything the repository will not tell it."
					></textarea>
				</label>
				<label class="check wide">
					<input type="checkbox" bind:checked={draft.mirror} /> mirror it onto a board
				</label>
				{#if !githubConfigured}
					<p class="warn-line wide">
						No GitHub token is configured, so there is nothing to build against. Admin → Settings.
					</p>
				{/if}
				<p class="hint wide">
					The charter is written before this returns — it reads the repository first, so it takes a
					minute or two. Nothing is built until you confirm its checks.
				</p>
				<button class="primary" type="submit" disabled={busy === 'create' || !githubConfigured}>
					{busy === 'create' ? 'Reading the repository…' : 'Write the charter'}
				</button>
			</form>
		{/if}

		{#if epics.length === 0}
			<p class="empty">No builds yet.</p>
		{:else}
			<ul class="epics">
				{#each epics as row (row.id)}
					{@const pct = row.tasks ? Math.round(((row.done ?? 0) / row.tasks) * 100) : 0}
					<li>
						<button class="epic-row" onclick={() => open(row.id)}>
							<span class="title">{row.title}</span>
							<span class="badge {epicTone(row.state)}">{say(row.state)}</span>
							<span class="meta">
								{row.repoName || row.repoUrl}
								{#if row.lastStepAt}· {ago(row.lastStepAt)}{/if}
							</span>
							<span class="bar" aria-hidden="true"
								><span class="fill" style:width="{pct}%"></span></span>
							<span class="meta">
								{#if row.tasks}
									{row.done} of {row.tasks} tasks · {pct}%{#if row.blocked}
										· {row.blocked} stuck{/if}
								{:else}
									no tasks planned yet
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{:else if epic && doing}
		<header class="head">
			<button class="back" onclick={() => open(null)}>‹ All builds</button>
			<h2>{epic.title}</h2>
			<span class="badge {doing.tone}">{doing.label}</span>
		</header>

		{#if doing.detail}
			<p class="reason" class:warn={doing.tone === 'warn'}>{doing.detail}</p>
		{/if}

		<p class="meta">
			{epic.repoName || epic.repoUrl} · building on <code>{epic.integrationBranch}</code> off
			<code>{epic.baseBranch}</code>
			{#if epic.lastStepAt}· last step {ago(epic.lastStepAt)}{/if}
		</p>

		<div class="links">
			{#if epic.charterDocId}
				<a href="/library?doc={epic.charterDocId}">Read the charter</a>
			{/if}
			{#if epic.boardId}
				<a href="/boards?board={epic.boardId}">Watch it on the board</a>
			{/if}
		</div>

		{#if needsApproval(epic.state)}
			<!--
			  The one moment a person is asked for anything, and the only door
			  standingChecks is ever written through. It used to offer a single
			  answer — agree — with the boxes sometimes empty, which read as "your
			  turn to write these". It now shows what was proposed, takes prose
			  feedback back to the charter, and runs every command before freezing
			  any of it.
			-->
			<section class="approve">
				<h3>Confirm what this build is judged by</h3>

				{#if refused.length}
					<div class="verdict bad">
						<strong>These are not commands this repository can run.</strong>
						<p class="hint">
							Nothing has been frozen. A check is a command a shell runs — if you want the agent to
							work out how to test something, say so in the box below and press Revise instead.
						</p>
						{#each refused as r (r.command)}
							<article><code>{r.command}</code><pre>{r.said}</pre></article>
						{/each}
					</div>
				{/if}
				{#if red.length}
					<div class="verdict warn">
						<strong>These ran, but are not green on an untouched clone.</strong>
						<p class="hint">
							Every task gate runs them, so each one will fail until the repository is green by it.
							If you know why, approve anyway.
						</p>
						{#each red as r (r.command)}
							<article><code>{r.command}</code><pre>{r.said}</pre></article>
						{/each}
						<button onclick={() => approve(true)} disabled={!!busy}>Approve anyway</button>
					</div>
				{/if}

				<div class="approve-grid">
					<div>
						<label class="wide">
							run at every task gate
							<textarea bind:value={approval.standing} rows="4"></textarea>
						</label>
						<label class="wide">
							run when a sprint closes
							<textarea
								bind:value={approval.gate}
								rows="2"
								placeholder="Empty is fine — the checks above run at sprint close too."
							></textarea>
						</label>
						<label class="wide">
							done when
							<textarea
								bind:value={approval.acceptance}
								rows="3"
								placeholder="Empty is fine — the sprint review reads the diff either way."
							></textarea>
						</label>
						<p class="hint">
							One per line, as <code>name: command</code>. Every one is run against a clean clone
							before it is frozen. After that no run can edit them, and neither can anything the
							repository says about itself.
						</p>
					</div>
					<div class="outline">
						<h4>What it plans to do</h4>
						<ol>
							{#each tree as sprint (sprint.id)}
								<li><strong>{sprint.title}</strong><br /><span class="meta">{sprint.goal}</span></li>
							{/each}
						</ol>
						<label class="wide">
							anything to change?
							<textarea
								bind:value={approval.feedback}
								rows="3"
								placeholder="In your own words. “Use the e2e suite at sprint boundaries”, “split the first sprint in two”."
							></textarea>
						</label>
						<div class="row">
							<button onclick={revise} disabled={!!busy || !approval.feedback.trim()}>
								{busy === 'revise' ? 'Re-planning…' : 'Revise the plan'}
							</button>
							<button class="primary" onclick={() => approve()} disabled={!!busy}>
								{busy === 'approve' ? 'Checking the commands…' : 'Approve and start building'}
							</button>
						</div>
					</div>
				</div>
			</section>
		{:else}
			<div class="actions">
				{#if epic.state === 'running'}
					<button onclick={() => patch({ action: 'pause' }, 'pause')} disabled={!!busy}>Pause</button
					>
					<!--
					  Says what it would do, and goes dead while a step is in flight.
					  Both because it previously read "Run one step now" and stayed
					  pressable during a run, which is what made a working build look
					  like a stuck one.
					-->
					<button onclick={stepNow} disabled={!!busy || working || !next}>
						{#if busy === 'step'}
							Running…
						{:else if working}
							A step is running
						{:else if next}
							Run the next step — {next.says}
						{:else}
							Nothing to run
						{/if}
					</button>
				{:else if epic.state === 'paused' || epic.state === 'blocked'}
					<button onclick={() => patch({ action: 'resume' }, 'resume')} disabled={!!busy}>
						Resume
					</button>
				{/if}
				{#if epic.state !== 'done' && epic.state !== 'abandoned'}
					<button
						class="danger"
						onclick={() => patch({ action: 'abandon' }, 'abandon')}
						disabled={!!busy}>Abandon</button>
				{/if}
				<label class="spend">
					its own ceiling ($, 0 uses the instance's)
					<input
						type="number"
						min="0"
						step="0.5"
						value={epic.maxUsdOverride}
						onchange={(e) => patch({ maxUsdOverride: Number(e.currentTarget.value) }, 'ceiling')} />
				</label>
			</div>

			<div class="progress">
				<span class="bar" aria-hidden="true"
					><span class="fill" style:width="{overall.percent}%"></span></span>
				<span class="meta">{progressLine(overall)}</span>
			</div>

			{#if activity.length}
				<ol class="activity">
					{#each activity as e (e.id)}
						<li class={e.status}>
							<span class="meta">{clock(e.ts)}</span>
							<span class="what">{e.name}</span>
							{#if e.durationMs}<span class="meta">{duration(e.durationMs)}</span>{/if}
						</li>
					{/each}
				</ol>
			{/if}
		{/if}

		<ol class="tree">
			{#each tree as sprint (sprint.id)}
				{@const sp = progress(sprint.tasks)}
				<li class="sprint">
					<div class="unit">
						<span class="badge {sprintTone(sprint.state)}">{say(sprint.state)}</span>
						<strong>{sprint.title}</strong>
						{#if sprint.recordDocId}
							<a class="doc" href="/library?doc={sprint.recordDocId}">record</a>
						{/if}
						<span class="meta">{sprint.goal}</span>
						{#if sprint.tasks.length}
							<span class="meta">· {sp.done}/{sp.total}</span>
						{/if}
					</div>
					{#if sprint.gate}
						{@render gateChips(sprint.gate)}
					{/if}

					{#if sprint.tasks.length}
						<ol class="tasks">
							{#each sprint.tasks as t (t.id)}
								<li>
									<div class="unit">
										<span class="badge {taskTone(t.state)}">{say(t.state)}</span>
										<span>{t.title}</span>
										{#if t.attempts}
											<span class="meta">· attempt {t.attempts + 1}</span>
										{/if}
										{#if t.noCheckReason}
											<span class="meta" title={t.noCheckReason}>· no automated check</span>
										{/if}
										{#if t.recordDocId}
											<a class="doc" href="/library?doc={t.recordDocId}">record</a>
										{/if}
										{#if t.state === 'blocked'}
											<button class="link" onclick={() => startAmend(t)}>change its check</button>
										{/if}
									</div>
									{#if t.gate}
										{@render gateChips(t.gate)}
									{/if}
									{#if amending?.task.id === t.id}
										<!--
										  The way out of a check nothing can pass. Without it the only
										  answer to one bad command was to abandon the build.
										-->
										<div class="amend">
											<p class="hint">
												Its attempts go back to nought and it rejoins the queue. Taken as written —
												no baseline run — but it still has to be something this repository can run.
											</p>
											{#if refused.length}
												<div class="verdict bad">
													{#each refused as r (r.command)}
														<article><code>{r.command}</code><pre>{r.said}</pre></article>
													{/each}
												</div>
											{/if}
											<label class="wide">
												checks, as <code>name: command</code>
												<textarea bind:value={amending.text} rows="3"></textarea>
											</label>
											<label class="wide">
												or say why it has none
												<input bind:value={amending.why} placeholder="a rename; read the diff" />
											</label>
											<div class="row">
												<button onclick={() => (amending = null)}>Cancel</button>
												<button class="primary" onclick={amend} disabled={!!busy}>
													{busy === 'amend' ? 'Checking…' : 'Put it back in the queue'}
												</button>
											</div>
										</div>
									{/if}
								</li>
							{/each}
						</ol>
					{/if}
				</li>
			{/each}
		</ol>

		{#if gate}
			<section class="gate-detail">
				<h3>
					{gate.scope} gate, attempt {gate.attempt} — {gateSummary(gate)}
					<button class="back" onclick={() => (gate = null)}>close</button>
				</h3>
				{#each checksInReadingOrder(gate) as r (r.name)}
					<article class={chipTone(r)}>
						<h4>
							{r.name}
							<span class="meta">
								exit {r.exitCode}
								{#if r.timedOut}· timed out{/if}
								· {duration(r.durationMs)}
							</span>
						</h4>
						<code class="command">{r.command}</code>
						{#if r.output}<pre>{r.output}</pre>{/if}
					</article>
				{/each}
			</section>
		{/if}
	{:else}
		<p class="empty">Loading…</p>
	{/if}
</div>

<!--
  The gate as a row of check names, each clicking through to its command and
  output. Failures first: a red unit is only ever opened to find out which check
  went red, and putting it third behind two green ones is making somebody read
  past the answer.
-->
{#snippet gateChips(g: GateView)}
	<div class="chips">
		{#each checksInReadingOrder(g) as r (r.name)}
			<button
				class="chip {chipTone(r)}"
				onclick={() => showGate(g.id)}
				title="{r.command} — exit {r.exitCode}">{r.name}</button>
		{/each}
		<span class="meta">{ago(g.createdAt)}</span>
	</div>
{/snippet}

<style>
	.forge {
		flex: 1;
		min-width: 0;
		padding: 1rem 1.25rem 3rem;
		overflow-y: auto;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
	h3 {
		font-size: var(--text-md);
		margin: 1.2rem 0 0.5rem;
	}
	h4 {
		font-size: var(--text-sm);
		margin: 0 0 0.3rem;
	}
	.hint,
	.meta {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.meta {
		font-size: var(--text-xs);
	}
	.error,
	.warn-line {
		color: var(--danger);
		font-size: var(--text-sm);
	}
	.reason {
		color: var(--fg-dim);
		font-size: var(--text-sm);
		margin: 0.2rem 0;
	}
	.reason.warn {
		color: var(--danger);
	}
	.empty {
		color: var(--fg-dim);
		padding: 2rem 0;
	}
	code {
		font-size: 0.9em;
	}

	button {
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		padding: 0.35rem 0.7rem;
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
		/* Every control is at least a thumb tall; see docs/ACCESSIBILITY.md. */
		min-height: var(--tap);
	}
	button:hover:not(:disabled) {
		border-color: var(--accent);
	}
	button:disabled {
		opacity: 0.55;
		cursor: default;
	}
	button.primary {
		border-color: var(--accent);
		color: var(--accent);
	}
	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	.back,
	.link {
		border: none;
		color: var(--fg-dim);
		padding-left: 0;
	}
	.link {
		color: var(--accent);
		font-size: var(--text-xs);
		padding: 0 0.3rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	/* The box a browser draws is 13px whatever we ask for, so the label is the
	   tap target and has to be a thumb tall itself. */
	label.check {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
		min-height: var(--tap);
	}
	input,
	select,
	textarea {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font: inherit;
		font-size: var(--text-sm);
		padding: 0.4rem 0.5rem;
		min-height: var(--tap);
		box-sizing: border-box;
	}
	input[type='checkbox'] {
		min-height: 0;
	}
	textarea {
		font-family: ui-monospace, monospace;
		resize: vertical;
	}

	.new {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 0.7rem;
		margin: 1rem 0;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg-pane);
	}
	.new .wide {
		grid-column: 1 / -1;
	}

	.epics {
		list-style: none;
		margin: 1rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.epic-row {
		width: 100%;
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.25rem 0.6rem;
		text-align: left;
		padding: 0.7rem 0.9rem;
		border-radius: 10px;
		background: var(--bg-pane);
	}
	.epic-row .title {
		font-size: var(--text-base);
	}
	.epic-row .meta,
	.epic-row .bar {
		grid-column: 1 / -1;
	}

	.badge {
		font-size: var(--text-xs);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.05rem 0.5rem;
		white-space: nowrap;
		color: var(--fg-dim);
	}
	/* Three tones, not seven: a badge with a colour per state is a legend
	   nobody reads. Warn is "stopped and wants somebody". */
	.badge.good {
		color: var(--accent);
		border-color: var(--accent);
	}
	.badge.warn {
		color: var(--danger);
		border-color: var(--danger);
	}

	/* A visible track, because at 0% against the page background this read as a
	   divider rather than as a bar somebody was waiting on. */
	.bar {
		display: block;
		height: 5px;
		border-radius: 3px;
		background: var(--bg);
		border: 1px solid var(--border);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.progress {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin: 0.8rem 0;
	}

	.activity {
		list-style: none;
		margin: 0.6rem 0;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-pane);
		max-height: 11rem;
		overflow-y: auto;
	}
	.activity li {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
		font-size: var(--text-xs);
		padding: 0.1rem 0;
	}
	.activity .what {
		font-family: ui-monospace, monospace;
		color: var(--fg);
	}
	.activity li.error .what {
		color: var(--danger);
	}

	.links {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		margin: 0.5rem 0;
		font-size: var(--text-sm);
	}
	a {
		color: var(--accent);
	}
	a.doc {
		font-size: var(--text-xs);
	}

	.actions {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 0.8rem 0;
	}
	.spend input {
		max-width: 8rem;
	}
	.row {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.approve {
		border: 1px solid var(--danger);
		border-radius: 10px;
		padding: 0.9rem 1rem;
		margin: 1rem 0;
	}
	.approve-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1.2rem;
	}
	.approve-grid > div {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-width: 0;
	}
	.outline ol {
		margin: 0;
		padding-left: 1.2rem;
	}
	.outline li {
		margin-bottom: 0.5rem;
	}

	.verdict {
		border: 1px solid var(--border);
		border-left-width: 3px;
		border-radius: 8px;
		padding: 0.6rem 0.8rem;
		margin-bottom: 0.8rem;
	}
	.verdict.bad {
		border-left-color: var(--danger);
	}
	.verdict.warn {
		border-left-color: var(--accent);
	}
	.verdict article {
		margin-top: 0.5rem;
	}
	.verdict code {
		display: block;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.amend {
		margin: 0.4rem 0 0.6rem 0.2rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.tree,
	.tasks {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
	}
	.sprint {
		border-left: 2px solid var(--border);
		padding: 0.5rem 0 0.5rem 0.8rem;
		margin-bottom: 0.5rem;
	}
	.tasks {
		margin-top: 0.4rem;
		padding-left: 0.9rem;
	}
	.tasks > li {
		padding: 0.25rem 0;
	}
	.unit {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.chips {
		display: flex;
		gap: 0.3rem;
		align-items: center;
		flex-wrap: wrap;
		margin: 0.25rem 0 0;
	}
	/* Small text, full-height target. Tapping a chip is the only way to open a
	   gate, so it takes the same --tap floor as every other control. */
	.chip {
		font-size: var(--text-xs);
		padding: 0.05rem 0.45rem;
		border-radius: 4px;
	}
	.chip.good {
		color: var(--accent);
		border-color: var(--accent);
	}
	.chip.warn {
		color: var(--danger);
		border-color: var(--danger);
	}

	.gate-detail {
		margin-top: 1.5rem;
		border-top: 1px solid var(--border);
	}
	.gate-detail h3 {
		display: flex;
		gap: 0.6rem;
		align-items: center;
	}
	.gate-detail article {
		border: 1px solid var(--border);
		border-left-width: 3px;
		border-radius: 8px;
		padding: 0.6rem 0.8rem;
		margin-bottom: 0.6rem;
	}
	.gate-detail article.warn {
		border-left-color: var(--danger);
	}
	.gate-detail article.good {
		border-left-color: var(--accent);
	}
	.gate-detail h4 {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		flex-wrap: wrap;
	}
	.command {
		display: block;
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin-bottom: 0.3rem;
		overflow-wrap: anywhere;
	}
	pre {
		background: var(--bg);
		border-radius: 6px;
		padding: 0.5rem;
		margin: 0;
		font-size: var(--text-xs);
		max-height: 18rem;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	@media (max-width: 640px) {
		.forge {
			padding: 0.8rem 0.9rem 3rem;
		}
		.actions {
			gap: 0.4rem;
		}
	}
</style>
