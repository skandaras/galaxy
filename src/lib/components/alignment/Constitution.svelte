<script lang="ts">
	import { autoresize } from '$lib/autoresize';
	import {
		EXEMPLAR_HINTS,
		EXEMPLAR_LABELS,
		KIND_BLURBS,
		KIND_HEADINGS,
		KIND_ORDER,
		PRINCIPLE_KINDS,
		type Principle,
		type PrincipleKind,
		type PrincipleRevision,
		type PrincipleStats
	} from '$lib/alignment-types';

	interface Tension {
		id: string;
		aId: string;
		bId: string;
		note: string;
	}

	let { onChanged = () => {} }: { onChanged?: () => void } = $props();

	let principles = $state<Principle[]>([]);
	let tensions = $state<Tension[]>([]);
	let versions = $state<{ id: string; createdAt: number }[]>([]);
	let openId = $state<string | null>(null);
	let creatingKind = $state<PrincipleKind | null>(null);
	let notice = $state<string | null>(null);
	let showRetired = $state(false);

	/** The edit buffer, so nothing is written until Save. */
	let form = $state<Record<string, unknown>>({});
	let note = $state('');
	let stats = $state<PrincipleStats | null>(null);
	let revisions = $state<PrincipleRevision[]>([]);
	let saving = $state(false);

	/** New-tension picker. */
	let tensionA = $state('');
	let tensionB = $state('');
	let tensionNote = $state('');

	/** Re-assessment after an edit. */
	let reassessCandidates = $state<{ id: string; title: string; createdAt: number }[]>([]);
	let reassessMax = $state(10);
	let reassessing = $state(false);
	let comparison = $state<
		| null
		| {
				entryId: string;
				title: string;
				before: { band: string; standing: string } | null;
				after: { band: string; standing: string } | null;
				reason?: string;
		  }[]
	>(null);

	async function load() {
		const res = await fetch('/api/alignment/principles');
		if (res.ok) {
			const data = await res.json();
			principles = data.principles;
			tensions = data.tensions;
		}
		const v = await fetch('/api/alignment/constitution/versions');
		if (v.ok) versions = (await v.json()).versions;
	}
	$effect(() => {
		void load();
	});

	async function open(p: Principle) {
		openId = p.id;
		creatingKind = null;
		form = { ...p };
		note = '';
		comparison = null;
		stats = null;
		revisions = [];
		// The track record comes first, and it is the point of opening the editor
		// this way: rewording a principle you have been failing for months is a
		// different act from rewording one that has never come up.
		const [s, r] = await Promise.all([
			fetch(`/api/alignment/principles/${p.id}/stats`),
			fetch(`/api/alignment/principles/${p.id}/revisions`)
		]);
		if (s.ok) stats = await s.json();
		if (r.ok) revisions = (await r.json()).revisions;
	}

	function startNew(kind: PrincipleKind) {
		openId = null;
		creatingKind = kind;
		stats = null;
		revisions = [];
		comparison = null;
		note = '';
		form = {
			kind,
			title: '',
			statement: '',
			body: '',
			exemplar: '',
			counterExemplar: '',
			origin: '',
			weight: 3,
			conviction: 3,
			status: 'active'
		};
	}

	function close() {
		openId = null;
		creatingKind = null;
		form = {};
		comparison = null;
	}

	/** Which fields this save would change — shown before it is committed. */
	const pending = $derived.by(() => {
		if (!openId) return [];
		const original = principles.find((p) => p.id === openId);
		if (!original) return [];
		return Object.keys(form).filter(
			(k) =>
				k in original &&
				k !== 'updatedAt' &&
				form[k] !== (original as unknown as Record<string, unknown>)[k]
		);
	});

	async function save() {
		saving = true;
		notice = null;
		const res = openId
			? await fetch(`/api/alignment/principles/${openId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ...form, note })
				})
			: await fetch('/api/alignment/principles', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ...form, note })
				});
		saving = false;
		if (!res.ok) {
			notice = (await res.text()) || 'Could not save that.';
			return;
		}
		const wasEdit = !!openId;
		await load();
		onChanged();
		if (wasEdit && pendingChangedTheMeasure()) {
			await loadReassessCandidates();
		}
		close();
	}

	/** Only an edit the agent can see is worth offering to re-run. */
	function pendingChangedTheMeasure() {
		const visible = ['title', 'statement', 'exemplar', 'counterExemplar', 'weight', 'conviction', 'kind', 'status'];
		return pending.some((f) => visible.includes(f));
	}

	async function loadReassessCandidates() {
		const res = await fetch('/api/alignment/reassess');
		if (!res.ok) return;
		const data = await res.json();
		reassessCandidates = data.candidates;
		reassessMax = data.max;
	}

	async function runReassess() {
		reassessing = true;
		const res = await fetch('/api/alignment/reassess', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ entryIds: reassessCandidates.map((c) => c.id) })
		});
		reassessing = false;
		if (!res.ok) {
			notice = 'Could not re-read those entries.';
			return;
		}
		const data = await res.json();
		comparison = data.results.map(
			(r: { entryId: string; before: Principle | null; after: Principle | null; reason?: string }) => ({
				entryId: r.entryId,
				title: reassessCandidates.find((c) => c.id === r.entryId)?.title || 'Untitled',
				before: r.before,
				after: r.after,
				reason: r.reason
			})
		);
		reassessCandidates = [];
		onChanged();
	}

	async function retire(p: Principle) {
		await fetch(`/api/alignment/principles/${p.id}`, { method: 'DELETE' });
		await load();
		onChanged();
		close();
	}

	async function restore(p: Principle) {
		await fetch(`/api/alignment/principles/${p.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'active', note: 'Brought back' })
		});
		await load();
		onChanged();
	}

	async function hardDelete(p: Principle) {
		await fetch(`/api/alignment/principles/${p.id}?hard=1`, { method: 'DELETE' });
		await load();
		onChanged();
		close();
	}

	async function addTension() {
		if (!tensionA || !tensionB) return;
		const res = await fetch('/api/alignment/tensions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ aId: tensionA, bId: tensionB, note: tensionNote })
		});
		if (!res.ok) {
			notice = (await res.text()) || 'Could not save that tension.';
			return;
		}
		tensionA = '';
		tensionB = '';
		tensionNote = '';
		await load();
	}

	async function removeTension(t: Tension) {
		await fetch(`/api/alignment/tensions/${t.id}`, { method: 'DELETE' });
		await load();
	}

	const live = $derived(principles.filter((p) => p.status !== 'retired'));
	const retired = $derived(principles.filter((p) => p.status === 'retired'));
	const byKind = (kind: PrincipleKind) => live.filter((p) => p.kind === kind);
	const titleOf = (id: string) => principles.find((p) => p.id === id)?.title ?? '(removed)';
	const labels = $derived(
		EXEMPLAR_LABELS[(form.kind as PrincipleKind) ?? 'value'] ?? EXEMPLAR_LABELS.value
	);
	const hints = $derived(
		EXEMPLAR_HINTS[(form.kind as PrincipleKind) ?? 'value'] ?? EXEMPLAR_HINTS.value
	);
	const when = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : 'never');
	const editing = $derived(!!openId || !!creatingKind);
