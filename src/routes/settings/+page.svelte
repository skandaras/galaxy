<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { Theme } from '$lib/theme';

	let draft = $state<Theme | null>(null);
	let presets = $state<Record<string, Theme>>({});
	let saved = $state(false);

	$effect(() => {
		void (async () => {
			const data = await (await fetch('/api/settings/theme')).json();
			draft = data.theme;
			presets = data.presets;
		})();
	});

	// Live preview: apply the draft to the document as it changes.
	$effect(() => {
		if (!draft) return;
		const root = document.documentElement;
		root.style.setProperty('--bg', draft.bg);
		root.style.setProperty('--bg-pane', draft.bgPane);
		root.style.setProperty('--fg', draft.fg);
		root.style.setProperty('--fg-dim', draft.fgDim);
		root.style.setProperty('--accent', draft.accent);
		root.style.setProperty('--border', draft.border);
		root.style.setProperty('--danger', draft.danger);
		root.style.setProperty('--font-mono', draft.font);
		root.style.setProperty('--radius', draft.radius);
		root.style.fontSize = draft.baseFont;
	});

	async function save() {
		if (!draft) return;
		await fetch('/api/settings/theme', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ theme: draft })
		});
		saved = true;
		setTimeout(() => (saved = false), 1500);
		await invalidateAll();
	}

	function applyPreset(name: string) {
		draft = { ...presets[name] };
	}

	function exportTheme() {
		if (!draft) return;
		const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'galaxy-theme.json';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function importTheme(ev: Event) {
		const file = (ev.target as HTMLInputElement).files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				draft = { ...draft!, ...JSON.parse(String(reader.result)) };
			} catch {
				/* not json */
			}
		};
		reader.readAsText(file);
		(ev.target as HTMLInputElement).value = '';
	}

	const colorFields: { key: keyof Theme; label: string }[] = [
		{ key: 'bg', label: 'background' },
		{ key: 'bgPane', label: 'panels' },
		{ key: 'fg', label: 'text' },
		{ key: 'fgDim', label: 'dim text' },
		{ key: 'accent', label: 'accent' },
		{ key: 'border', label: 'borders' },
		{ key: 'danger', label: 'danger' }
	];
</script>

<div class="theme-page">
	<h2>Theme</h2>
	{#if draft}
		<section class="card">
			<h3>Presets</h3>
			<div class="preset-row">
				{#each Object.entries(presets) as [name, p] (name)}
					<button
						class="preset"
						style="background:{p.bg};color:{p.accent};border-color:{p.border}"
						onclick={() => applyPreset(name)}
					>
						✦ {name}
					</button>
				{/each}
			</div>
		</section>

		<section class="card">
			<h3>Colours</h3>
			<div class="grid">
				{#each colorFields as f (f.key)}
					<label>
						{f.label}
						<span class="color-pair">
							<input type="color" bind:value={draft[f.key] as string} />
							<input class="hex" bind:value={draft[f.key] as string} />
						</span>
					</label>
				{/each}
			</div>
		</section>

		<section class="card">
			<h3>Typography &amp; layout</h3>
			<div class="grid">
				<label class="wide">
					font stack
					<input bind:value={draft.font} />
				</label>
				<label>
					corner radius
					<input bind:value={draft.radius} placeholder="5px" />
				</label>
				<label>
					density (base font size)
					<select bind:value={draft.baseFont}>
						<option value="17px">roomy</option>
						<option value="16px">comfortable</option>
						<option value="14px">compact</option>
					</select>
				</label>
				<label class="row">
					<input type="checkbox" bind:checked={draft.galaxyBg} />
					ambient ASCII galaxy backdrop
				</label>
			</div>
		</section>

		<div class="actions">
			<button class="btn primary" onclick={save}>{saved ? 'Saved ✓' : 'Save theme'}</button>
			<button class="btn" onclick={exportTheme}>Export</button>
			<label class="btn">
				Import
				<input type="file" accept="application/json" hidden onchange={importTheme} />
			</label>
		</div>
	{/if}
</div>

<style>
	.theme-page {
		flex: 1;
		padding: 1rem 1.25rem;
		overflow-y: auto;
		max-width: 46rem;
	}
	h2 {
		font-size: 0.9rem;
		letter-spacing: 0.3em;
		color: var(--accent);
		margin: 0 0 1rem;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
		margin-bottom: 0.9rem;
	}
	h3 {
		margin: 0 0 0.7rem;
		font-size: 0.75rem;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--fg-dim);
	}
	.preset-row {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.preset {
		border: 1px solid;
		border-radius: 8px;
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.6rem 1rem;
		cursor: pointer;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.7rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.7rem;
		color: var(--fg-dim);
	}
	label.wide {
		grid-column: 1 / -1;
	}
	label.row {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
	}
	.color-pair {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	input[type='color'] {
		width: 2.2rem;
		height: 1.8rem;
		padding: 0;
		border: 1px solid var(--border);
		background: none;
		cursor: pointer;
	}
	input:not([type='color']):not([type='checkbox']),
	select {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		color: var(--fg);
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.35rem 0.5rem;
	}
	.hex {
		width: 6.5rem;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: 0.4rem 0.8rem;
		font-family: inherit;
		font-size: 0.76rem;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
</style>
