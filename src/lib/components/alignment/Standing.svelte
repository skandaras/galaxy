<script lang="ts">
	import AlignmentConstellation from '$lib/components/AlignmentConstellation.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import { DIRECTION_GLYPH } from '$lib/alignment-constellation';
	import { BAND_LABELS, type AssessmentBand } from '$lib/alignment-types';

	interface Dimension {
		id: string;
		name: string;
		tradition: string;
		weight: number;
		mean: number | null;
		recent: number | null;
		direction: 'rising' | 'steady' | 'falling' | 'unknown';
		count: number;
	}
	interface Standing {
		standing: string;
		band: AssessmentBand;
		confidence: 'low' | 'medium' | 'high';
		assessedAt: number | null;
		dimensions: Dimension[];
		streak: number;
		entries: number;
		assessments: number;
		neglected: { id: string; title: string }[];
		versionBoundaries: { id: string; at: number }[];
		latestSynthesis: {
			id: string;
			body: string;
			highlights: string[];
			createdAt: number;
		} | null;
		disengagement: { mechanism: string; times: number }[];
		rumination: boolean;
	}

	let { onGoTo }: { onGoTo: (tab: 'Journal' | 'Constitution') => void } = $props();

	let standing = $state<Standing | null>(null);
	let mechanismNames = $state<Record<string, string>>({});
	let running = $state(false);
	let notice = $state<string | null>(null);

	async function load() {
		const res = await fetch('/api/alignment/status');
		if (res.ok) standing = await res.json();
		const rubric = await fetch('/api/alignment/rubric');
		if (rubric.ok) mechanismNames = (await rubric.json()).mechanisms;
	}
	$effect(() => {
		void load();
	});

	async function writeLetter() {
		running = true;
		notice = null;
		const result = await (await fetch('/api/alignment/syntheses/run', { method: 'POST' })).json();
		running = false;
		if (!result.ran) notice = result.reason ?? 'Could not write the letter.';
		await load();
	}

	const when = (ts: number) => new Date(ts).toLocaleDateString();
	/** Only the dimensions that have actually been read, most-read first. */
	const scored = $derived((standing?.dimensions ?? []).filter((d) => d.count > 0));
	const unscored = $derived((standing?.dimensions ?? []).filter((d) => d.count === 0));
</script>

