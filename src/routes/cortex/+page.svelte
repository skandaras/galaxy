<script lang="ts">
	import { onMount } from 'svelte';
	import { createResizablePane } from '$lib/resizable-pane.svelte';
	import LatticeMap from '$lib/components/LatticeMap.svelte';
	import PaneResizer from '$lib/components/PaneResizer.svelte';

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
	interface ComparisonSide {
		answer: string;
		promptChars: number;
		promptTokens: number | null;
		completionTokens: number | null;
		ms: number;
	}
	interface Comparison {
		prompt: string;
		withLattice: ComparisonSide;
		without: ComparisonSide;
		concepts: { id: string; name: string; activation: number }[];
	}
	interface GroomResult {
		ran: boolean;
		mode: 'harvest' | 'review';
		reason?: string;
		tidied?: number;
		detected?: number;
		proposed?: number;
		duplicates?: number;
		replyChars?: number;
		parsedItems?: number;
	}
	interface Proposal {
		id: string;
		kind: string;
		title: string;
		rationale: string;
		createdAt: number;
	}
	interface Change {
		id: string;
		event: string;
		detail: string;
		actor: 'user' | 'agent' | 'groom';
		runId: string | null;
		before: unknown;
		createdAt: number;
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
	/** Comma-separated while editing; the API takes an array. */
	let areas = $state('');
	let circuits = $state<{ id: string; name: string; count: number }[]>([]);
	let proposals = $state<Proposal[]>([]);
	let changes = $state<Change[]>([]);
	let tab = $state<'edit' | 'review' | 'history' | 'data' | 'effect'>('edit');
	/** Per button, so one running does not make both say "Working". */
	let running = $state<'harvest' | 'review' | null>(null);
	let lastRun = $state<GroomResult | null>(null);
	let importing = $state(false);
	let comparePrompt = $state('');
	let comparing = $state(false);
	let comparison = $state<Comparison | null>(null);
	let fileInput = $state<HTMLInputElement>();

	const selected = $derived(nodes.find((n) => n.id === selectedId) ?? null);
	const areaNames = $derived(new Map(circuits.map((c) => [c.id, c.name])));

	/**
	 * Width of the side panel, draggable by the divider and remembered per
	 * browser. It was a fixed 340px, which is too narrow for a concept editor,
	 * a review queue and a two-answer comparison to share.
	 */
	const panel = createResizablePane({
		key: 'galaxy:cortex-panel-width',
		// The panel sits to the *right* of its handle, unlike every other pane in
		// the app, so the drag delta has to be read the other way round.
		anchor: 'right',
		min: 300,
		max: 720,
		initial: 400
	});

	const TABS = [
		['edit', 'Concept'],
		['review', 'Suggestions'],
		['history', 'History'],
		['effect', 'Compare'],
		['data', 'File']
	] as const;

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
		const [mapRes, circuitRes] = await Promise.all([
			fetch('/api/cortex/map'),
			fetch('/api/cortex/circuits')
		]);
		if (mapRes.ok) {
			const data = await mapRes.json();
			nodes = data.nodes;
			edges = data.edges;
		}
		if (circuitRes.ok) circuits = await circuitRes.json();
		await Promise.all([loadProposals(), loadChanges()]);
	}

	async function loadProposals() {
		const res = await fetch('/api/cortex/proposals');
		if (res.ok) proposals = await res.json();
	}

	async function loadChanges() {
		const res = await fetch('/api/cortex/changes?limit=60');
		if (res.ok) changes = await res.json();
	}

	async function decide(id: string, status: 'actioned' | 'discarded') {
		await send(`/api/cortex/proposals/${id}`, 'POST', { status });
		await loadProposals();
	}

	async function groom(mode: 'harvest' | 'review') {
		running = mode;
		error = '';
		lastRun = null;
		try {
			lastRun = await send('/api/cortex/groom', 'POST', { mode });
			await load();
		} finally {
			running = null;
		}
	}

	function exportLattice() {
		// Straight to a download rather than through the server's own export
		// directory: what you want is the file, not a copy of it on the droplet.
		window.location.href = '/api/cortex/export';
	}

	async function importLattice(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file) return;
		importing = true;
		error = '';
		try {
			const payload = JSON.parse(await file.text());
			const res = await send('/api/cortex/import', 'POST', payload);
			if (res) {
				error = `Imported ${res.nodes} concept(s), ${res.edges} connection(s)` +
					(res.skipped ? ` — ${res.skipped} skipped` : '');
			}
			await load();
		} catch {
			error = 'That file is not a lattice export.';
		} finally {
			importing = false;
			if (fileInput) fileInput.value = '';
		}
	}

	async function compare() {
		if (!comparePrompt.trim()) return;
		comparing = true;
		error = '';
		comparison = null;
		try {
			const res = await fetch('/api/cortex/compare', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ prompt: comparePrompt })
			});
			if (!res.ok) {
				error = (await res.json().catch(() => ({}))).message ?? `${res.status}`;
				return;
			}
			comparison = await res.json();
		} finally {
			comparing = false;
		}
	}

	async function undo(change: Change) {
		await send('/api/cortex/changes/revert', 'POST', { id: change.id });
		await load();
	}

	/** One line per groom run, so a run touching fifty concepts is one row. */
	const grouped = $derived.by(() => {
		const out: { runId: string | null; actor: string; at: number; items: Change[] }[] = [];
		for (const c of changes) {
			const last = out.at(-1);
			if (last && c.runId && last.runId === c.runId) last.items.push(c);
			else out.push({ runId: c.runId, actor: c.actor, at: c.createdAt, items: [c] });
		}
		return out;
	});

	/**
	 * Areas are typed as names, stored as ids. A name with no area behind it
	 * creates one — filing something should not be a two-step errand.
	 */
	async function resolveAreas(): Promise<string[]> {
		const wanted = areas
			.split(',')
			.map((a) => a.trim())
			.filter(Boolean);
		const out: string[] = [];
		for (const name of wanted) {
			const known = circuits.find((c) => c.name.toLowerCase() === name.toLowerCase());
			if (known) {
				out.push(known.id);
				continue;
			}
			const made = await send('/api/cortex/circuits', 'POST', { name });
			if (made) out.push(made.id);
		}
		return out;
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
		areas = (data.node.circuits ?? [])
			.map((id: string) => circuits.find((c) => c.id === id)?.name ?? id)
			.join(', ');
	}

	function resetForm() {
		name = '';
		description = '';
		isConvergence = false;
		visibility = 'personal';
		connectTo = '';
		areas = '';
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
		const body = { name, description, isConvergence, visibility, circuits: await resolveAreas() };
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
		<LatticeMap {nodes} {edges} {selectedId} onselect={select} areaNames={areaNames} />
	</section>

	<PaneResizer pane={panel} label="Resize the Cortex panel" />

	<section class="panel" style={`--panel-width:${panel.width}px`}>
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


		<div class="body">
			<!-- A rail rather than a strip: five labels stacked read at a glance
			     where five squeezed across a narrow panel do not. Falls back to a
			     row under the mobile breakpoint, where the panel is full width. -->
			<div class="rail" role="tablist" aria-orientation="vertical">
				{#each TABS as [id, label] (id)}
					<button
						role="tab"
						class="tab"
						class:on={tab === id}
						aria-selected={tab === id}
						onclick={() => (tab = id as typeof tab)}
					>
						{label}{#if id === 'review' && proposals.length}<span class="count"
								>{proposals.length}</span
							>{/if}
					</button>
				{/each}
			</div>

			<div class="pane-body">
		{#if tab === 'effect'}
			<div class="editor">
				<p class="empty">
					The same question, answered twice — once with what the lattice knows about you, once
					with nothing. It shows the cost as well: the lattice answer is a longer prompt by
					construction, and the question is whether it buys enough to be worth that.
				</p>
				<textarea
					placeholder="Ask something where knowing you should matter…"
					bind:value={comparePrompt}
				></textarea>
				<div class="row">
					<button class="btn" disabled={comparing || !comparePrompt.trim()} onclick={compare}>
						{comparing ? 'Asking twice…' : 'Compare'}
					</button>
				</div>
				{#if error}<p class="error" role="alert">{error}</p>{/if}

				{#if comparison}
					<h2>With the lattice</h2>
					<p class="answer">{comparison.withLattice.answer}</p>
					<h2>Without</h2>
					<p class="answer">{comparison.without.answer}</p>

					<h2>What it cost</h2>
					<ul class="nodes">
						<li class="proposal">
							<!-- Characters are measured here and always available; tokens come
							     from the provider and some do not report them. Showing both
							     means the cost half is never simply blank. -->
							<span class="hint">
								prompt {comparison.withLattice.promptChars} vs
								{comparison.without.promptChars} characters
								(+{comparison.withLattice.promptChars - comparison.without.promptChars})
							</span>
							{#if comparison.withLattice.promptTokens !== null && comparison.without.promptTokens !== null}
								<span class="hint">
									{comparison.withLattice.promptTokens} vs {comparison.without.promptTokens} prompt
									tokens ({comparison.withLattice.promptTokens - comparison.without.promptTokens > 0
										? '+'
										: ''}{comparison.withLattice.promptTokens - comparison.without.promptTokens})
								</span>
							{:else}
								<span class="hint">This provider does not report token counts.</span>
							{/if}
							<span class="hint">
								{comparison.withLattice.ms}ms vs {comparison.without.ms}ms
							</span>
						</li>
					</ul>

					<h2>What it drew on</h2>
					{#if comparison.concepts.length}
						<ul class="nodes">
							{#each comparison.concepts as c (c.id)}
								<li>
									<button class="node" onclick={() => { tab = 'edit'; select(c.id); }}>
										<span class="name">{c.name}</span>
										<span class="deg">{c.activation.toFixed(2)}</span>
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="empty">
							Nothing activated, so both answers had the same context. Either the lattice has
							nothing bearing on this, or the question does not lean on knowing you.
						</p>
					{/if}
				{/if}
			</div>
		{:else if tab === 'data'}
			<div class="editor">
				<p class="empty">
					A lattice is far easier to draft in a file than to type in fifty times. Import reads
					what export writes — concepts, connections and areas — and matches by name, so
					importing over what is here updates rather than duplicates. It lands in the history
					as one entry and can be undone from there.
				</p>
				{#if error}<p class="error" role="alert">{error}</p>{/if}
				<div class="row">
					<button class="btn" onclick={exportLattice}>Export</button>
					<button class="btn" disabled={importing} onclick={() => fileInput?.click()}>
						{importing ? 'Importing…' : 'Import…'}
					</button>
					<input
						class="sr-only"
						type="file"
						accept="application/json,.json"
						bind:this={fileInput}
						onchange={importLattice}
					/>
				</div>
			</div>
		{:else if tab === 'review'}
			<div class="editor">
				<div class="row">
					<button class="btn" disabled={!!running} onclick={() => groom('harvest')}>
						{running === 'harvest' ? 'Reading recent activity…' : 'Catch up on recent activity'}
					</button>
					<button class="btn" disabled={!!running} onclick={() => groom('review')}>
						{running === 'review' ? 'Reading the lattice…' : 'Review the whole lattice'}
					</button>
				</div>

				{#if running}
					<p class="hint" role="status">
						{running === 'harvest'
							? 'Looking at what you have been talking about since the last pass.'
							: 'Reading every concept and connection. This one is the slow pass.'}
					</p>
				{/if}

				{#if lastRun}
					<!-- Kept until the next run. A finished pass used to report nothing,
					     so one that suggested nothing looked identical to one that
					     failed. -->
					<ul class="nodes result" role="status">
						<li class="proposal">
							<strong>{lastRun.mode === 'harvest' ? 'Caught up' : 'Reviewed'}</strong>
							<span class="hint">
								{lastRun.tidied ?? 0} tidied · {lastRun.detected ?? 0} found by the free checks ·
								{lastRun.proposed ?? 0} suggested by the model
								{#if lastRun.duplicates}· {lastRun.duplicates} already raised{/if}
							</span>
							{#if !lastRun.ran}
								<span class="error">Did not reach the model: {lastRun.reason}</span>
								{#if lastRun.reason === 'no model configured'}
									<span class="hint">Set one for the cortex-groom task in Admin → Tasks.</span>
								{/if}
							{:else if !lastRun.proposed}
								<!-- Sizes, not content: enough to tell silence from an answer
								     nothing could be made of. -->
								<span class="hint">
									The model replied with {lastRun.replyChars ?? 0} characters and
									{lastRun.parsedItems ?? 0} usable suggestions in it.
								</span>
							{/if}
							{#if proposals.length}
								<span class="hint">
									{proposals.length} waiting below.
								</span>
							{/if}
						</li>
					</ul>
				{/if}
				{#if error}<p class="error" role="alert">{error}</p>{/if}
				{#if !proposals.length}
					<p class="empty">
						Nothing waiting. <strong>Catch up</strong> reads what you have been talking about
						and suggests concepts worth keeping; <strong>review</strong> reads the whole
						lattice looking for merges and structural problems. Both also run a free check
						for concepts that connect to nothing, names that look like duplicates, and
						anything unfiled.
					</p>
				{/if}
				<ul class="nodes">
					{#each proposals as p (p.id)}
						<li class="proposal">
							<span class="badge">{p.kind}</span>
							<strong>{p.title}</strong>
							{#if p.rationale}<span class="hint">{p.rationale}</span>{/if}
							<div class="row">
								<button class="btn" onclick={() => decide(p.id, 'actioned')}>Accept</button>
								<button class="btn" onclick={() => decide(p.id, 'discarded')}>Dismiss</button>
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{:else if tab === 'history'}
			<div class="editor">
				{#if !grouped.length}
					<p class="empty">Nothing has changed yet.</p>
				{/if}
				<ul class="nodes">
					{#each grouped as g (g.items[0].id)}
						<li class="proposal">
							<span class="badge">{g.actor}</span>
							<span class="hint">{new Date(g.at).toLocaleString()}</span>
							{#each g.items as c (c.id)}
								<div class="row">
									<span class="grow">{c.event}: {c.detail}</span>
									{#if c.before}
										<button class="btn" onclick={() => undo(c)}>Undo</button>
									{/if}
								</div>
							{/each}
						</li>
					{/each}
				</ul>
			</div>
		{:else}
		<div class="editor">
			<h2>{selectedId ? 'Edit concept' : 'New concept'}</h2>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<input placeholder="Name" bind:value={name} />
			<textarea placeholder="What it is, and why it matters" bind:value={description}></textarea>
			<!-- Areas are what the agents' context index is grouped by, so a node
			     with none is harder for them to find. -->
			<input placeholder="Areas, comma separated" bind:value={areas} list="cortex-areas" />
			<datalist id="cortex-areas">
				{#each circuits as c (c.id)}<option value={c.name}></option>{/each}
			</datalist>
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
		{/if}
			</div>
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
		/* Set from the drag handle and remembered per browser — see PaneResizer,
		   which also draws the dividing line this used to carry as a border. */
		width: var(--panel-width, 400px);
		flex-shrink: 0;
		padding: 0.75rem;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--bg-pane);
	}
	.body {
		display: flex;
		gap: 0.6rem;
		flex: 1;
		min-height: 0;
	}
	.rail {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		flex-shrink: 0;
		border-right: 1px solid var(--border);
		padding-right: 0.5rem;
	}
	.pane-body {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
	}
	.count {
		margin-left: 0.3rem;
		font-size: 0.65rem;
		padding: 0 0.25rem;
		border: 1px solid var(--border);
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
		/* The proposal rows are a column, so a badge without this stretches the
		   full width and reads as an empty text field. */
		align-self: start;
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
	.tab {
		background: none;
		border: none;
		border-left: 2px solid transparent;
		color: var(--fg-dim);
		padding: 0.35rem 0.5rem;
		cursor: pointer;
		font-size: var(--text-sm);
		text-align: left;
		white-space: nowrap;
	}
	.tab.on {
		color: var(--heading);
		border-left-color: var(--accent);
	}
	.answer {
		font-size: var(--text-sm);
		line-height: 1.55;
		white-space: pre-wrap;
		border-left: 2px solid var(--border);
		padding-left: 0.6rem;
		margin: 0.3rem 0 0.6rem;
	}
	.editor textarea {
		width: 100%;
		box-sizing: border-box;
	}
	.result {
		max-height: none;
		margin-top: 0.5rem;
	}
	.result .error {
		font-size: var(--text-sm);
		color: var(--danger);
	}
	.proposal {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--border);
	}
	.hint {
		font-size: var(--text-sm);
		color: var(--fg-dim);
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
			/* Beats the inline --panel-width: full width here, not a column. */
			width: 100%;
			border-top: 1px solid var(--border);
		}
		/* No room beside the content on a phone, so the rail lies down. */
		.body {
			flex-direction: column;
		}
		.rail {
			flex-direction: row;
			overflow-x: auto;
			border-right: none;
			border-bottom: 1px solid var(--border);
			padding: 0 0 0.3rem;
		}
		.tab {
			border-left: none;
			border-bottom: 2px solid transparent;
		}
		.tab.on {
			border-left-color: transparent;
			border-bottom-color: var(--accent);
		}
	}
</style>