</script>

<section class="constitution">
	{#if notice}<p class="notice">{notice}</p>{/if}

	{#if !editing}
		<p class="hint intro">
			What you actually hold, in your own words. Every reading of a journal entry is made against
			this and nothing else — the agent has no standing to bring its own morality, so what is
			written here is the whole of what you are measured by.
		</p>

		{#each KIND_ORDER as kind (kind)}
			{@const items = byKind(kind)}
			<article class="card">
				<div class="kind-head">
					<h3>{KIND_HEADINGS[kind]}</h3>
					<button class="btn" onclick={() => startNew(kind)}>Add</button>
				</div>
				<p class="hint">{KIND_BLURBS[kind]}</p>
				{#each items as p (p.id)}
					<button class="row-item" onclick={() => open(p)}>
						<span class="row-title">
							{p.title}
							{#if p.status === 'provisional'}<span class="tag">trying it on</span>{/if}
						</span>
						<span class="row-statement">{p.statement}</span>
						<span class="row-meta">weight {p.weight} · conviction {p.conviction}</span>
					</button>
				{:else}
					<p class="hint empty">Nothing here yet.</p>
				{/each}
			</article>
		{/each}

		<article class="card">
			<h3>Declared tensions</h3>
			<p class="hint">
				Two of your own principles that pull against each other. Naming one changes how it is
				read: a conflict you have already thought about is judged on how you resolved it, rather
				than reported as a failure every time it comes up.
			</p>
			{#each tensions as t (t.id)}
				<div class="tension">
					<span class="pair">{titleOf(t.aId)} vs {titleOf(t.bId)}</span>
					{#if t.note}<span class="tension-note">{t.note}</span>{/if}
					<button class="btn danger" onclick={() => removeTension(t)}>Remove</button>
				</div>
			{/each}
			<div class="row new-tension">
				<select bind:value={tensionA}>
					<option value="">choose one…</option>
					{#each live as p (p.id)}<option value={p.id}>{p.title}</option>{/each}
				</select>
				<span class="vs">vs</span>
				<select bind:value={tensionB}>
					<option value="">and another…</option>
					{#each live as p (p.id)}<option value={p.id}>{p.title}</option>{/each}
				</select>
				<input bind:value={tensionNote} placeholder="how you mean to resolve it" />
				<button class="btn" disabled={!tensionA || !tensionB} onclick={addTension}>Declare</button>
			</div>
		</article>

		{#if versions.length}
			<article class="card">
				<h3>How this has changed</h3>
				<p class="hint">
					Each time you changed something the agent reads, a version was cut. Readings written
					before a version are still anchored to the words that were live then — nothing is ever
					re-judged behind your back.
				</p>
				<div class="versions">
					{#each versions as v (v.id)}
						<span class="version">{when(v.createdAt)}</span>
					{/each}
				</div>
			</article>
		{/if}

		{#if retired.length}
			<article class="card">
				<button class="link" onclick={() => (showRetired = !showRetired)}>
					{showRetired ? 'Hide' : 'Show'} what you used to believe ({retired.length})
				</button>
				{#if showRetired}
					<p class="hint">
						Retired, not deleted. Kept because how your stated character changed is as much the
						record as what it is now.
					</p>
					{#each retired as p (p.id)}
						<div class="row-item retired">
							<span class="row-title">{p.title}</span>
							<span class="row-statement">{p.statement}</span>
							<div class="row">
								<button class="btn" onclick={() => restore(p)}>Bring it back</button>
								<button class="btn" onclick={() => open(p)}>Read its history</button>
							</div>
						</div>
					{/each}
				{/if}
			</article>
		{/if}
	{:else}
		<article class="card editor">
			<div class="kind-head">
				<h3>{openId ? 'Edit' : `New ${(form.kind as string) ?? 'value'}`}</h3>
				<button class="btn" onclick={close}>Back</button>
			</div>

			{#if stats}
				<!-- Before anything is changed: how much this has actually been in
				     play. The honest question is whether the principle is wrong or
				     whether you are, and you cannot ask it without this. -->
				<div class="track-record">
					<h4>Its track record</h4>
					{#if stats.ofAssessments === 0}
						<p class="hint">Nothing has been read against it yet.</p>
					{:else}
						<p class="record-line">
							Cited in <strong>{stats.cited}</strong> of your last {stats.ofAssessments} readings
							{#if stats.meanScore !== null}
								· averaging <strong>{stats.meanScore.toFixed(1)}</strong>
							{/if}
							{#if stats.direction !== 'unknown'}
								· <span class={stats.direction}>{stats.direction}</span>
							{/if}
						</p>
						<p class="hint">Last came up {when(stats.lastCitedAt)}.</p>
						{#if stats.lostTo.length}
							<p class="hint">
								Usually loses to {stats.lostTo.map((l) => titleOf(l.principleId)).join(', ')}.
							</p>
						{/if}
						{#if stats.wonOver.length}
							<p class="hint">
								Usually wins over {stats.wonOver.map((l) => titleOf(l.principleId)).join(', ')}.
							</p>
						{/if}
					{/if}
				</div>
			{/if}

			<label>
				<span class="label">Kind</span>
				<select bind:value={form.kind}>
					{#each PRINCIPLE_KINDS as k (k)}<option value={k}>{k}</option>{/each}
				</select>
			</label>

			<label>
				<span class="label">Title</span>
				<span class="field-hint">
					Short. This is the name you will read in every assessment that cites it.
				</span>
				<input bind:value={form.title} placeholder="Honesty" />
			</label>

			<label>
				<span class="label">Statement</span>
				<span class="field-hint">
					One line, in your own words. This is the sentence actually judged against.
				</span>
				<input
					bind:value={form.statement}
					placeholder="I say the uncomfortable thing kindly rather than the comfortable thing smoothly."
				/>
			</label>

			<label>
				<span class="label">{labels.exemplar}</span>
				<span class="field-hint">{hints.exemplar}</span>
				<textarea bind:value={form.exemplar} use:autoresize={String(form.exemplar ?? '')} rows="3"
				></textarea>
			</label>

			<label>
				<span class="label">{labels.counter}</span>
				<span class="field-hint">{hints.counter}</span>
				<textarea
					bind:value={form.counterExemplar}
					use:autoresize={String(form.counterExemplar ?? '')}
					rows="3"
				></textarea>
			</label>

			<label>
				<span class="label">Anything else</span>
				<span class="field-hint">Nuance, an anecdote, what it does not mean. Context only.</span>
				<textarea bind:value={form.body} use:autoresize={String(form.body ?? '')} rows="3"
				></textarea>
			</label>

			<div class="sliders">
				<label>
					<span class="label">Weight — {form.weight}</span>
					<span class="field-hint">Who wins when this collides with another of yours.</span>
					<input type="range" min="1" max="5" bind:value={form.weight} />
				</label>
				<label>
					<span class="label">Conviction — {form.conviction}</span>
					<span class="field-hint">
						How settled you are. Low means it is engaged as an open question rather than held to
						as a commitment.
					</span>
					<input type="range" min="1" max="5" bind:value={form.conviction} />
				</label>
			</div>

			<label>
				<span class="label">Where it came from</span>
				<input bind:value={form.origin} placeholder="a book, a person, something that happened" />
			</label>

			<label>
				<span class="label">Status</span>
				<select bind:value={form.status}>
					<option value="active">active</option>
					<option value="provisional">provisional — trying it on</option>
					<option value="retired">retired</option>
				</select>
			</label>

			{#if openId && pending.length}
				<div class="diff">
					<h4>This save changes</h4>
					<p class="hint">{pending.join(', ')}</p>
					<label>
						<span class="label">Why?</span>
						<span class="field-hint">
							Optional, and the most interesting thing here in a year's time.
						</span>
						<input bind:value={note} placeholder="it was too vague to be any use" />
					</label>
				</div>
			{/if}

			<div class="row actions">
				<button class="btn primary" disabled={saving || !String(form.title ?? '').trim()} onclick={save}>
					{saving ? 'Saving…' : 'Save'}
				</button>
				{#if openId}
					{@const current = principles.find((p) => p.id === openId)}
					{#if current && current.status !== 'retired'}
						<button class="btn" onclick={() => retire(current)}>Retire it</button>
					{/if}
					<button
						class="btn danger"
						title="Erases it and its history. Retiring is almost always what you want."
						onclick={() => current && hardDelete(current)}>Delete outright</button
					>
				{/if}
			</div>

			{#if revisions.length}
				<div class="history">
					<h4>History</h4>
					{#each revisions as r (r.id)}
						<div class="revision">
							<span class="rev-when">{when(r.createdAt)}</span>
							<span class="rev-fields">{(r.changedFields ?? []).join(', ')}</span>
							{#if r.note}<span class="rev-note">{r.note}</span>{/if}
							{#if r.snapshot?.statement}
								<span class="rev-statement">{r.snapshot.statement}</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</article>
	{/if}

	{#if reassessCandidates.length}
		<article class="card reassess">
			<h3>You changed the measure</h3>
			<p class="hint">
				Past readings stay anchored to the words that were live when they were written — they are
				not recomputed. If you want to see what difference the change makes, the last
				{reassessCandidates.length} of your assessed entries can be read again against the
				constitution as it now stands, and shown side by side. That is {reassessCandidates.length}
				model calls, capped at {reassessMax}.
			</p>
			<div class="row">
				<button class="btn primary" disabled={reassessing} onclick={runReassess}>
					{reassessing ? 'Re-reading…' : 'Read them again'}
				</button>
				<button class="btn" onclick={() => (reassessCandidates = [])}>Not now</button>
			</div>
		</article>
	{/if}

	{#if comparison}
		<article class="card">
			<h3>Before and after</h3>
			<p class="hint">
				The same entries, read against the old wording and the new. Both readings are kept.
			</p>
			{#each comparison as c (c.entryId)}
				<div class="compare">
					<span class="compare-title">{c.title}</span>
					{#if c.reason}
						<span class="hint">{c.reason}</span>
					{:else}
						<div class="compare-cols">
							<div>
								<span class="compare-label">before</span>
								<span class="compare-band">{c.before?.band ?? '—'}</span>
								<p class="compare-standing">{c.before?.standing ?? ''}</p>
							</div>
							<div>
								<span class="compare-label">after</span>
								<span class="compare-band">{c.after?.band ?? '—'}</span>
								<p class="compare-standing">{c.after?.standing ?? ''}</p>
							</div>
						</div>
					{/if}
				</div>
			{/each}
			<button class="btn" onclick={() => (comparison = null)}>Done</button>
		</article>
	{/if}
</section>

<style>
	.constitution {
		max-width: 46rem;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
		margin-bottom: 0.9rem;
	}
	.kind-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.6rem;
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: 0.78rem;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	h4 {
		margin: 0 0 0.4rem;
		font-size: 0.68rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.hint,
	.field-hint {
		font-size: 0.72rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0 0 0.7rem;
	}
	.field-hint {
		display: block;
		margin: 0.1rem 0 0.25rem;
		font-size: 0.67rem;
	}
	.intro {
		max-width: 40rem;
	}
	.empty {
		margin: 0;
	}
	.notice {
		color: var(--accent);
		font-size: 0.75rem;
	}
	.row-item {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
		font-family: inherit;
		cursor: pointer;
	}
	.row-item.retired {
		opacity: 0.6;
		cursor: default;
	}
	.row-title {
		color: var(--fg);
		font-size: 0.8rem;
	}
	.row-statement {
		color: var(--fg-dim);
		font-size: 0.73rem;
		line-height: 1.5;
	}
	.row-meta {
		color: var(--fg-dim);
		font-size: 0.65rem;
	}
	.tag {
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--accent);
		margin-left: 0.4rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.actions {
		margin-top: 0.9rem;
	}
	label {
		display: block;
		margin-bottom: 0.7rem;
	}
	.label {
		font-size: 0.7rem;
		color: var(--fg);
	}
	input,
	textarea,
	select {
		width: 100%;
		box-sizing: border-box;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 0.4rem 0.5rem;
		font-family: inherit;
		font-size: 0.78rem;
	}
	textarea {
		line-height: 1.6;
		resize: vertical;
		max-height: 40vh;
	}
	input[type='range'] {
		padding: 0;
	}
	.sliders {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.9rem;
	}
	.track-record {
		border: 1px solid var(--border);
		border-left: 2px solid var(--accent);
		border-radius: 5px;
		padding: 0.6rem 0.7rem;
		margin-bottom: 0.9rem;
	}
	.record-line {
		font-size: 0.76rem;
		margin: 0 0 0.3rem;
	}
	.record-line .rising {
		color: var(--accent);
	}
	.record-line .falling {
		color: var(--danger);
	}
	.diff {
		border-top: 1px solid var(--border);
		padding-top: 0.7rem;
		margin-top: 0.3rem;
	}
	.history {
		border-top: 1px solid var(--border);
		margin-top: 0.9rem;
		padding-top: 0.7rem;
	}
	.revision {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.4rem 0;
		border-top: 1px solid var(--border);
		font-size: 0.7rem;
	}
	.rev-when {
		color: var(--fg-dim);
		font-size: 0.65rem;
	}
	.rev-fields {
		color: var(--accent);
		font-size: 0.66rem;
	}
	.rev-note {
		color: var(--fg);
	}
	.rev-statement {
		color: var(--fg-dim);
		font-style: italic;
	}
	.tension {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		border-top: 1px solid var(--border);
		padding: 0.4rem 0;
		font-size: 0.75rem;
	}
	.pair {
		color: var(--fg);
	}
	.tension-note {
		flex: 1;
		color: var(--fg-dim);
		font-size: 0.7rem;
	}
	.new-tension {
		margin-top: 0.6rem;
	}
	.new-tension select {
		width: auto;
		flex: 1;
		min-width: 8rem;
	}
	.new-tension input {
		flex: 2;
		min-width: 10rem;
	}
	.vs {
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	.versions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.version {
		font-size: 0.66rem;
		padding: 0.12rem 0.45rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--fg-dim);
	}
	.reassess {
		border-color: var(--accent);
	}
	.compare {
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
	}
	.compare-title {
		font-size: 0.76rem;
		color: var(--fg);
	}
	.compare-cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.8rem;
		margin-top: 0.3rem;
	}
	.compare-label {
		display: block;
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--fg-dim);
	}
	.compare-band {
		font-size: 0.7rem;
		color: var(--accent);
	}
	.compare-standing {
		font-size: 0.72rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0.2rem 0 0;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.3rem 0.6rem;
		font-family: inherit;
		font-size: 0.7rem;
		cursor: pointer;
		white-space: nowrap;
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
	.link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 0.75rem;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
	}
	@media (max-width: 720px) {
		.sliders,
		.compare-cols {
			grid-template-columns: 1fr;
		}
	}
</style>
