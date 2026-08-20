<script lang="ts">
	import { autoresize } from '$lib/autoresize';
	import AssessmentCard from './AssessmentCard.svelte';

	interface Assessment {
		id: string;
		band: 'aligned' | 'mixed' | 'diverging' | 'insufficient';
		standing: string;
		summary: string;
		confidence: 'low' | 'medium' | 'high';
		scores: null | { dimensionId: string; score: number; evidence: string; principles: string[]; note: string }[];
		tensions: null | { between: string[]; chose: string; note: string; declared: boolean }[];
		gaps: null | { principle: string; observation: string; evidence: string }[];
		disengagement: string[] | null;
		rumination: boolean;
		care: boolean;
		nextStep: string;
		question: string;
		createdAt: number;
	}
	interface Entry {
		id: string;
		title: string;
		body: string;
		mood: number | null;
		tags: string;
		skipAssessment: boolean;
		createdAt: number;
		updatedAt: number;
		assessment: Assessment | null;
		stale: boolean;
	}

	let {
		principleTitles = {} as Record<string, string>,
		dimensionNames = {} as Record<string, string>,
		mechanismNames = {} as Record<string, string>,
		hasConstitution = false,
		onChanged = () => {}
	}: {
		principleTitles?: Record<string, string>;
		dimensionNames?: Record<string, string>;
		mechanismNames?: Record<string, string>;
		hasConstitution?: boolean;
		onChanged?: () => void;
	} = $props();

	let entries = $state<Entry[]>([]);
	let draft = $state('');
	let draftTitle = $state('');
	let draftTags = $state('');
	let draftMood = $state<number | null>(null);
	let draftSkip = $state(false);
	let saving = $state(false);
	let assessing = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let openId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let editBody = $state('');

	async function load() {
		const res = await fetch('/api/alignment/entries');
		if (res.ok) entries = (await res.json()).entries;
	}
	$effect(() => {
		void load();
	});

	async function save() {
		if (!draft.trim()) return;
		saving = true;
		notice = null;
		const res = await fetch('/api/alignment/entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				title: draftTitle,
				body: draft,
				tags: draftTags,
				mood: draftMood,
				skipAssessment: draftSkip
			})
		});
		saving = false;
		if (!res.ok) {
			notice = 'Could not save that.';
			return;
		}
		const { entry } = await res.json();
		draft = '';
		draftTitle = '';
		draftTags = '';
		draftMood = null;
		draftSkip = false;
		await load();
		openId = entry.id;
		onChanged();
	}

	async function assess(entry: Entry) {
		assessing = entry.id;
		notice = null;
		const result = await (
			await fetch(`/api/alignment/entries/${entry.id}/assess`, { method: 'POST' })
		).json();
		assessing = null;
		if (!result.ran) notice = result.reason ?? 'Could not read that entry.';
		await load();
		onChanged();
	}

	async function saveEdit(entry: Entry) {
		await fetch(`/api/alignment/entries/${entry.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ body: editBody })
		});
		editingId = null;
		await load();
	}

	async function toggleSkip(entry: Entry) {
		await fetch(`/api/alignment/entries/${entry.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ skipAssessment: !entry.skipAssessment })
		});
		await load();
	}

	async function remove(entry: Entry) {
		await fetch(`/api/alignment/entries/${entry.id}`, { method: 'DELETE' });
		await load();
		onChanged();
	}

	const when = (ts: number) => new Date(ts).toLocaleString();
	const preview = (body: string) => body.slice(0, 180) + (body.length > 180 ? '…' : '');
	const MOODS = [1, 2, 3, 4, 5];
</script>

