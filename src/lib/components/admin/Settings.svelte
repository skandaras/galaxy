<script lang="ts">
	let websearch = $state({
		provider: 'none',
		apiKey: '',
		baseUrl: '',
		maxResults: 5,
		timeoutMs: 10000
	});
	let compaction = $state({ ratio: 0.7, keepRecent: 8 });
	let budget = $state({ enabled: false, limitUsd: 25, period: 'month' });
	let github = $state({ token: '', hasToken: false });
	let hasSearchKey = $state(false);
	let research = $state({
		provider: 'inherit',
		baseUrl: '',
		maxQueries: 4,
		maxPages: 6,
		maxTokens: 2048,
		timeoutMs: 20000,
		iterationCap: 1
	});
	let saved = $state<string | null>(null);
	let deployBusy = $state<string | null>(null);
	let deployMsg = $state<string | null>(null);

	async function deploy(action: 'promote' | 'rollback') {
		if (!confirm(action === 'promote' ? 'Promote the current dev build to prod?' : 'Roll prod back to the previous stable image?'))
			return;
		deployBusy = action;
		deployMsg = null;
		const res = await fetch('/api/admin/deploy', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action })
		});
		const data = await res.json().catch(() => ({}));
		deployMsg = res.ok
			? `${action} dispatched — prod updates when the workflow finishes`
			: (data.message ?? `${action} failed`);
		deployBusy = null;
	}

	async function load() {
		const data = await (await fetch('/api/admin/settings')).json();
		websearch = { apiKey: '', baseUrl: '', ...data.websearch };
		hasSearchKey = Boolean(data.websearch?.hasApiKey);
		compaction = { ...data.compaction };
		budget = { ...data.budget };
		github = { token: '', hasToken: Boolean(data.github?.hasToken) };
		research = { baseUrl: '', ...data.research };
	}
	$effect(() => {
		void load();
	});

	async function save(
		key: 'websearch' | 'compaction' | 'budget' | 'github' | 'research',
		value: unknown
	) {
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
					<option value="duckduckgo">DuckDuckGo (no key)</option>
					<option value="brave">Brave</option>
					<option value="tavily">Tavily</option>
					<option value="searxng">SearXNG (self-hosted)</option>
				</select>
			</label>
			{#if websearch.provider === 'brave' || websearch.provider === 'tavily'}
				<label>
					API key
					<input
						type="password"
						bind:value={websearch.apiKey}
						placeholder={hasSearchKey ? '(saved — leave blank to keep)' : 'key'}
					/>
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
		<h3>Deep research</h3>
		<div class="grid">
			<label>
				search engine
				<select bind:value={research.provider}>
					<option value="inherit">same as web search</option>
					<option value="duckduckgo">DuckDuckGo (no key)</option>
					<option value="searxng">dedicated SearXNG</option>
				</select>
			</label>
			{#if research.provider === 'searxng'}
				<label>
					SearXNG URL
					<input bind:value={research.baseUrl} placeholder="http://searxng:8080" />
				</label>
			{/if}
			<label>
				max queries
				<input type="number" min="1" max="10" bind:value={research.maxQueries} />
			</label>
			<label>
				max pages read
				<input type="number" min="1" max="20" bind:value={research.maxPages} />
			</label>
			<label>
				synthesis max tokens
				<input type="number" min="256" step="256" bind:value={research.maxTokens} />
			</label>
			<label>
				page timeout (ms)
				<input type="number" min="2000" step="1000" bind:value={research.timeoutMs} />
			</label>
			<label>
				extra rounds
				<input type="number" min="0" max="3" bind:value={research.iterationCap} />
			</label>
		</div>
		<button class="btn primary" onclick={() => save('research', research)}>
			{saved === 'research' ? 'Saved ✓' : 'Save'}
		</button>
	</article>

	<article class="card">
		<h3>GitHub</h3>
		<div class="grid">
			<label>
				personal access token
				<input
					type="password"
					bind:value={github.token}
					placeholder={github.hasToken ? '(saved — leave blank to keep)' : 'fine-grained PAT'}
				/>
			</label>
		</div>
		<p class="hint">
			Used by the coding agent to list repositories, clone and push. A fine-grained token with
			Contents read/write on the repos you work in is enough.
		</p>
		<button class="btn primary" onclick={() => save('github', { token: github.token })}>
			{saved === 'github' ? 'Saved ✓' : 'Save'}
		</button>
	</article>

	<article class="card">
		<h3>Deployment</h3>
		<p class="hint">
			Promote retags the current <code>:dev</code> image as <code>:stable</code> (keeping the
			previous stable as <code>:stable-prev</code>) via the Promote workflow; prod follows
			<code>:stable</code>. Rollback restores <code>:stable-prev</code>. Requires the GitHub
			token below with workflow scope.
		</p>
		<div class="row-buttons">
			<button class="btn primary" disabled={deployBusy !== null} onclick={() => deploy('promote')}>
				{deployBusy === 'promote' ? 'Dispatching…' : '🚀 Promote dev → prod'}
			</button>
			<button class="btn danger" disabled={deployBusy !== null} onclick={() => deploy('rollback')}>
				{deployBusy === 'rollback' ? 'Dispatching…' : 'Rollback'}
			</button>
			{#if deployMsg}<span class="deploy-msg">{deployMsg}</span>{/if}
		</div>
	</article>

	<article class="card">
		<h3>Budget cap</h3>
		<div class="grid">
			<label class="row">
				<input type="checkbox" bind:checked={budget.enabled} /> enforce a spending cap
			</label>
			<label>
				limit (USD)
				<input type="number" min="0" step="1" bind:value={budget.limitUsd} />
			</label>
			<label>
				per
				<select bind:value={budget.period}>
					<option value="day">day</option>
					<option value="week">week (Mon–Sun)</option>
					<option value="month">calendar month</option>
				</select>
			</label>
		</div>
		<p class="hint">
			When the estimated spend for the current period reaches the limit, all new model calls are
			refused until the period rolls over (or the cap is raised here).
		</p>
		<button class="btn primary" onclick={() => save('budget', budget)}>
			{saved === 'budget' ? 'Saved ✓' : 'Save'}
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
	label.row {
		flex-direction: row;
		align-items: center;
	}
	.hint {
		font-size: 0.68rem;
		color: var(--fg-dim);
		margin: 0 0 0.7rem;
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
	.btn.danger {
		background: transparent;
		border: 1px solid var(--danger);
		color: var(--danger);
	}
	.btn:disabled {
		opacity: 0.5;
	}
	.row-buttons {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.deploy-msg {
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	code {
		color: var(--accent);
	}
</style>
