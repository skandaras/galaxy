<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { Theme } from '$lib/theme';

	let draft = $state<Theme | null>(null);
	let presets = $state<Record<string, Theme>>({});
	let custom = $state<Record<string, Theme>>({});
	let saveName = $state('');
	let saved = $state(false);

	$effect(() => {
		void (async () => {
			const data = await (await fetch('/api/settings/theme')).json();
			draft = data.theme;
			presets = data.presets;
			custom = data.custom ?? {};
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
		root.style.setProperty('--glow', draft.glow);
		root.style.setProperty('--glow-size', draft.glowStrength);
		root.style.fontSize = draft.baseFont;
	});

	/**
	 * The size control works in percent, because that is the unit people reason
	 * about. Themes saved before this stored a pixel size, so those are converted
	 * against the 16px browser default rather than being thrown away.
	 */
	const sizePercent = $derived.by(() => {
		const v = draft?.baseFont ?? '100%';
		const n = parseFloat(v);
		if (!Number.isFinite(n)) return 100;
		return v.trim().endsWith('%') ? Math.round(n) : Math.round((n / 16) * 100);
	});

	function setSize(percent: number) {
		if (!draft) return;
		draft.baseFont = `${Math.min(140, Math.max(80, Math.round(percent)))}%`;
	}

	const SIZE_PRESETS: { label: string; percent: number }[] = [
		{ label: 'compact', percent: 88 },
		{ label: 'comfortable', percent: 100 },
		{ label: 'roomy', percent: 110 }
	];

	async function save(saveAs?: string) {
		if (!draft) return;
		const res = await fetch('/api/settings/theme', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ theme: draft, saveAs })
		});
		if (res.ok) {
			const data = await res.json();
			custom = data.custom ?? custom;
			if (saveAs) saveName = '';
		}
		saved = true;
		setTimeout(() => (saved = false), 1500);
		await invalidateAll();
	}

	async function deleteCustom(name: string, ev: Event) {
		ev.stopPropagation();
		if (!confirm(`Delete saved theme "${name}"?`)) return;
		const res = await fetch(`/api/settings/theme?name=${encodeURIComponent(name)}`, {
			method: 'DELETE'
		});
		if (res.ok) custom = (await res.json()).custom ?? {};
	}

	function applyPreset(theme: Theme) {
		draft = { ...theme };
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

<div class="theme-section">
	{#if draft}
		<section class="card">
			<h3>Presets</h3>
			<div class="preset-row">
				{#each Object.entries(presets) as [name, p] (name)}
					<button
						class="preset"
						style="background:{p.bg};color:{p.accent};border-color:{p.border}"
						onclick={() => applyPreset(p)}
					>
						✦ {name}
					</button>
				{/each}
			</div>

			{#if Object.keys(custom).length}
				<h3 class="sub">Your saved themes</h3>
				<div class="preset-row">
					{#each Object.entries(custom) as [name, p] (name)}
						<span class="preset-wrap">
							<button
								class="preset"
								style="background:{p.bg};color:{p.accent};border-color:{p.border}"
								onclick={() => applyPreset(p)}
							>
								✦ {name}
							</button>
							<button class="del" title="Delete" onclick={(e) => deleteCustom(name, e)}>×</button>
						</span>
					{/each}
				</div>
			{/if}

			<div class="save-as">
				<input placeholder="Name this theme…" bind:value={saveName} maxlength="40" />
				<button
					class="btn"
					disabled={!saveName.trim()}
					onclick={() => save(saveName.trim())}
				>
					Save as preset
				</button>
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
			<p class="hint">
				Buttons glow on hover across the whole interface — set strength to <code>0px</code> to
				turn that off. Text size is a percentage of your browser's own default, so it stacks
				with any size you have set there.
			</p>
			<div class="grid">
				<label class="wide">
					font stack
					<input bind:value={draft.font} />
				</label>
				<label>
					corner radius
					<input bind:value={draft.radius} placeholder="5px" />
				</label>
				<label class="wide">
					interface text size — {sizePercent}%
					<span class="size-row">
						<input
							type="range"
							min="80"
							max="140"
							step="1"
							value={sizePercent}
							oninput={(e) => setSize(Number(e.currentTarget.value))}
						/>
						<input
							class="size-num"
							type="number"
							min="80"
							max="140"
							value={sizePercent}
							oninput={(e) => setSize(Number(e.currentTarget.value))}
						/>
						{#each SIZE_PRESETS as p (p.label)}
							<button
								class="size-preset"
								class:on={sizePercent === p.percent}
								onclick={() => setSize(p.percent)}>{p.label}</button
							>
						{/each}
					</span>
				</label>
				<label>
					hover glow
					<span class="color-pair">
						<input type="color" bind:value={draft.glow} />
						<input class="hex" bind:value={draft.glow} />
					</span>
				</label>
				<label>
					glow strength
					<input bind:value={draft.glowStrength} placeholder="10px" />
				</label>
				<label class="row">
					<input type="checkbox" bind:checked={draft.galaxyBg} />
					ambient ASCII galaxy backdrop
				</label>
				<label class="row" class:disabled={!draft.galaxyBg}>
					<input type="checkbox" bind:checked={draft.galaxyAnimate} disabled={!draft.galaxyBg} />
					slowly rotate the galaxy
				</label>
			</div>
		</section>

		<div class="actions">
			<button class="btn primary" onclick={() => save()}>{saved ? 'Saved ✓' : 'Save theme'}</button>
			<button class="btn" onclick={exportTheme}>Export</button>
			<label class="btn">
				Import
				<input type="file" accept="application/json" hidden onchange={importTheme} />
			</label>
		</div>
	{/if}
</div>

<style>
	.theme-section {
		max-width: 46rem;
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
	.preset-wrap {
		position: relative;
		display: inline-flex;
	}
	.del {
		position: absolute;
		top: -0.4rem;
		right: -0.4rem;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--fg-dim);
		font-size: 0.7rem;
		line-height: 1;
		cursor: pointer;
	}
	.del:hover {
		color: var(--danger);
		border-color: var(--danger);
	}
	.sub {
		margin-top: 1rem;
	}
	.save-as {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.9rem;
		padding-top: 0.8rem;
		border-top: 1px solid var(--border);
	}
	.save-as input {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		color: var(--fg);
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.35rem 0.5rem;
		flex: 1;
		max-width: 16rem;
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
	label.row.disabled {
		opacity: 0.45;
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
	input:not([type='color']):not([type='checkbox']):not([type='range']) {
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
	.hint {
		font-size: 0.68rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: -0.3rem 0 0.7rem;
	}
	.size-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.size-row input[type='range'] {
		flex: 1;
		min-width: 10rem;
		accent-color: var(--accent);
	}
	.size-num {
		width: 4.5rem;
	}
	.size-preset {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: 0.68rem;
		padding: 0.2rem 0.6rem;
		cursor: pointer;
	}
	.size-preset.on {
		border-color: var(--accent);
		color: var(--accent);
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
	@media (max-width: 720px) {
		.grid {
			grid-template-columns: 1fr;
		}
		.save-as input {
			max-width: none;
		}
	}
</style>
