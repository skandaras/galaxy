<script lang="ts">
	interface RubricDimension {
		id: string;
		name: string;
		tradition: string;
		definition: string;
		defaultWeight: number;
	}
	interface Prefs {
		disabled: string[];
		weights: Record<string, number>;
	}

	let enabled = $state(false);
	let platformEnabled = $state(true);
	let synthesisIntervalHours = $state(168);
	let lastSynthesisAt = $state(0);
	let prefs = $state<Prefs>({ disabled: [], weights: {} });
	let dimensions = $state<RubricDimension[]>([]);
	let notice = $state<string | null>(null);
	let confirmingWipe = $state(false);
	let busy = $state(false);

	async function load() {
		const data = await (await fetch('/api/alignment/settings')).json();
		enabled = data.enabled;
		platformEnabled = data.platformEnabled;
		synthesisIntervalHours = data.synthesisIntervalHours;
		lastSynthesisAt = data.lastSynthesisAt;
		prefs = data.rubric;
		// Only readable once the feature is on — it is behind requireAlignment.
		if (enabled) {
			const r = await fetch('/api/alignment/rubric');
			if (r.ok) dimensions = (await r.json()).dimensions;
		}
	}
	$effect(() => {
		void load();
	});

	async function save(body: Record<string, unknown>) {
		const res = await fetch('/api/alignment/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			notice = (await res.text()) || 'Could not save';
			return false;
		}
		return true;
	}

	async function toggleEnabled() {
		const next = !enabled;
		notice = null;
		if (await save({ enabled: next })) {
			enabled = next;
			await load();
			// The nav link is rendered from the layout load, which has already run.
			if (next) notice = 'Alignment is on — reload to see it in the sidebar.';
		}
	}

	async function toggleDimension(id: string) {
		const disabled = prefs.disabled.includes(id)
			? prefs.disabled.filter((d) => d !== id)
			: [...prefs.disabled, id];
		const next = { ...prefs, disabled };
		if (await save({ rubric: next })) prefs = next;
	}

	async function setWeight(id: string, value: number) {
		const next = { ...prefs, weights: { ...prefs.weights, [id]: value } };
		if (await save({ rubric: next })) prefs = next;
	}

	async function wipe() {
		busy = true;
		const res = await fetch('/api/alignment/export', { method: 'DELETE' });
		busy = false;
		confirmingWipe = false;
		notice = res.ok ? 'Everything in Alignment has been deleted.' : 'Could not delete.';
		await load();
	}

	const when = (ts: number) => (ts ? new Date(ts).toLocaleString() : 'never');
	const weightOf = (d: RubricDimension) => prefs.weights[d.id] ?? d.defaultWeight;
</script>

<section class="alignment-section">
	{#if notice}<p class="notice">{notice}</p>{/if}

	<article class="card">
		<h3>Alignment</h3>
		<p class="hint">
			A private place to write down what you actually believe — your values, principles, roles and
			the ways you know you go wrong — and to keep a reflection journal that an agent reads back
			against them. It reports where your conduct and your stated character meet, and where they
			don't.
		</p>
		<p class="hint">
			It is a mirror, not a verdict, and it is not therapy. Nothing is ever scored automatically:
			an entry is only read when you press Assess. Your journal and your constitution are private
			to you — they are never shown to admins, never read by the memory agent, and never added to
			any other agent's context.
		</p>
		{#if !platformEnabled}
			<p class="hint warn">Alignment is switched off for this instance by an admin.</p>
		{/if}
		<div class="row">
			<label class="chk">
				<input
					type="checkbox"
					checked={enabled}
					disabled={!platformEnabled}
					onchange={toggleEnabled}
				/>
				turn Alignment on for me
			</label>
			{#if enabled}
				<span class="meta">
					synthesis letter every {synthesisIntervalHours}h · last {when(lastSynthesisAt)}
				</span>
			{/if}
		</div>
	</article>

	{#if enabled && dimensions.length}
		<article class="card">
			<h3>The rubric</h3>
			<p class="hint">
				What an entry is read against, drawn from moral philosophy and psychology. Switch off
				anything you don't want applied to you, and weight what matters most — a dimension's
				weight decides how much it counts towards the overall reading. The full definitions and
				the 1–5 anchors are on the Rubric tab in Alignment.
			</p>
			{#each dimensions as d (d.id)}
				{@const off = prefs.disabled.includes(d.id)}
				<div class="dim" class:off>
					<label class="chk">
						<input type="checkbox" checked={!off} onchange={() => toggleDimension(d.id)} />
						<span class="dim-name">{d.name}</span>
					</label>
					<span class="dim-tradition">{d.tradition}</span>
					<label class="weight">
						weight
						<input
							type="range"
							min="1"
							max="5"
							disabled={off}
							value={weightOf(d)}
							onchange={(e) => setWeight(d.id, Number(e.currentTarget.value))}
						/>
						<span class="weight-value">{weightOf(d)}</span>
					</label>
				</div>
			{/each}
		</article>

		<article class="card">
			<h3>Your data</h3>
			<p class="hint">
				Everything you have written here, in one file — principles with their full revision
				history, entries, assessments and synthesis letters.
			</p>
			<div class="row">
				<a class="btn" href="/api/alignment/export?format=json" download>Export JSON</a>
				<a class="btn" href="/api/alignment/export?format=markdown" download>Export markdown</a>
				{#if confirmingWipe}
					<button class="btn danger" disabled={busy} onclick={wipe}>
						{busy ? 'Deleting…' : 'Yes — delete all of it'}
					</button>
					<button class="btn" onclick={() => (confirmingWipe = false)}>Cancel</button>
				{:else}
					<button class="btn danger" onclick={() => (confirmingWipe = true)}>Delete everything</button
					>
				{/if}
			</div>
			{#if confirmingWipe}
				<p class="hint warn">
					This erases every principle, revision, journal entry, assessment and letter. It cannot be
					undone — export first if there is any doubt.
				</p>
			{/if}
		</article>
	{/if}
</section>

<style>
	.alignment-section {
		max-width: 46rem;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
		margin-bottom: 0.9rem;
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.hint {
		font-size: var(--text-base);
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0 0 0.7rem;
	}
	.hint.warn {
		color: var(--danger);
	}
	.notice {
		color: var(--accent);
		font-size: var(--text-base);
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
	.dim {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.2rem 0.8rem;
		align-items: center;
		padding: 0.45rem 0;
		border-top: 1px solid var(--border);
	}
	.dim.off {
		opacity: 0.45;
	}
	.dim-name {
		color: var(--fg);
		font-size: var(--text-base);
	}
	.dim-tradition {
		grid-column: 1;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		padding-left: 1.35rem;
	}
	.weight {
		grid-row: 1 / span 2;
		grid-column: 2;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.weight input {
		width: 5rem;
	}
	.weight-value {
		color: var(--accent);
		width: 0.8rem;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.3rem 0.6rem;
		font-family: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
		text-decoration: none;
		display: inline-block;
	}
	.btn.danger {
		background: transparent;
		border: 1px solid var(--danger);
		color: var(--danger);
	}
	.btn:disabled {
		opacity: 0.5;
	}
	@media (max-width: 720px) {
		.dim {
			grid-template-columns: 1fr;
		}
		.weight {
			grid-row: auto;
			grid-column: 1;
			padding-left: 1.35rem;
		}
	}
</style>
