<script lang="ts">
	let websearch = $state({
		provider: 'none',
		fallbackProvider: 'none',
		apiKey: '',
		baseUrl: '',
		maxResults: 5,
		timeoutMs: 10000,
		maxSearchesPerTurn: 4
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
	let coding = $state({ autoCheckpoint: true, autoContinue: true, maxLegs: 3 });
	let retention = $state({ eventDays: 60, usageDays: 400, uxIdeaDays: 14 });
	let fetchCfg = $state({ timeoutMs: 15000, maxChars: 20000, maxFetchesPerTurn: 5 });
	let saved = $state<string | null>(null);
	let deployBusy = $state<string | null>(null);
	let deployMsg = $state<string | null>(null);

	interface TestResult {
		ok: boolean;
		provider?: string;
		results?: number;
		reason?: string;
		status?: number;
		bytes?: number;
		durationMs?: number;
		warning?: string | null;
		failedOver?: { from: string; reason: string } | null;
		sample?: { title: string; url: string }[];
	}
	let testing = $state(false);
	let testResult = $state<TestResult | null>(null);

	async function testSearch() {
		testing = true;
		testResult = null;
		// Test the saved settings, so save first if the form is dirty.
		await save('websearch', websearch);
		const res = await fetch('/api/admin/settings/test-search', { method: 'POST' });
		testResult = await res.json().catch(() => ({ ok: false, reason: 'no response' }));
		testing = false;
	}

	function formatTest(t: TestResult): string {
		const lines: string[] = [];
		if (t.ok) {
			lines.push(`✓ ${t.provider} returned ${t.results} result(s) in ${t.durationMs}ms`);
			if (t.failedOver) {
				lines.push(`  ! fell back from ${t.failedOver.from}: ${t.failedOver.reason}`);
			}
			if (t.warning) lines.push(`  ! ${t.warning}`);
			for (const s of t.sample ?? []) lines.push(`  · ${s.title} — ${s.url}`);
		} else {
			lines.push(`✗ ${t.provider ?? 'search'} failed`);
			if (t.reason) lines.push(`  reason: ${t.reason}`);
			if (t.status !== undefined) lines.push(`  http status: ${t.status}`);
			if (t.bytes !== undefined) lines.push(`  response bytes: ${t.bytes}`);
		}
		return lines.join('\n');
	}

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
		websearch = { apiKey: '', baseUrl: '', fallbackProvider: 'none', ...data.websearch };
		hasSearchKey = Boolean(data.websearch?.hasApiKey);
		compaction = { ...data.compaction };
		budget = { ...data.budget };
		github = { token: '', hasToken: Boolean(data.github?.hasToken) };
		research = { baseUrl: '', ...data.research };
		coding = { ...data.coding };
		retention = { ...data.retention };
		fetchCfg = { ...data.fetch };
		await loadPush();
	}

	let push = $state({ configured: false, publicKey: '', subject: '', devices: 0 });
	let pushNotice = $state<string | null>(null);

	async function loadPush() {
		const data = await (await fetch('/api/admin/push')).json();
		push = { ...push, ...data, publicKey: data.publicKey ?? '' };
	}

	async function generateKeys() {
		// Regenerating orphans every registration, so make the person say so.
		if (
			push.configured &&
			!confirm(
				`Generating new keys signs out all ${push.devices} registered device(s) — everyone has to enable notifications again. Continue?`
			)
		) {
			return;
		}
		const res = await fetch('/api/admin/push', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'generate', subject: push.subject })
		});
		const data = await res.json();
		pushNotice = `New keys generated${data.clearedDevices ? `, ${data.clearedDevices} device(s) cleared` : ''}.`;
		await loadPush();
	}

	async function savePushSubject() {
		await fetch('/api/admin/push', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ subject: push.subject })
		});
		pushNotice = 'Contact saved.';
		await loadPush();
	}
	$effect(() => {
		void load();
	});

	async function save(
		key:
			| 'websearch'
			| 'compaction'
			| 'budget'
			| 'github'
			| 'research'
			| 'coding'
			| 'retention'
			| 'fetch',
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
				fallback
				<select bind:value={websearch.fallbackProvider}>
					<option value="none">none</option>
					<option value="duckduckgo">DuckDuckGo (no key)</option>
					<option value="brave">Brave</option>
					<option value="tavily">Tavily</option>
					<option value="searxng">SearXNG (self-hosted)</option>
				</select>
			</label>
			<label>
				max results
				<input type="number" min="1" max="20" bind:value={websearch.maxResults} />
			</label>
			<label>
				timeout (ms)
				<input type="number" min="1000" step="1000" bind:value={websearch.timeoutMs} />
			</label>
			<label>
				searches per turn
				<input type="number" min="1" max="20" bind:value={websearch.maxSearchesPerTurn} />
			</label>
		</div>
		<p class="hint">
			<strong>Searches per turn</strong> caps how many live searches one reply may make. Repeats of
			a query already run in the same turn are answered from memory and don't count against it.
		</p>
		<p class="hint">
			The fallback is used only when the primary <em>fails</em> — blocked, unreachable or
			unparseable — never when it legitimately finds nothing. SearXNG is the most reliable
			choice when self-hosted: no key, no quota, and unlike DuckDuckGo it won't block your
			server for being in a datacenter.
		</p>
		<div class="row-buttons">
			<button class="btn primary" onclick={() => save('websearch', websearch)}>
				{saved === 'websearch' ? 'Saved ✓' : 'Save'}
			</button>
			<button class="btn" disabled={testing} onclick={testSearch}>
				{testing ? 'Testing…' : 'Test search'}
			</button>
		</div>
		{#if testResult}
			<pre class="test-result" class:bad={!testResult.ok}>{formatTest(testResult)}</pre>
		{/if}
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
		<h3>Coding agent</h3>
		<div class="grid">
			<label class="row">
				<input type="checkbox" bind:checked={coding.autoCheckpoint} />
				commit unfinished work at the end of a turn
			</label>
			<label class="row">
				<input type="checkbox" bind:checked={coding.autoContinue} />
				carry on automatically when a turn runs out of steps
			</label>
			<label>
				max legs per request
				<input type="number" min="1" max="10" bind:value={coding.maxLegs} />
			</label>
		</div>
		<p class="hint">
			A checkpoint commit is local only — nothing is pushed. Steps per leg are set with
			<code>CODING_MAX_STEPS</code>.
		</p>
		<button class="btn primary" onclick={() => save('coding', coding)}>
			{saved === 'coding' ? 'Saved ✓' : 'Save'}
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

	<article class="card">
		<h3>Reading links</h3>
		<div class="grid">
			<label>
				timeout (ms)
				<input type="number" min="1000" step="1000" bind:value={fetchCfg.timeoutMs} />
			</label>
			<label>
				characters per page
				<input type="number" min="1000" step="1000" bind:value={fetchCfg.maxChars} />
			</label>
			<label>
				pages per turn
				<input type="number" min="1" max="20" bind:value={fetchCfg.maxFetchesPerTurn} />
			</label>
		</div>
		<p class="hint">
			Governs the <code>fetch_url</code> tool, which both the chat and coding agents use to read an
			address you give them instead of searching for it. It is deliberately independent of the
			composer's web-search toggle — turning search off shouldn't make the agent guess at a link
			you handed it. To remove the capability entirely, disable <code>fetch_url</code> in
			<strong>Tools</strong>. Re-reading an address already read in the same turn is free and
			doesn't count against the per-turn limit.
		</p>
		<button class="btn primary" onclick={() => save('fetch', fetchCfg)}>
			{saved === 'fetch' ? 'Saved ✓' : 'Save'}
		</button>
	</article>

	<article class="card">
		<h3>History retention</h3>
		<div class="grid">
			<label>
				keep Observatory events (days)
				<input type="number" min="0" max="3650" bind:value={retention.eventDays} />
			</label>
			<label>
				keep usage history (days)
				<input type="number" min="0" max="3650" bind:value={retention.usageDays} />
			</label>
			<label>
				keep UX ideas on dev (days)
				<input type="number" min="0" max="3650" bind:value={retention.uxIdeaDays} />
			</label>
		</div>
		<p class="hint">
			Older rows are trimmed by the background scheduler; 0 keeps everything. Events are the
			fastest-growing table — one row per model call, tool call and job. Keep usage history at
			least as long as the longest window you look at in Usage (up to 365 days), since the budget
			cap and those charts read the same rows. The UX window applies to
			<strong>non-production instances only</strong> — on prod the backlog's decision history is
			kept permanently, because it is what stops the audit re-proposing what you already dismissed.
		</p>
		<button class="btn primary" onclick={() => save('retention', retention)}>
			{saved === 'retention' ? 'Saved ✓' : 'Save'}
		</button>
	</article>

	<article class="card">
		<h3>Push</h3>
		{#if pushNotice}<p class="notice">{pushNotice}</p>{/if}
		<p class="hint">
			Web Push needs one VAPID key pair for the whole instance. Generate it once here; each person
			then turns notifications on per device in <strong>Settings → Notifications</strong>. The
			private half is stored encrypted and never leaves the server. Only notifications that hold
			work up are pushed — currently an agent waiting on an answer.
		</p>
		<div class="grid">
			<label>
				contact (VAPID subject)
				<input
					type="text"
					placeholder="mailto:you@example.com"
					bind:value={push.subject}
					onblur={savePushSubject}
				/>
			</label>
			<label>
				status
				<input
					type="text"
					readonly
					value={push.configured
						? `configured · ${push.devices} device(s)`
						: 'not set up'}
				/>
			</label>
		</div>
		<button class="btn primary" onclick={generateKeys}>
			{push.configured ? 'Regenerate keys' : 'Generate keys'}
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
	.test-result {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg-dim);
		font-size: 0.7rem;
		line-height: 1.5;
		padding: 0.6rem;
		margin: 0.6rem 0 0;
		white-space: pre-wrap;
		overflow-x: auto;
	}
	.test-result.bad {
		border-color: var(--danger);
		color: var(--danger);
	}
	code {
		color: var(--accent);
	}
</style>
