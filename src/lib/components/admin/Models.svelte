<script lang="ts">
	interface Model {
		id: string;
		providerId: string;
		modelKey: string;
		displayName: string;
		contextWindow: number | null;
		supportsTools: boolean;
		supportsVision: boolean;
		promptCostPerMTok: number | null;
		completionCostPerMTok: number | null;
		cacheMode: 'auto' | 'explicit' | 'none';
		enabled: boolean;
	}

	let models = $state<Model[]>([]);
	let filter = $state('');
	let showDisabled = $state(false);

	let { refreshKey = 0 }: { refreshKey?: number } = $props();

	async function load() {
		models = await (await fetch('/api/admin/models')).json();
	}
	$effect(() => {
		void refreshKey;
		void load();
	});

	const PAGE = 100;
	let limit = $state(PAGE);

	const matching = $derived(
		models
			.filter((m) => showDisabled || m.enabled || filter.length > 1)
			.filter((m) =>
				filter
					? (m.displayName + m.modelKey).toLowerCase().includes(filter.toLowerCase())
					: true
			)
			.sort(
				(a, b) => Number(b.enabled) - Number(a.enabled) || a.displayName.localeCompare(b.displayName)
			)
	);
	const visible = $derived(matching.slice(0, limit));

	// Reset paging whenever the filter/toggle changes the result set.
	$effect(() => {
		void filter;
		void showDisabled;
		limit = PAGE;
	});

	async function toggle(m: Model) {
		await fetch(`/api/admin/models/${m.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: !m.enabled })
		});
		await load();
	}

	async function setCacheMode(m: Model, cacheMode: string) {
		await fetch(`/api/admin/models/${m.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cacheMode })
		});
		await load();
	}

	const fmtCost = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}/M`);
</script>

<section>
	<div class="bar">
		<label>
			<span class="sr-only">filter models</span>
			<input placeholder="Filter models… (type to search all synced models)" bind:value={filter} />
		</label>
		<label class="chk">
			<input type="checkbox" bind:checked={showDisabled} /> show disabled
		</label>
		<span class="count">{models.filter((m) => m.enabled).length} enabled / {models.length} synced</span>
	</div>

	<table>
		<thead>
			<tr>
				<th>On</th><th>Model</th><th>Caps</th><th>Context</th><th>In</th><th>Out</th>
				<th title="How this model wants prompt caching asked for">Cache</th>
			</tr>
		</thead>
		<tbody>
			{#each visible as m (m.id)}
				<tr class:disabled={!m.enabled}>
					<td><input type="checkbox" checked={m.enabled} onchange={() => toggle(m)} /></td>
					<td>
						<div>{m.displayName}</div>
						<div class="key">{m.modelKey}</div>
					</td>
					<td>
						{#if m.supportsTools}<span class="badge" title="tool calling">T</span>{/if}
						{#if m.supportsVision}<span class="badge" title="vision">V</span>{/if}
					</td>
					<td class="num">{m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : '—'}</td>
					<td class="num">{fmtCost(m.promptCostPerMTok)}</td>
					<td class="num">{fmtCost(m.completionCostPerMTok)}</td>
					<td>
						<select
							class="cache"
							value={m.cacheMode}
							onchange={(e) => setCacheMode(m, e.currentTarget.value)}
							title="auto: send nothing, for providers that cache on their own. explicit: mark cache_control breakpoints, which Anthropic and Gemini need. none: never mark anything."
						>
							<option value="auto">auto</option>
							<option value="explicit">explicit</option>
							<option value="none">none</option>
						</select>
					</td>
				</tr>
			{:else}
				<tr><td colspan="7" class="empty">No models — sync a provider first.</td></tr>
			{/each}
		</tbody>
	</table>
	{#if matching.length > limit}
		<div class="more">
			<span>showing {visible.length} of {matching.length}</span>
			<button class="more-btn" onclick={() => (limit += PAGE)}>Show more</button>
			<button class="more-btn" onclick={() => (limit = matching.length)}>Show all</button>
		</div>
	{/if}
</section>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.6rem;
	}
	.bar label {
		flex: 1;
		display: flex;
	}
	.bar input {
		flex: 1;
	}
	input:not([type='checkbox']) {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.35rem 0.5rem;
		min-width: 16rem;
	}
	.chk {
		font-size: var(--text-base);
		color: var(--fg-dim);
	}
	.count {
		font-size: var(--text-base);
		color: var(--fg-dim);
		margin-left: auto;
	}
	.more {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.7rem 0.2rem;
		font-size: var(--text-base);
		color: var(--fg-dim);
	}
	.more-btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.3rem 0.7rem;
		font-family: inherit;
		font-size: var(--text-base);
		cursor: pointer;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-md);
	}
	th,
	td {
		text-align: left;
		padding: 0.4rem 0.6rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		color: var(--fg-dim);
		font-weight: normal;
	}
	tr.disabled td {
		opacity: 0.5;
	}
	.cache {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.15rem 0.25rem;
	}
	.key {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.badge {
		display: inline-block;
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: 3px;
		font-size: var(--text-xs);
		padding: 0 0.25rem;
		margin-right: 0.2rem;
	}
	.empty {
		color: var(--fg-dim);
	}
</style>
