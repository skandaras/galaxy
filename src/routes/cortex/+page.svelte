<script lang="ts">
	import { onMount } from 'svelte';
	import LatticeMap from '$lib/components/LatticeMap.svelte';

	interface MapNode {
		id: string;
		name: string;
		description: string;
		x: number | null;
		y: number | null;
		z: number | null;
		isConvergence: boolean;
		visibility: 'personal' | 'shared';
		circuits: string[] | null;
		degree: number;
	}
	interface MapEdge {
		source: string;
		target: string;
		weight: number;
	}
	interface Link {
		otherId: string;
		otherName: string;
		weight: number;
		description: string;
		outbound: boolean;
	}

	let nodes = $state<MapNode[]>([]);
	let edges = $state<MapEdge[]>([]);
	let selectedId = $state<string | null>(null);
	let links = $state<Link[]>([]);
	let filter = $state('');
	let busy = $state(false);
	let error = $state('');

	// Editing state for the selected node, or a new one.
	let name = $state('');
	let description = $state('');
	let isConvergence = $state(false);
	let visibility = $state<'personal' | 'shared'>('personal');
	let connectTo = $state('');
	let connectWeight = $state(0.5);

	const selected = $derived(nodes.find((n) => n.id === selectedId) ?? null);

	/**
	 * The list is not a fallback for the map — it is the same interface, and the
	 * only one that works without looking at pixels. Sorted by how connected a
	 * concept is, because that is the order the chart shows too.
	 */
	const listed = $derived(
		nodes
			.filter((n) => {
				const q = filter.trim().toLowerCase();
				return !q || n.name.toLowerCase().includes(q) || n.description.toLowerCase().includes(q);
			})
			.sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))
	);

	async function load() {
		const res = await fetch('/api/cortex/map');
		if (!res.ok) return;
		const data = await res.json();
		nodes = data.nodes;
		edges = data.edges;
	}

	async function select(id: string | null) {
		selectedId = id;
		links = [];
		error = '';
		if (!id) {
			resetForm();
			return;
		}
		const res = await fetch(`/api/cortex/nodes/${encodeURIComponent(id)}`);
		if (!res.ok) return;
		const data = await res.json();
		links = data.links;
		name = data.node.name;
		description = data.node.description;
		isConvergence = data.node.isConvergence;
		visibility = data.node.visibility;
	}

	function resetForm() {
		name = '';
		description = '';
		isConvergence = false;
		visibility = 'personal';
		connectTo = '';
	}

	function startNew() {
		selectedId = null;
		links = [];
		resetForm();
		error = '';
	}

	async function send(url: string, method: string, body: unknown) {
		busy = true;
		error = '';
		try {
			const res = await fetch(url, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				error = (await res.json().catch(() => ({}))).message ?? `${res.status}`;
				return null;
			}
			return await res.json();
		} finally {
			busy = false;
		}
	}

	async function save() {
		if (!name.trim()) return;
		const body = { name, description, isConvergence, visibility };
		const saved = selectedId
			? await send(`/api/cortex/nodes/${encodeURIComponent(selectedId)}`, 'PATCH', body)
			: await send('/api/cortex/nodes', 'POST', body);
		if (!saved) return;
		await load();
		await select(saved.id);
	}

	async function connect() {
		if (!selectedId || !connectTo) return;
		const done = await send('/api/cortex/links', 'POST', {
			source: selectedId,
			target: connectTo,
			weight: connectWeight
		});
		if (!done) return;
		connectTo = '';
		await load();
		await select(selectedId);
	}

	async function disconnect(otherId: string) {
		if (!selectedId) return;
		await send('/api/cortex/links', 'DELETE', { source: selectedId, target: otherId });
		await send('/api/cortex/links', 'DELETE', { source: otherId, target: selectedId });
		await load();
		await select(selectedId);
	}

	async function remove() {
		if (!selectedId) return;
		await send(`/api/cortex/nodes/${encodeURIComponent(selectedId)}`, 'DELETE', {});
		await load();
		startNew();
	}

	onMount(load);
</script>