{#if !standing}
	<p class="hint">Reading…</p>
{:else if !standing.entries}
	<section class="empty">
		<h3>Nothing here yet</h3>
		<p class="hint">
			Alignment works in two halves. Write down what you actually hold in
			<button class="link" onclick={() => onGoTo('Constitution')}>Constitution</button> — a few
			values, a principle or two, and at least one way you know you go wrong. Then write a
			reflection in <button class="link" onclick={() => onGoTo('Journal')}>Journal</button> and
			press Assess when you want it read back against them.
		</p>
		<p class="hint">
			Nothing is ever read unless you ask for it, and this page fills in once there is something to
			say.
		</p>
	</section>
{:else}
	<section class="standing">
		<div class="headline">
			{#if standing.standing}
				<p class="line">{standing.standing}</p>
			{:else}
				<p class="line dim">
					{standing.assessments
						? 'No reading has been able to say much yet.'
						: 'Nothing has been assessed yet — write an entry and press Assess.'}
				</p>
			{/if}
			<div class="badges">
				<span class="band {standing.band}">{BAND_LABELS[standing.band]}</span>
				{#if standing.assessedAt}
					<span class="meta">last read {when(standing.assessedAt)}</span>
				{/if}
				<span class="meta">
					{standing.streak}
					{standing.streak === 1 ? 'day' : 'days'} written on in the last fortnight
				</span>
			</div>
		</div>

		{#if standing.rumination}
			<p class="flag">
				The last few entries read more like circling than reflecting. That is worth knowing on its
				own — and it is a sign to talk to someone rather than to write more.
			</p>
		{/if}

		<AlignmentConstellation dimensions={standing.dimensions} />

		{#if scored.length}
			<article class="card">
				<h3>Movement</h3>
				<p class="hint">
					Where each dimension has been going lately, not where it stands. A single reading is
					weather; the direction is the thing worth looking at.
				</p>
				<table>
					<tbody>
						{#each scored as d (d.id)}
							<tr>
								<td class="d-name">
									{d.name}
									<span class="d-tradition">{d.tradition}</span>
								</td>
								<td class="d-mean num">{d.recent?.toFixed(1) ?? '–'}</td>
								<td class="d-dir {d.direction}">
									{DIRECTION_GLYPH[d.direction]}
									{d.direction === 'unknown' ? 'too early' : d.direction}
								</td>
								<td class="d-count num">{d.count}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if unscored.length}
					<p class="hint unscored">
						Not yet read on: {unscored.map((d) => d.name).join(', ')}.
					</p>
				{/if}
			</article>
		{/if}

		{#if standing.versionBoundaries.length > 1}
			<article class="card">
				<h3>When the measure moved</h3>
				<p class="hint">
					You changed your constitution on these dates, so readings either side were judged
					against different words. A shift that lines up with one of these is the ruler moving,
					not you.
				</p>
				<div class="boundaries">
					{#each standing.versionBoundaries as v (v.id)}
						<span class="boundary num">{when(v.at)}</span>
					{/each}
				</div>
			</article>
		{/if}

		{#if standing.neglected.length}
			<article class="card">
				<h3>Not come up in a while</h3>
				<p class="hint">
					Nothing has cited these in ninety days. That might mean they are settled, or it might
					mean they have quietly stopped being yours — worth asking which.
				</p>
				<div class="neglected">
					{#each standing.neglected as p (p.id)}
						<button class="chip" onclick={() => onGoTo('Constitution')}>{p.title}</button>
					{/each}
				</div>
			</article>
		{/if}

		{#if standing.disengagement.length}
			<article class="card">
				<h3>Recurring language</h3>
				<p class="hint">
					Ways of putting things that make them sit more comfortably than they should. One is
					nothing; a pattern is worth knowing about.
				</p>
				<div class="mechanisms">
					{#each standing.disengagement as m (m.mechanism)}
						<span class="mechanism">
							{mechanismNames[m.mechanism] ?? m.mechanism}
							<span class="times">×{m.times}</span>
						</span>
					{/each}
				</div>
			</article>
		{/if}

		<article class="card">
			<h3>The longer view</h3>
			{#if notice}<p class="notice">{notice}</p>{/if}
			{#if standing.latestSynthesis}
				<p class="meta">Written {when(standing.latestSynthesis.createdAt)}</p>
				<div class="letter">
					<Markdown text={standing.latestSynthesis.body} />
				</div>
			{:else}
				<p class="hint">
					Once there are a few readings, a letter is written every week or so about what is
					growing and what is slipping. It reads the readings, never your entries.
				</p>
			{/if}
			<button class="btn" disabled={running} onclick={writeLetter}>
				{running ? 'Writing…' : 'Write one now'}
			</button>
		</article>
	</section>
{/if}

<style>
	.standing,
	.empty {
		max-width: 46rem;
	}
	.headline {
		margin-bottom: 1rem;
	}
	.line {
		font-size: var(--text-xl);
		line-height: 1.5;
		margin: 0 0 0.5rem;
		color: var(--fg);
	}
	.line.dim {
		color: var(--fg-dim);
		font-size: var(--text-lg);
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	.band {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		background: var(--border);
		color: var(--fg);
	}
	.band.aligned {
		background: var(--accent);
		color: var(--bg);
	}
	.band.diverging {
		border: 1px solid var(--danger);
		background: transparent;
		color: var(--danger);
	}
	.band.insufficient {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--fg-dim);
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.9rem;
		margin-top: 0.9rem;
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.hint,
	.meta {
		font-size: var(--text-base);
		color: var(--fg-dim);
		line-height: 1.5;
		margin: 0 0 0.7rem;
	}
	.unscored {
		margin: 0.6rem 0 0;
	}
	.notice {
		color: var(--accent);
		font-size: var(--text-base);
	}
	.flag {
		border-left: 2px solid var(--danger);
		padding-left: 0.6rem;
		font-size: var(--text-base);
		color: var(--fg-dim);
		line-height: 1.5;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-base);
	}
	td {
		padding: 0.4rem 0.3rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	.d-name {
		color: var(--fg);
	}
	.d-tradition {
		display: block;
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.d-mean {
		color: var(--accent);
		text-align: right;
		white-space: nowrap;
	}
	.d-dir {
		color: var(--fg-dim);
		white-space: nowrap;
		text-align: right;
		font-size: var(--text-sm);
	}
	.d-dir.rising {
		color: var(--accent);
	}
	.d-dir.falling {
		color: var(--danger);
	}
	.d-count {
		color: var(--fg-dim);
		text-align: right;
		font-size: var(--text-sm);
		width: 2rem;
	}
	.boundaries,
	.neglected,
	.mechanisms {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.boundary,
	.mechanism {
		font-size: var(--text-sm);
		padding: 0.12rem 0.45rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--fg-dim);
	}
	.times {
		color: var(--accent);
	}
	.chip {
		font-family: inherit;
		font-size: var(--text-sm);
		padding: 0.15rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: transparent;
		color: var(--fg);
		cursor: pointer;
	}
	.letter {
		font-size: var(--text-md);
		line-height: 1.6;
		margin-bottom: 0.7rem;
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
	}
	.btn:disabled {
		opacity: 0.5;
	}
	.link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
	}
	.empty h3 {
		margin-bottom: 0.8rem;
	}
</style>
