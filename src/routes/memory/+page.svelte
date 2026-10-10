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
	/** A row being reworded, whether a held memory or a proposal about to be approved. */
	interface Draft {
		id: string;
		title: string;
		content: string;
		kind: Kind;
	}

	let items = $state<MemoryItem[]>([]);
	let proposals = $state<Proposal[]>([]);
	let cap = $state(50);
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
		cap = data.cap ?? cap;
	}
	$effect(() => {
		void load();
	});

	/** Read the server's reason for a refusal, so the notice says what it said. */
	async function reason(res: Response | null, fallback: string): Promise<string> {
		if (!res) return fallback;
		const body = await res.json().catch(() => null);
		return body?.message ?? fallback;
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
			Memory no longer learns. What Galaxy learns about you now goes to your
			<a href="/profile">Profile</a>, where you approve each line before any agent sees it. What
			is held here still reaches your agents by title, and you can still edit, archive or delete
			it, or decide anything that was already waiting.
		</p>
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
			<p class="hint">Nothing waiting.</p>
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
</style>