<div class="cortex">
	<section class="chart">
		<LatticeMap {nodes} {edges} {selectedId} onselect={select} />
	</section>

	<section class="panel">
		<header>
			<h1>Cortex</h1>
			<span class="meta">
				{nodes.length} concept{nodes.length === 1 ? '' : 's'} · {edges.length} connection{edges.length ===
				1
					? ''
					: 's'}
			</span>
		</header>

		{#if !nodes.length}
			<p class="empty">
				Nothing here yet. The lattice holds concepts and how they connect — add one below, then
				connect it to something. A concept nothing links to will never surface in a query.
			</p>
		{/if}

		<label class="search">
			<span class="sr-only">Search concepts</span>
			<input placeholder="Search concepts…" bind:value={filter} />
		</label>

		<!-- The accessible representation and the click target are the same list.
		     A canvas is opaque to a screen reader, and a hidden parallel view is a
		     thing that rots; this one cannot, because everyone uses it. -->
		<ul class="nodes" aria-label="Concepts in the lattice">
			{#each listed as node (node.id)}
				<li>
					<button
						class="node"
						class:on={node.id === selectedId}
						aria-current={node.id === selectedId ? 'true' : undefined}
						onclick={() => select(node.id)}
					>
						<span class="name">{node.name}</span>
						<span class="tags">
							{#if node.isConvergence}<span class="badge">bridge</span>{/if}
							{#if node.visibility === 'shared'}<span class="badge">shared</span>{/if}
							<span class="deg">{node.degree}</span>
						</span>
					</button>
				</li>
			{/each}
		</ul>

		<div class="editor">
			<h2>{selectedId ? 'Edit concept' : 'New concept'}</h2>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<input placeholder="Name" bind:value={name} />
			<textarea placeholder="What it is, and why it matters" bind:value={description}></textarea>
			<div class="row">
				<label><input type="checkbox" bind:checked={isConvergence} /> Bridges domains</label>
				<label>
					<input type="checkbox" checked={visibility === 'shared'}
						onchange={(e) => (visibility = e.currentTarget.checked ? 'shared' : 'personal')} />
					Shared
				</label>
			</div>
			<div class="row">
				<button class="btn" disabled={busy || !name.trim()} onclick={save}>Save</button>
				{#if selectedId}
					<button class="btn" onclick={startNew}>New</button>
					<button class="btn danger" disabled={busy} onclick={remove}>Delete</button>
				{/if}
			</div>

			{#if selected}
				<h2>Connections</h2>
				{#if links.length}
					<ul class="links">
						{#each links as link (link.otherId)}
							<li>
								<button class="link-name" onclick={() => select(link.otherId)}>
									{link.otherName}
								</button>
								<span class="deg">{link.weight.toFixed(2)}</span>
								<button
									class="unlink"
									aria-label={`Disconnect ${selected.name} from ${link.otherName}`}
									onclick={() => disconnect(link.otherId)}>×</button
								>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="empty">
						Nothing connects to this yet, so no query will ever reach it.
					</p>
				{/if}
				<div class="row">
					<label class="grow">
						<span class="sr-only">Connect to</span>
						<select bind:value={connectTo}>
							<option value="">Connect to…</option>
							{#each nodes.filter((n) => n.id !== selectedId && !links.some((l) => l.otherId === n.id)) as n (n.id)}
								<option value={n.id}>{n.name}</option>
							{/each}
						</select>
					</label>
					<label class="weight">
						<span class="sr-only">Strength</span>
						<input type="number" min="0" max="1" step="0.05" bind:value={connectWeight} />
					</label>
					<button class="btn" disabled={busy || !connectTo} onclick={connect}>Link</button>
				</div>
			{/if}
		</div>
	</section>
</div>

<style>
	.cortex {
		display: flex;
		flex: 1;
		min-width: 0;
	}
	.chart {
		display: flex;
		flex: 1;
		min-width: 0;
	}
	.panel {
		width: 340px;
		flex-shrink: 0;
		padding: 0.75rem;
		box-sizing: border-box;
		overflow-y: auto;
		border-left: 1px solid var(--border);
		background: var(--bg-pane);
	}
	header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	h1 {
		font-size: 1rem;
		margin: 0 0 0.3rem;
		color: var(--heading);
	}
	h2 {
		font-size: var(--text-sm);
		color: var(--label);
		margin: 1rem 0 0.4rem;
	}
	.meta,
	.deg {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.empty {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		line-height: 1.5;
	}
	.search input,
	.editor input:not([type]),
	.editor textarea,
	.editor select {
		width: 100%;
		box-sizing: border-box;
		padding: 0.35rem 0.5rem;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--control-border);
	}
	.search {
		display: block;
		margin: 0.5rem 0;
	}
	.nodes,
	.links {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 34vh;
		overflow-y: auto;
	}
	.node {
		display: flex;
		width: 100%;
		gap: 0.5rem;
		align-items: center;
		justify-content: space-between;
		padding: 0.3rem 0.4rem;
		background: none;
		border: 1px solid transparent;
		color: var(--fg);
		text-align: left;
		cursor: pointer;
	}
	.node:hover {
		border-color: var(--border);
	}
	.node.on {
		border-color: var(--accent);
		color: var(--heading);
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tags {
		display: flex;
		gap: 0.3rem;
		align-items: center;
		flex-shrink: 0;
	}
	.badge {
		font-size: 0.65rem;
		padding: 0 0.3rem;
		border: 1px solid var(--border);
		color: var(--fg-dim);
	}
	.editor textarea {
		min-height: 4.5rem;
		margin-top: 0.4rem;
		resize: vertical;
	}
	.row {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		margin-top: 0.5rem;
		flex-wrap: wrap;
	}
	.row label {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.grow {
		flex: 1;
		min-width: 8rem;
	}
	.weight input {
		width: 4.5rem;
	}
	.links li {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.15rem 0;
	}
	.link-name {
		flex: 1;
		background: none;
		border: none;
		color: var(--accent);
		text-align: left;
		cursor: pointer;
		padding: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.unlink {
		background: none;
		border: none;
		color: var(--fg-dim);
		cursor: pointer;
	}
	.btn {
		padding: 0.3rem 0.7rem;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--control-border);
		cursor: pointer;
	}
	.btn.danger {
		color: var(--danger);
	}
	.error {
		font-size: var(--text-sm);
		color: var(--danger);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	@media (max-width: 800px) {
		.cortex {
			flex-direction: column;
		}
		.panel {
			width: 100%;
			border-left: none;
			border-top: 1px solid var(--border);
		}
	}
</style>
