<script lang="ts">
	interface Dimension {
		id: string;
		name: string;
		tradition: string;
		definition: string;
		evidence: string;
		anchors: string[];
		defaultWeight: number;
	}

	let dimensions = $state<Dimension[]>([]);
	let mechanisms = $state<Record<string, string>>({});
	let prefs = $state<{ disabled: string[]; weights: Record<string, number> }>({
		disabled: [],
		weights: {}
	});
	let version = $state(1);
	let expanded = $state<string | null>(null);

	async function load() {
		const res = await fetch('/api/alignment/rubric');
		if (!res.ok) return;
		const data = await res.json();
		dimensions = data.dimensions;
		mechanisms = data.mechanisms;
		prefs = data.prefs;
		version = data.version;
	}
	$effect(() => {
		void load();
	});

	async function savePrefs(next: typeof prefs) {
		const res = await fetch('/api/alignment/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ rubric: next })
		});
		if (res.ok) prefs = (await res.json()).rubric;
	}

	const toggle = (id: string) =>
		savePrefs({
			...prefs,
			disabled: prefs.disabled.includes(id)
				? prefs.disabled.filter((d) => d !== id)
				: [...prefs.disabled, id]
		});

	const setWeight = (id: string, weight: number) =>
		savePrefs({ ...prefs, weights: { ...prefs.weights, [id]: weight } });

	const weightOf = (d: Dimension) => prefs.weights[d.id] ?? d.defaultWeight;
</script>

<section class="rubric">
	<p class="hint intro">
		What an entry is read against. Every dimension comes from somewhere — a tradition in moral
		philosophy or a body of psychological work — and the source is named because something
		measuring your character has no business being unreadable by you. Switch off anything you do
		not want applied, and weight what matters most.
	</p>

	{#each dimensions as d (d.id)}
		{@const off = prefs.disabled.includes(d.id)}
		<article class="card" class:off>
			<header>
				<label class="chk">
					<input type="checkbox" checked={!off} onchange={() => toggle(d.id)} />
					<span class="name">{d.name}</span>
				</label>
				<span class="tradition">{d.tradition}</span>
			</header>

			<p class="definition">{d.definition}</p>

			<div class="controls">
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
				<button class="link" onclick={() => (expanded = expanded === d.id ? null : d.id)}>
					{expanded === d.id ? 'Hide' : 'Show'} the scale
				</button>
			</div>

			{#if expanded === d.id}
				<div class="detail">
					<p class="evidence"><span class="lead">Looks for</span>{d.evidence}</p>
					<ol class="anchors">
						{#each d.anchors as anchor, i (i)}
							<li><span class="anchor-n">{i + 1}</span>{anchor}</li>
						{/each}
					</ol>
				</div>
			{/if}
		</article>
	{/each}

	<article class="card">
		<h3>Disengagement mechanisms</h3>
		<p class="hint">
			The eight ways, in Bandura's account, that a person can act against their own standards
			without feeling that they have. These are detectable in ordinary word choice, which is why
			they are here — the reading names the mechanism and quotes the phrase carrying it.
		</p>
		<div class="mechanisms">
			{#each Object.values(mechanisms) as m (m)}
				<span class="mechanism">{m}</span>
			{/each}
		</div>
	</article>

	<p class="hint version">
		Rubric version {version}. Every reading records the version it was written under, so a change
		here never silently rewrites what past readings meant.
	</p>
</section>

<style>
	.rubric {
		max-width: 46rem;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
		margin-bottom: 0.7rem;
	}
	.card.off {
		opacity: 0.45;
	}
	header {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		margin-bottom: 0.5rem;
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: 0.78rem;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.chk {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		cursor: pointer;
	}
	.name {
		color: var(--fg);
		font-size: 0.85rem;
	}
	.tradition {
		font-size: 0.67rem;
		color: var(--accent);
		padding-left: 1.4rem;
	}
	.definition {
		font-size: 0.76rem;
		line-height: 1.6;
		color: var(--fg-dim);
		margin: 0 0 0.6rem;
	}
	.hint {
		font-size: 0.72rem;
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0 0 0.7rem;
	}
	.intro {
		max-width: 40rem;
		margin-bottom: 1rem;
	}
	.version {
		margin-top: 1rem;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.weight {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.68rem;
		color: var(--fg-dim);
	}
	.weight input {
		width: 6rem;
	}
	.weight-value {
		color: var(--accent);
	}
	.detail {
		border-top: 1px solid var(--border);
		margin-top: 0.7rem;
		padding-top: 0.6rem;
	}
	.evidence {
		font-size: 0.73rem;
		color: var(--fg-dim);
		line-height: 1.55;
		margin: 0 0 0.6rem;
	}
	.lead {
		display: block;
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--heading);
	}
	.anchors {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.anchors li {
		display: flex;
		gap: 0.5rem;
		font-size: 0.73rem;
		line-height: 1.5;
		color: var(--fg-dim);
		padding: 0.25rem 0;
	}
	.anchor-n {
		color: var(--accent);
		flex-shrink: 0;
		width: 1rem;
	}
	.mechanisms {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.mechanism {
		font-size: 0.68rem;
		padding: 0.12rem 0.45rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--fg-dim);
	}
	.link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 0.7rem;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
	}
</style>
