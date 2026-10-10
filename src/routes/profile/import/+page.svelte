<script lang="ts">
	import ProfileDraft from '$lib/components/ProfileDraft.svelte';
	import { emptyDraft, type Draft, type ViewDomain } from '$lib/profile-draft';

	let text = $state('');
	let draft = $state<Draft>(emptyDraft());
	let from = $state<'export' | 'text' | null>(null);
	let reading = $state(false);
	let notice = $state<string | null>(null);
	let saved = $state<{ added: number; skipped: number; people: number } | null>(null);
	let domains = $state<ViewDomain[]>([]);

	$effect(() => {
		void fetch('/api/profile')
			.then((r) => (r.ok ? r.json() : null))
			.then((v) => (domains = v?.domains ?? []))
			.catch(() => {});
	});

	async function pick(ev: Event & { currentTarget: HTMLInputElement }) {
		const file = ev.currentTarget.files?.[0];
		if (!file) return;
		text = await file.text().catch(() => '');
		if (!text) notice = 'That file could not be read.';
	}

	async function read() {
		reading = true;
		notice = null;
		from = null;
		saved = null;
		const res = await fetch('/api/profile/import', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text })
		}).catch(() => null);
		reading = false;
		const body = await res?.json().catch(() => null);
		if (!res?.ok) {
			notice = body?.message ?? 'That could not be read. Try again.';
			return;
		}
		const { from: kind, ...rest } = body;
		draft = rest;
		from = kind;
	}
</script>

<div class="import-page">
	<h1>Profile</h1>
	<section class="import-section">
		<article class="card">
			<h3>Import</h3>
			<p class="hint">
				Paste a profile you exported from Galaxy, or what another assistant remembers about you: ask
				ChatGPT or Claude to list everything it remembers about you, and paste its answer here. You see
				every line before any of it is saved.
			</p>
			<label class="paste">
				Text
				<textarea rows="8" bind:value={text} oninput={() => (from = null)}></textarea>
			</label>
			<div class="row">
				<label class="file">
					Or a file
					<input type="file" accept=".md,.txt,text/markdown,text/plain" onchange={pick} />
				</label>
				<button class="btn primary" disabled={!text.trim() || reading} onclick={read}>
					{reading ? 'Reading…' : 'Read it'}
				</button>
			</div>
			{#if notice}<p class="notice error" role="alert">{notice}</p>{/if}
		</article>

		{#if saved}
			<article class="card">
				<p class="notice" role="status">
					Saved {saved.added} {saved.added === 1 ? 'line' : 'lines'} to your profile{saved.skipped
						? `; ${saved.skipped} ${saved.skipped === 1 ? 'was' : 'were'} already there`
						: ''}.
				</p>
				<a class="btn primary" href="/profile">Back to your profile</a>
			</article>
		{:else if from}
			<article class="card">
				<h3>Review</h3>
				<p class="hint">
					{from === 'export'
						? 'Read as a Galaxy profile export, line for line.'
						: 'Sorted into your profile by a model. Check each line says what you meant.'}
				</p>
				<ProfileDraft bind:draft {domains} source="imported" onsaved={(r) => (saved = r)} />
			</article>
		{/if}
	</section>
</div>

<style>
	.import-page {
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
	.import-section {
		max-width: 46rem;
	}
	@media (max-width: 720px) {
		.import-page {
			padding: 0.75rem 0.85rem;
		}
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.paste,
	.file {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.paste textarea {
		width: 100%;
		box-sizing: border-box;
		font-size: var(--text-base);
	}
	.row {
		display: flex;
		align-items: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
	}
	input:not([type='checkbox']):not([type='file']),
	textarea {
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		color: var(--fg);
		font-family: inherit;
		padding: 0.3rem 0.45rem;
		box-sizing: border-box;
	}
	textarea {
		resize: vertical;
	}
</style>
