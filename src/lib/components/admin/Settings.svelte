<script lang="ts">
	let websearch = $state({
		provider: 'none',
		apiKey: '',
		baseUrl: '',
		maxResults: 5,
		timeoutMs: 10000
	});
	let compaction = $state({ ratio: 0.7, keepRecent: 8 });
	let saved = $state<string | null>(null);

	async function load() {
		const data = await (await fetch('/api/admin/settings')).json();
		websearch = { apiKey: '', baseUrl: '', ...data.websearch };
		compaction = { ...data.compaction };
	}
	$effect(() => {
		void load();
	});

	async function save(key: 'websearch' | 'compaction', value: unknown) {
		await fetch('/api/admin/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key, value })
		});
		saved = key;
		setTimeout(() => (saved = null), 1500);
	}
</script>

<section>
	<article class="card">
		<h3>Web search</h3>
		<div class="grid">
			<label>
				provider
				<select bind:value={websearch.provider}>
					<option value="none">disabled</option>
					<option value="brave">Brave</option>
					<option value="tavily">Tavily</option>
					<option value="searxng">SearXNG (self-hosted)</option>
				</select>
			</label>
			{#if websearch.provider === 'brave' || websearch.provider === 'tavily'}
				<label>
					API key
					<input type="password" bind:value={websearch.apiKey} placeholder="key" />
				</label>
			{/if}
			{#if websearch.provider === 'searxng'}
				<label>
					instance URL
					<input bind:value={websearch.baseUrl} placeholder="http://searxng:8080" />
				</label>
			{/if}
			<label>
				max results
				<input type="number" min="1" max="20" bind:value={websearch.maxResults} />
			</label>
			<label>
				timeout (ms)
				<input type="number" min="1000" step="1000" bind:value={websearch.timeoutMs} />
			</label>
		</div>
		<button class="btn primary" onclick={() => save('websearch', websearch)}>
			{saved === 'websearch' ? 'Saved ✓' : 'Save'}
		</button>
	</article>

	<article class="card">
		<h3>Conversation compaction</h3>
		<div class="grid">
			<label>
				trigger at share of context window
				<input type="number" min="0.2" max="0.95" step="0.05" bind:value={compaction.ratio} />
			</label>
			<label>
				keep recent messages verbatim
				<input type="number" min="2" max="50" bind:value={compaction.keepRecent} />
			</label>
		</div>
		<button class="btn primary" onclick={() => save('compaction', compaction)}>
			{saved === 'compaction' ? 'Saved ✓' : 'Save'}
		</button>
	</article>
</section>

<style>
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
		margin-bottom: 0.9rem;
	}
	h3 {
		margin: 0 0 0.7rem;
		font-size: 0.8rem;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.grid {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 0.8rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	input,
	select {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.35rem 0.5rem;
		max-width: 14rem;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.35rem 0.7rem;
		font-family: inherit;
		font-size: 0.72rem;
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
</style>
