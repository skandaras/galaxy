<script lang="ts">
	import { ask } from '$lib/confirm.svelte';

	type Kind = 'preference' | 'pattern';
	interface MemoryItem {
		id: string;
		kind: string;
		title: string;
		content: string;
		status: 'active' | 'archived';
		createdAt: number;
	}
	interface Proposal {
		id: string;
		action: 'add' | 'update' | 'retire';
		itemId: string | null;
		kind: Kind | null;
		title: string;
		content: string;
		why: string;
	}
	interface Rebuild {
		running: boolean;
		done: number;
		total: number;
		proposals: number;
		failed: number;
		stopped?: string;
	}
	interface Candidate {
		id: string;
		name: string;
		description: string;
		rationale: string;
		tasks: string;
		body: string;
		status: 'pending' | 'approved' | 'rejected';
	}
	/** A row being reworded, whether a held memory or a proposal about to be approved. */
	interface Draft {
		id: string;
		title: string;
		content: string;
		kind: Kind;
	}

	let items = $state<MemoryItem[]>([]);
	let proposals = $state<Proposal[]>([]);
	let myCandidates = $state<Candidate[]>([]);
	let enabled = $state(true);
	let scheduleEnabled = $state(true);
	let intervalHours = $state(12);
	let lastRun = $state(0);
	let nextDue = $state(0);
	let cap = $state(50);
	let rebuild = $state<Rebuild | null>(null);
	let busy = $state<'run' | 'consolidate' | 'rebuild' | null>(null);
	let draft = $state<Draft | null>(null);
	let notice = $state<{ text: string; error?: boolean } | null>(null);
	let loadFailed = $state(false);

	async function load() {
		const res = await fetch('/api/memory').catch(() => null);
		if (!res?.ok) {
			loadFailed = true;
			return;
		}
		loadFailed = false;
		const data = await res.json();
		items = data.items;
		proposals = data.proposals ?? [];
		myCandidates = data.myCandidates ?? [];
		enabled = data.enabled;
		scheduleEnabled = data.scheduleEnabled;
		intervalHours = data.intervalHours;
		lastRun = data.lastRun;
		nextDue = data.nextDue;
		cap = data.cap ?? cap;
		rebuild = data.rebuild ?? null;
	}
	$effect(() => {
		void load();
	});
	// While a rebuild reads history in the background, follow it here: the
	// queue fills as each window is read.
	$effect(() => {
		if (!rebuild?.running) return;
		const timer = setInterval(() => void load(), 3000);
		return () => clearInterval(timer);
	});

	/** Read the server's reason for a refusal, so the notice says what it said. */
	async function reason(res: Response | null, fallback: string): Promise<string> {
		if (!res) return fallback;
		const body = await res.json().catch(() => null);
		return body?.message ?? fallback;
	}

	async function toggleEnabled() {
		const next = !enabled;
		const res = await fetch('/api/memory/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: next })
		}).catch(() => null);
		if (res?.ok) enabled = next;
		else notice = { text: 'Could not change that setting.', error: true };
	}

	async function runNow() {
		busy = 'run';
		notice = null;
		const res = await fetch('/api/memory/run', { method: 'POST' }).catch(() => null);
		busy = null;
		if (!res?.ok) {
			notice = { text: await reason(res, 'The review did not run.'), error: true };
			return;
		}
		const result = await res.json();
		const n = result.proposals ?? 0;
		notice = result.ran
			? {
					text: `${n ? `${n} ${n === 1 ? 'proposal' : 'proposals'} waiting for you below` : 'Nothing worth proposing'}${result.candidates ? `, and ${result.candidates} skill ${result.candidates === 1 ? 'candidate' : 'candidates'}` : ''}.`
				}
			: { text: `Nothing to do: ${result.reason}` };
		await load();
	}

	async function consolidate() {
		busy = 'consolidate';
		notice = null;
		const res = await fetch('/api/memory/consolidate', { method: 'POST' }).catch(() => null);
		busy = null;
		if (!res?.ok) {
			notice = { text: await reason(res, 'Consolidation did not run.'), error: true };
			return;
		}
		const result = await res.json();
		notice = !result.ran
			? { text: `Nothing to do: ${result.reason}` }
			: result.proposals
				? { text: `${result.proposals} changes proposed below. Nothing changes until you approve them.` }
				: { text: 'Nothing worth merging: the list is already tight.' };
		await load();
	}

	async function startRebuild() {
		if (
			!(await ask({
				title: 'Wipe and rebuild your memory?',
				body:
					'Every memory you hold, everything waiting for you, and your "Long term user memory" document are deleted now. ' +
					'Then your whole history is read again, and what it suggests waits here for you to approve.',
				confirm: 'Wipe and rebuild',
				danger: true
			}))
		)
			return;
		busy = 'rebuild';
		notice = null;
		const res = await fetch('/api/memory/rebuild', { method: 'POST' }).catch(() => null);
		busy = null;
		if (!res?.ok) {
			notice = { text: await reason(res, 'The rebuild did not start.'), error: true };
			return;
		}
		await load();
	}

	async function decide(p: Proposal, approve: boolean) {
		const edited = draft?.id === p.id ? draft : null;
		const res = await fetch(`/api/memory/proposals/${p.id}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(
				edited
					? { approve, title: edited.title, content: edited.content, kind: edited.kind }
					: { approve }
			)
		}).catch(() => null);
		if (!res?.ok) {
			notice = { text: await reason(res, 'Could not record that decision.'), error: true };
			await load();
			return;
		}
		if (edited) draft = null;
		notice = null;
		await load();
	}

	async function saveItem(item: MemoryItem) {
		if (!draft || draft.id !== item.id) return;
		const res = await fetch(`/api/memory/items/${item.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: draft.title, content: draft.content, kind: draft.kind })
		}).catch(() => null);
		if (!res?.ok) {
			notice = { text: await reason(res, 'Could not save that memory.'), error: true };
			return;
		}
		draft = null;
		notice = { text: 'Saved.' };
		await load();
	}

	async function act(item: MemoryItem, method: 'PATCH' | 'DELETE') {
		if (
			method === 'DELETE' &&
			!(await ask({
				title: 'Delete this memory?',
				body: "Archive keeps it out of your agents' context without losing it.",
				confirm: 'Delete memory',
				danger: true
			}))
		)
			return;
		const res = await fetch(`/api/memory/items/${item.id}`, { method }).catch(() => null);
		if (!res?.ok) {
			notice = {
				text: method === 'DELETE' ? 'Could not delete that memory.' : 'Could not archive that memory.',
				error: true
			};
		}
		await load();
	}

	async function decideSkill(c: Candidate, approve: boolean) {
		const res = await fetch(`/api/skills/candidates/${c.id}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ approve })
		}).catch(() => null);
		if (!res?.ok) {
			notice = { text: await reason(res, 'Could not record that decision.'), error: true };
			return;
		}
		notice = { text: approve ? `${c.name} is now one of your skills.` : `${c.name} rejected.` };
		await load();
	}

	const edit = (row: { id: string; title: string; content: string; kind: string | null }) =>
		(draft = {
			id: row.id,
			title: row.title,
			content: row.content,
			kind: row.kind === 'pattern' ? 'pattern' : 'preference'
		});

	/** An untitled memory is named by the start of what it says, as agents see it. */
	const titleOf = (m: { title: string; content: string }) => {
		if (m.title.trim()) return m.title;
		const words = m.content.trim().split(/\s+/);
		return words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '');
	};
	const heldItem = (id: string | null) => items.find((i) => i.id === id);
	const when = (ts: number) => (ts ? new Date(ts).toLocaleString() : 'never');
	const active = $derived(items.filter((i) => i.status === 'active'));
	const archived = $derived(items.filter((i) => i.status === 'archived'));
	/** What the titles cost per message: the bodies stay out until an agent asks. */
	const footprint = $derived(
		active.slice(0, cap).reduce((n, i) => n + titleOf(i).length + 3, 0)
	);
	const ACTION_LABEL: Record<Proposal['action'], string> = {
		add: 'New',
		update: 'Change',
		retire: 'Retire'
	};
</script>

<!-- A page of its own, in the rail's Knowledge group beside the Library. As a
     Settings tab it sat between Theme and Notifications, away from the other
     places that feed what the agents know. -->
<div class="memory-page">
<h1>Memory</h1>
<section class="memory-section">
	{#if loadFailed}<p class="notice error" role="alert">Your memory did not load.</p>{/if}
	{#if notice}
		<p class="notice" class:error={notice.error} role={notice.error ? 'alert' : 'status'}>
			{notice.text}
		</p>
	{/if}

	<article class="card">
		<h3>Your memory</h3>
		<p class="hint">
			Every {intervalHours}h the memory agent reads <em>your</em> recent chats and coding sessions
			for how you like to work: standing preferences and patterns that will still be true in six
			months. Not what you asked about, and not facts about your world. It only proposes: nothing
			reaches your agents until you approve it below. Your agents see each memory's title and read
			the rest only when it bears on what you asked. Private to you; hidden chats are never read.
		</p>
		<div class="row">
			<label class="chk">
				<input type="checkbox" checked={enabled} onchange={toggleEnabled} />
				keep proposing memories
			</label>
			<button class="btn" disabled={busy !== null || rebuild?.running} onclick={runNow}>
				{busy === 'run' ? 'Reviewing…' : 'Run now'}
			</button>
			<button
				class="btn"
				disabled={busy !== null || rebuild?.running}
				title="Look for memories that say the same thing and propose a shorter list."
				onclick={consolidate}
			>
				{busy === 'consolidate' ? 'Consolidating…' : 'Consolidate'}
			</button>
			<button
				class="btn danger"
				disabled={busy !== null || rebuild?.running}
				title="Delete everything held and waiting, then read your whole history again."
				onclick={startRebuild}
			>
				{busy === 'rebuild' ? 'Starting…' : 'Wipe and rebuild'}
			</button>
			<span class="meta">
				last run {when(lastRun)}
				<!-- Counted from the last run, so before the first one it came out as
				     1970. Until then the next scheduled check is the first run. -->
				{#if enabled && scheduleEnabled && lastRun} · next {when(nextDue)}{/if}
				{#if !scheduleEnabled} · automatic runs are off platform-wide{/if}
			</span>
		</div>
		{#if rebuild?.running}
			<p class="notice" role="status">
				Reading your history: {rebuild.done} of {rebuild.total}
				{rebuild.total === 1 ? 'batch' : 'batches'} of conversations, {rebuild.proposals} proposed so
				far.
			</p>
		{:else if rebuild && (rebuild.stopped || rebuild.failed)}
			<p class="notice error" role="alert">
				The last rebuild {rebuild.stopped ? `stopped early: ${rebuild.stopped}` : 'finished'}{rebuild.failed
					? `, and ${rebuild.failed} of its ${rebuild.total} batches could not be read`
					: ''}.
			</p>
		{/if}
	</article>

	<article class="card" class:waiting={proposals.length > 0}>
		<h3>Waiting for you {proposals.length ? `(${proposals.length})` : ''}</h3>
		{#each proposals as p (p.id)}
			{@const old = heldItem(p.itemId)}
			<div class="proposal">
				<div class="proposal-head">
					<span class="badge">{ACTION_LABEL[p.action]}</span>
					{#if p.why}<span class="hint why">{p.why}</span>{/if}
				</div>
				{#if draft?.id === p.id}
					{@render editor()}
				{:else if p.action === 'retire'}
					<div class="line"><strong>{p.title}</strong> <span class="body">{p.content}</span></div>
				{:else}
					<div class="line">
						{#if p.kind}<span class="kind">{p.kind}</span>{/if}
						<strong>{p.title}</strong>
						<span class="body">{p.content}</span>
					</div>
					{#if p.action === 'update' && old}
						<div class="line was">
							was: <strong>{titleOf(old)}</strong> <span class="body">{old.content}</span>
						</div>
					{/if}
				{/if}
				<div class="row actions">
					<button class="btn primary" onclick={() => decide(p, true)}>
						{p.action === 'retire' ? 'Retire it' : 'Approve'}
					</button>
					{#if p.action !== 'retire' && draft?.id !== p.id}
						<button class="btn" onclick={() => edit(p)}>Edit</button>
					{/if}
					{#if draft?.id === p.id}
						<button class="btn" onclick={() => (draft = null)}>Cancel edit</button>
					{/if}
					<button class="btn" onclick={() => decide(p, false)}>
						{p.action === 'retire' ? 'Keep it' : 'Reject'}
					</button>
				</div>
			</div>
		{:else}
			<p class="hint">
				Nothing waiting. Proposals appear here after a review finds something; a rejection is
				remembered, so the same thing is not proposed again.
			</p>
		{/each}
	</article>

	<article class="card">
		<h3>What it remembers ({active.length} of {cap})</h3>
		{#if active.length}
			<p class="hint footprint">
				About {footprint.toLocaleString()} characters of titles added to every chat and coding turn.
			</p>
		{/if}
		<p class="hint">
			<strong>Archive</strong> is how you say "not that": it leaves the memory out of every agent's
			context and tells the next review not to propose it again. <strong>Delete</strong> erases it
			outright, so a later review could propose the same thing afresh.
		</p>
		<table>
			<tbody>
				{#each active as item (item.id)}
					<tr>
						<td class="kind">{item.kind}</td>
						<td>
							{#if draft?.id === item.id}
								{@render editor()}
							{:else}
								<strong>{titleOf(item)}</strong>
								<div class="body">{item.content}</div>
							{/if}
						</td>
						<td class="actions">
							{#if draft?.id === item.id}
								<button class="btn primary" onclick={() => saveItem(item)}>Save</button>
								<button class="btn" onclick={() => (draft = null)}>Cancel</button>
							{:else}
								<button class="btn" onclick={() => edit(item)}>Edit</button>
								<button
									class="btn"
									title="Drops it from every agent's context and stops it being proposed again."
									onclick={() => act(item, 'PATCH')}>Archive</button
								>
								<button
									class="btn danger"
									title="Erases it. A later review could propose the same thing again; archive instead if you never want it back."
									onclick={() => act(item, 'DELETE')}>Delete</button
								>
							{/if}
						</td>
					</tr>
				{:else}
					<tr>
						<td class="hint">Nothing yet. Memories appear here once you approve them.</td>
					</tr>
				{/each}
			</tbody>
		</table>

		{#if archived.length}
			<details>
				<summary
					>{archived.length} archived: kept out of context, and never proposed again</summary
				>
				<table>
					<tbody>
						{#each archived as item (item.id)}
							<tr class="archived">
								<td class="kind">{item.kind}</td>
								<td><strong>{titleOf(item)}</strong> <span class="body">{item.content}</span></td>
								<td class="actions">
									<button
										class="btn danger"
										title="Erases it. A later review could propose the same thing again; archiving is what makes that stick."
										onclick={() => act(item, 'DELETE')}>Delete</button
									>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}
	</article>

	{#if myCandidates.length}
		<article class="card skills">
			<h3>Skills proposed from your work</h3>
			<p class="hint">
				A skill is written instructions for a procedure, which your agents load when it applies.
				Approve one and it is yours: your agents use it and nobody else's do, unless an admin
				shares it. A rejection is remembered, so the same skill is not proposed again.
			</p>
			{#each myCandidates as c (c.id)}
				<div class="cand">
					<div class="cand-head">
						<span class="cand-name">{c.name}</span>
						<span class="cand-desc">{c.description}</span>
						<span class="cand-status {c.status}">{c.status}</span>
					</div>
					{#if c.status === 'pending'}
						{#if c.rationale}<p class="hint why">{c.rationale}</p>{/if}
						<details>
							<summary>The instructions{c.tasks ? ` (for ${c.tasks})` : ''}</summary>
							<pre class="skill-body">{c.body}</pre>
						</details>
						<div class="row actions">
							<button class="btn primary" onclick={() => decideSkill(c, true)}>Approve skill</button>
							<button class="btn" onclick={() => decideSkill(c, false)}>Reject</button>
						</div>
					{/if}
				</div>
			{/each}
		</article>
	{/if}
</section>
</div>

{#snippet editor()}
	{#if draft}
		<div class="editor">
			<label>
				<span class="hint">Title, which is what your agents see</span>
				<input type="text" maxlength="80" bind:value={draft.title} />
			</label>
			<label>
				<span class="hint">The whole of it</span>
				<textarea rows="3" maxlength="1000" bind:value={draft.content}></textarea>
			</label>
			<label class="kind-pick">
				<span class="hint">Kind</span>
				<select bind:value={draft.kind}>
					<option value="preference">preference</option>
					<option value="pattern">pattern</option>
				</select>
			</label>
		</div>
	{/if}
{/snippet}

<style>
	.memory-page {
		flex: 1;
		min-width: 0;
		padding: 1rem 1.25rem;
		overflow-y: auto;
	}
	h1 {
		margin: 0 0 1rem;
		font-size: var(--text-lg);
		letter-spacing: 0.3em;
		color: var(--heading);
	}
	.memory-section {
		max-width: 46rem;
	}
	@media (max-width: 720px) {
		.memory-page {
			padding: 0.75rem 0.85rem;
		}
	}
	.card {
		margin-bottom: 0.9rem;
	}
	.card.waiting {
		border-color: var(--accent);
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.hint {
		margin: 0 0 0.7rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	.chk {
		font-size: var(--text-base);
		color: var(--fg-dim);
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.meta {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.footprint {
		margin-bottom: 0.5rem;
	}
	.proposal {
		border-top: 1px solid var(--border);
		padding: 0.6rem 0;
		font-size: var(--text-base);
	}
	.proposal-head {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		margin-bottom: 0.3rem;
	}
	.why {
		margin: 0;
	}
	.line {
		margin: 0.15rem 0;
	}
	.body {
		color: var(--fg-dim);
	}
	/* What an update replaces, shown so the change can be judged rather than
	   taken on trust. */
	.was {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		text-decoration: line-through;
	}
	.actions {
		margin-top: 0.4rem;
	}
	.editor {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0.3rem 0;
	}
	.editor label {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.editor .hint {
		margin: 0;
	}
	.editor input,
	.editor textarea {
		width: 100%;
		box-sizing: border-box;
	}
	.kind-pick {
		max-width: 12rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-md);
	}
	td {
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	td.actions {
		white-space: nowrap;
		text-align: right;
		margin: 0;
	}
	tr.archived td {
		opacity: 0.5;
	}
	.kind {
		color: var(--accent);
		font-size: var(--text-xs);
		text-transform: uppercase;
		white-space: nowrap;
	}
	details summary {
		font-size: var(--text-base);
		color: var(--fg-dim);
		cursor: pointer;
		margin-top: 0.6rem;
	}
	.cand {
		padding: 0.45rem 0;
		border-top: 1px solid var(--border);
		font-size: var(--text-base);
	}
	.cand-head {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.skill-body {
		white-space: pre-wrap;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin: 0.4rem 0 0;
	}
	.cand-name {
		color: var(--fg);
	}
	.cand-desc {
		flex: 1;
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.cand-status {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--fg-dim);
	}
	.cand-status.approved {
		color: var(--accent);
	}
	.cand-status.rejected {
		color: var(--danger);
	}
</style>
