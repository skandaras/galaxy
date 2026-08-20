<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { contrastGrade, contrastRatio, type Theme } from '$lib/theme';
	import { fontStack, optionsFor, type FontRole } from '$lib/fonts';
	import { probeFonts } from '$lib/font-probe';

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
		root.style.setProperty('--heading', draft.heading);
		root.style.setProperty('--label', draft.label);
		root.style.setProperty('--galaxy', draft.galaxyColor);
		root.style.setProperty('--accent', draft.accent);
		root.style.setProperty('--border', draft.border);
		root.style.setProperty('--danger', draft.danger);
		root.style.setProperty('--font-ui', fontStack(draft.fontUi, 'ui'));
		root.style.setProperty('--font-mono', fontStack(draft.fontMono, 'mono'));
		root.style.setProperty('--radius', draft.radius);
		root.style.setProperty('--glow', draft.glow);
		root.style.setProperty('--glow-size', draft.glowStrength);
		root.style.fontSize = draft.baseFont;
	});

	/**
	 * Which faces are actually on this machine. Advisory only — an option is
	 * marked, never removed, because a theme travels between machines and a font
	 * missing on the laptop may well be on the phone.
	 */
	let available = $state<Record<string, boolean>>({});
	$effect(() => {
		available = probeFonts([...optionsFor('ui'), ...optionsFor('mono')]);
	});

	const fontGroups = (role: FontRole) => {
		const options = optionsFor(role);
		return role === 'ui'
			? [
					{ label: 'Interface', items: options.filter((f) => f.role === 'ui') },
					{ label: 'Monospace', items: options.filter((f) => f.role === 'mono') }
				]
			: [{ label: 'Monospace', items: options }];
	};

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

	/**
	 * `on` is the surface each colour is actually read against, so the contrast
	 * figure describes where the colour is really used: page-level text sits on
	 * `bg`, everything inside a card or panel on `bgPane`. Backgrounds themselves
	 * have nothing to be measured against, hence the null.
	 */
	const colorFields: { key: keyof Theme; label: string; on: 'bg' | 'bgPane' | null }[] = [
		{ key: 'bg', label: 'background', on: null },
		{ key: 'bgPane', label: 'panels', on: null },
		{ key: 'heading', label: 'titles', on: 'bgPane' },
		{ key: 'fg', label: 'body text', on: 'bg' },
		{ key: 'label', label: 'field labels', on: 'bgPane' },
		{ key: 'fgDim', label: 'dim text', on: 'bg' },
		{ key: 'accent', label: 'accent', on: 'bg' },
		{ key: 'border', label: 'borders', on: null },
		{ key: 'danger', label: 'danger', on: 'bgPane' }
	];

	/** Ratio and grade for one field, or null when it has no meaningful backdrop. */
	function contrast(field: { key: keyof Theme; on: 'bg' | 'bgPane' | null }) {
		if (!draft || !field.on) return null;
		const ratio = contrastRatio(draft[field.key] as string, draft[field.on]);
		if (!ratio) return null; // unparseable — say nothing rather than "fail"
		return { ratio, grade: contrastGrade(ratio) };
	}
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
				<label class="save-as-label">
					<span class="sr-only">name for this theme</span>
					<input placeholder="Name this theme…" bind:value={saveName} maxlength="40" />
				</label>
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
			<p class="hint">
				Titles, body text and field labels are separate colours, so the palette can be changed
				without dragging every heading's readability along with it. The badge is the WCAG
				contrast ratio against the surface each colour sits on — aim for <strong>AA</strong> or
				better on anything you have to read.
			</p>
			<div class="grid">
				{#each colorFields as f (f.key)}
					{@const c = contrast(f)}
					<label>
						<span class="field-head">
							{f.label}
							{#if c}
								<span class="contrast num {c.grade}" title="Contrast against {f.on === 'bg' ? 'the page background' : 'the panel background'}">
									{c.ratio.toFixed(1)}:1 {c.grade === 'AA-large' ? 'AA large only' : c.grade}
								</span>
							{/if}
						</span>
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
				<label class="wide font-field">
					interface font
					<span class="field-hint">
						Used for everything except code, preformatted text and numbers. Quicksand and Source
						Code Pro ship with Galaxy, so they render the same on every machine; the rest depend
						on what is installed here.
					</span>
					<select bind:value={draft.fontUi}>
						{#each fontGroups('ui') as group (group.label)}
							<optgroup label={group.label}>
								{#each group.items as f (f.id)}
									<option value={f.id}>
										{f.label}{available[f.id] === false ? ' — not on this device' : ''}
									</option>
								{/each}
							</optgroup>
						{/each}
					</select>
					<span class="sample" style="font-family: {fontStack(draft.fontUi, 'ui')}">
						The quick brown fox jumps over the lazy dog
					</span>
				</label>
				<label class="wide font-field">
					code font
					<span class="field-hint">
						Code blocks, diffs, the Observatory and every number in the interface, so figures in a
						column line up. The ASCII backdrop keeps its own font and is not affected by this.
					</span>
					<select bind:value={draft.fontMono}>
						{#each fontGroups('mono') as group (group.label)}
							<optgroup label={group.label}>
								{#each group.items as f (f.id)}
									<option value={f.id}>
										{f.label}{available[f.id] === false ? ' — not on this device' : ''}
									</option>
								{/each}
							</optgroup>
						{/each}
					</select>
					<span class="sample" style="font-family: {fontStack(draft.fontMono, 'mono')}">
						const total = 1234567.89;  // 0123456789
					</span>
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
				<label class:disabled={!draft.galaxyBg}>
					galaxy characters
					<span class="color-pair">
						<input type="color" bind:value={draft.galaxyColor} disabled={!draft.galaxyBg} />
						<input class="hex" bind:value={draft.galaxyColor} disabled={!draft.galaxyBg} />
					</span>
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
		font-size: var(--text-base);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
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
		font-size: var(--text-md);
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
		font-size: var(--text-sm);
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
	.save-as-label {
		display: flex;
		flex: 1;
		max-width: 16rem;
	}
	.save-as input {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
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
		font-size: var(--text-sm);
		color: var(--label);
	}
	label.wide {
		grid-column: 1 / -1;
	}
	label.row {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
	}
	label.row.disabled,
	label.disabled {
		opacity: 0.45;
	}
	.field-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.4rem;
	}
	/* Graded rather than pass/fail: a heading at 3.5:1 is legible at heading size
	   and not at body size, and flattening that to "fail" would push people away
	   from palettes that are actually fine where the colour is used. */
	.contrast {
		font-size: var(--text-xs);
		letter-spacing: 0.04em;
		white-space: nowrap;
		opacity: 0.85;
	}
	.contrast.AAA,
	.contrast.AA {
		color: var(--accent);
	}
	.contrast.AA-large {
		color: var(--fg-dim);
	}
	.contrast.fail {
		color: var(--danger);
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
	input:not([type='color']):not([type='checkbox']):not([type='range']),
	select {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.35rem 0.5rem;
	}
	.hex {
		width: 6.5rem;
	}
	.field-hint {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		line-height: 1.45;
		font-weight: normal;
	}
	.font-field select {
		width: 100%;
	}
	/* Rendered in the font it names, so the choice is visible before it is saved
	   — including whether it fell back because the face is not installed. */
	.sample {
		display: block;
		margin-top: 0.15rem;
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--fg);
		font-size: var(--text-lg);
		white-space: nowrap;
		overflow-x: auto;
	}
	.hint {
		font-size: var(--text-sm);
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
		font-size: var(--text-sm);
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
		font-size: var(--text-base);
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