<section class="journal">
	{#if notice}<p class="notice">{notice}</p>{/if}

	<article class="card composer">
		<h3>Write</h3>
		<p class="hint">
			Whatever is actually on your mind — a decision, something you did that sits badly, an
			ordinary day. Nothing is read unless you press Assess, so this box does not need to be
			written for anyone.
		</p>
		<label>
			<span class="sr-only">entry title</span>
			<input class="title" bind:value={draftTitle} placeholder="a title, if you want one" />
		</label>
		<label>
			<span class="sr-only">what happened</span>
			<textarea
				bind:value={draft}
				use:autoresize={draft}
				rows="8"
				placeholder="What happened, what you did, and what you made of it."
			></textarea>
		</label>
		<div class="row">
			<label class="tags-field">
				<span class="sr-only">tags</span>
				<input class="tags" bind:value={draftTags} placeholder="tags — work, family, health" />
			</label>
			<div class="mood">
				<span class="mood-label">mood</span>
				{#each MOODS as m (m)}
					<button
						class="mood-pip"
						class:on={draftMood !== null && m <= draftMood}
						aria-label="mood {m} of 5"
						onclick={() => (draftMood = draftMood === m ? null : m)}
					></button>
				{/each}
			</div>
			<label class="chk" title="Some entries exist to be written, not read back.">
				<input type="checkbox" bind:checked={draftSkip} />
				don't assess this one
			</label>
			<button class="btn primary" disabled={saving || !draft.trim()} onclick={save}>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</div>
	</article>

	{#if !hasConstitution && entries.length}
		<p class="hint warn">
			There is nothing in your Constitution yet, so nothing can be read against it. Write a few
			things you hold first — an entry is only ever judged against your own words.
		</p>
	{/if}

	{#each entries as entry (entry.id)}
		<article class="card entry">
			<header>
				<button class="entry-head" onclick={() => (openId = openId === entry.id ? null : entry.id)}>
					<span class="entry-title">{entry.title || 'Untitled'}</span>
					<span class="meta num">{when(entry.createdAt)}</span>
				</button>
				<div class="entry-actions">
					{#if entry.skipAssessment}
						<span class="tag">not for assessing</span>
					{:else}
						<button class="btn" disabled={assessing === entry.id} onclick={() => assess(entry)}>
							{assessing === entry.id
								? 'Reading…'
								: entry.assessment
									? entry.stale
										? 'Re-assess'
										: 'Assess again'
									: 'Assess'}
						</button>
					{/if}
				</div>
			</header>

			{#if entry.tags}<p class="tags-line">{entry.tags}</p>{/if}

			{#if openId === entry.id}
				{#if editingId === entry.id}
					<label>
						<span class="sr-only">edit this entry</span>
						<textarea bind:value={editBody} use:autoresize={editBody} rows="8"></textarea>
					</label>
					<div class="row">
						<button class="btn primary" onclick={() => saveEdit(entry)}>Save</button>
						<button class="btn" onclick={() => (editingId = null)}>Cancel</button>
					</div>
				{:else}
					<p class="body">{entry.body}</p>
					<div class="row">
						<button
							class="btn"
							onclick={() => {
								editingId = entry.id;
								editBody = entry.body;
							}}>Edit</button
						>
						<button class="btn" onclick={() => toggleSkip(entry)}>
							{entry.skipAssessment ? 'Allow assessing' : "Don't assess this one"}
						</button>
						<button class="btn danger" onclick={() => remove(entry)}>Delete</button>
					</div>
				{/if}

				{#if entry.stale}
					<p class="hint warn">
						This entry has been edited since it was read. The reading below is still what was said
						at the time — assess again to have it read as it now stands.
					</p>
				{/if}

				{#if entry.assessment}
					<div class="reading-slot">
						<AssessmentCard
							assessment={{ ...entry.assessment, stale: entry.stale }}
							{principleTitles}
							{dimensionNames}
							{mechanismNames}
						/>
					</div>
				{/if}
			{:else}
				<p class="preview">{preview(entry.body)}</p>
				{#if entry.assessment && !entry.assessment.care && entry.assessment.standing}
					<p class="standing-line">{entry.assessment.standing}</p>
				{/if}
			{/if}
		</article>
	{:else}
		<p class="hint">No entries yet.</p>
	{/each}
</section>

<style>
	.journal {
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
	input,
	textarea {
		width: 100%;
		box-sizing: border-box;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 0.45rem 0.55rem;
		font-family: inherit;
		font-size: var(--text-md);
	}
	textarea {
		line-height: 1.6;
		resize: vertical;
		/* Roomy by default: a small box asks for a small thought. */
		min-height: 9rem;
		max-height: 60vh;
		margin: 0.5rem 0;
	}
	.title {
		font-size: var(--text-lg);
	}
	.tags-field {
		flex: 1;
		min-width: 9rem;
		display: flex;
	}
	.tags {
		flex: 1;
		min-width: 9rem;
	}
	/* The composer's fields are wrapped in labels purely to carry a name for
	   screen readers, so the label must lay out as the field did. */
	.composer > label {
		display: block;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		flex-wrap: wrap;
	}
	.mood {
		display: flex;
		align-items: center;
		gap: 0.2rem;
	}
	.mood-label {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin-right: 0.2rem;
	}
	.mood-pip {
		width: 11px;
		height: 11px;
		padding: 0;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: transparent;
		cursor: pointer;
	}
	.mood-pip.on {
		background: var(--accent);
		border-color: var(--accent);
	}
	.chk {
		font-size: var(--text-base);
		color: var(--fg-dim);
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.chk input {
		width: auto;
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
	.entry header {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
	}
	.entry-head {
		flex: 1;
		text-align: left;
		background: none;
		border: none;
		padding: 0;
		font-family: inherit;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.entry-title {
		color: var(--fg);
		font-size: var(--text-md);
	}
	.meta,
	.tags-line {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.tags-line {
		margin: 0.3rem 0 0;
	}
	.tag {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--fg-dim);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0.1rem 0.4rem;
	}
	.preview,
	.body {
		font-size: var(--text-md);
		line-height: 1.6;
		color: var(--fg-dim);
		margin: 0.5rem 0;
		white-space: pre-wrap;
	}
	.body {
		color: var(--fg);
	}
	.standing-line {
		font-size: var(--text-base);
		color: var(--accent);
		margin: 0.3rem 0 0;
	}
	.reading-slot {
		margin-top: 0.8rem;
	}
	@media (max-width: 720px) {
		.entry header {
			flex-direction: column;
		}
	}
</style>
