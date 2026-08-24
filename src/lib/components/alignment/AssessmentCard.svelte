<script lang="ts">
	import { BAND_LABELS, type AssessmentBand } from '$lib/alignment-types';

	interface Score {
		dimensionId: string;
		score: number;
		evidence: string;
		principles: string[];
		note: string;
	}
	interface Tension {
		between: string[];
		chose: string;
		note: string;
		declared: boolean;
	}
	interface Gap {
		principle: string;
		observation: string;
		evidence: string;
	}
	interface Assessment {
		id: string;
		band: AssessmentBand;
		standing: string;
		summary: string;
		confidence: 'low' | 'medium' | 'high';
		scores: Score[] | null;
		tensions: Tension[] | null;
		gaps: Gap[] | null;
		disengagement: string[] | null;
		rumination: boolean;
		care: boolean;
		nextStep: string;
		question: string;
		createdAt: number;
		stale?: boolean;
	}

	let {
		assessment,
		principleTitles = {} as Record<string, string>,
		dimensionNames = {} as Record<string, string>,
		mechanismNames = {} as Record<string, string>,
		compact = false
	}: {
		assessment: Assessment;
		principleTitles?: Record<string, string>;
		dimensionNames?: Record<string, string>;
		mechanismNames?: Record<string, string>;
		compact?: boolean;
	} = $props();

	const titleOf = (id: string) => principleTitles[id] ?? 'a principle you have since removed';
	const nameOf = (id: string) => dimensionNames[id] ?? id;
	const when = (ts: number) => new Date(ts).toLocaleString();
</script>

{#if assessment.care}
	<!-- The rubric was set aside. Nothing about scores belongs on this screen. -->
	<article class="reading care">
		<p class="care-body">{assessment.summary}</p>
		<p class="meta">{when(assessment.createdAt)}</p>
	</article>
{:else}
	<article class="reading" class:stale={assessment.stale}>
		<header>
			<span class="band {assessment.band}">{BAND_LABELS[assessment.band]}</span>
			{#if assessment.standing}<span class="standing">{assessment.standing}</span>{/if}
			<span class="meta">
				{when(assessment.createdAt)} · {assessment.confidence} confidence
				{#if assessment.stale} · <span class="stale-tag">entry edited since</span>{/if}
			</span>
		</header>

		{#if assessment.band === 'insufficient' && !assessment.scores?.length}
			<p class="hint">
				There was not enough in this entry to say anything about character — which is a real
				answer, not a failure. Short or purely factual entries usually read this way.
			</p>
		{/if}

		{#if assessment.summary}<p class="summary">{assessment.summary}</p>{/if}

		{#if assessment.rumination}
			<p class="flag">
				This reads more like circling than reflecting. That is worth noticing in itself — going
				over it again usually makes it heavier rather than clearer.
			</p>
		{/if}

		{#if !compact && assessment.scores?.length}
			<ul class="scores">
				{#each assessment.scores as s (s.dimensionId)}
					<li>
						<div class="score-head">
							<span class="score-name">{nameOf(s.dimensionId)}</span>
							<span class="score-value" aria-label="{s.score} out of 5">
								{#each [1, 2, 3, 4, 5] as n (n)}<span class="pip" class:on={n <= s.score}></span
									>{/each}
							</span>
						</div>
						<!-- Your own words. Every score has to point at one, or it was
						     dropped before it reached this screen. -->
						<blockquote>{s.evidence}</blockquote>
						{#if s.note}<p class="score-note">{s.note}</p>{/if}
						{#if s.principles.length}
							<p class="engaged">
								touches {#each s.principles as p, i (p)}<span class="principle"
										>{titleOf(p)}</span
									>{i < s.principles.length - 1 ? ', ' : ''}{/each}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if assessment.tensions?.length}
			<section class="block">
				<h4>Where two of your own pulled apart</h4>
				{#each assessment.tensions as t (t.between.join())}
					<div class="tension">
						<span class="pair">
							{titleOf(t.between[0])} vs {titleOf(t.between[1])}
						</span>
						<span class="chose">chose {titleOf(t.chose)}</span>
						{#if t.declared}
							<!-- You had already named this conflict, so it is a trade-off you
							     have thought about rather than something to answer for. -->
							<span class="declared">a tension you had already named</span>
						{/if}
						{#if t.note}<p class="score-note">{t.note}</p>{/if}
					</div>
				{/each}
			</section>
		{/if}

		{#if assessment.gaps?.length}
			<section class="block">
				<h4>Where it diverged</h4>
				{#each assessment.gaps as g (g.principle + g.evidence)}
					<div class="gap">
						<span class="principle">{titleOf(g.principle)}</span>
						<p class="score-note">{g.observation}</p>
						<blockquote>{g.evidence}</blockquote>
					</div>
				{/each}
			</section>
		{/if}

		{#if assessment.disengagement?.length}
			<section class="block">
				<h4>Language worth a second look</h4>
				<p class="hint">
					Ways of describing something that let it sit more comfortably than it should. Noticing
					them is the point.
				</p>
				<div class="mechanisms">
					{#each assessment.disengagement as m (m)}
						<span class="mechanism">{mechanismNames[m] ?? m}</span>
					{/each}
				</div>
			</section>
		{/if}

		{#if assessment.nextStep || assessment.question}
			<footer>
				{#if assessment.nextStep}
					<p class="next"><span class="lead">Next</span>{assessment.nextStep}</p>
				{/if}
				{#if assessment.question}
					<p class="question"><span class="lead">To sit with</span>{assessment.question}</p>
				{/if}
			</footer>
		{/if}
	</article>
{/if}

<style>
	.reading {
		border: 1px solid var(--border);
		border-left: 2px solid var(--accent);
		border-radius: 6px;
		padding: 0.8rem;
		font-size: var(--text-md);
		line-height: 1.55;
	}
	.reading.stale {
		border-left-color: var(--fg-dim);
		opacity: 0.75;
	}
	.reading.care {
		border-left-color: var(--fg);
	}
	.care-body {
		white-space: pre-wrap;
		margin: 0 0 0.5rem;
		font-size: var(--text-md);
		line-height: 1.6;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.band {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		background: var(--border);
		color: var(--fg);
		white-space: nowrap;
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
	.standing {
		flex: 1;
		min-width: 12rem;
		color: var(--fg);
	}
	/* Its own line: the standing sentence is the thing to read, and a timestamp
	   sharing the row with it wraps into the middle of the sentence. */
	header .meta {
		flex-basis: 100%;
	}
	.meta,
	.hint {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.hint {
		line-height: 1.5;
		margin: 0 0 0.6rem;
	}
	.stale-tag {
		color: var(--danger);
	}
	.summary {
		margin: 0 0 0.7rem;
		white-space: pre-wrap;
	}
	.flag {
		border-left: 2px solid var(--fg-dim);
		padding-left: 0.6rem;
		margin: 0 0 0.7rem;
		font-size: var(--text-base);
		color: var(--fg-dim);
	}
	.scores {
		list-style: none;
		margin: 0 0 0.4rem;
		padding: 0;
	}
	.scores li {
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
	}
	.score-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.6rem;
	}
	.score-name {
		color: var(--fg);
		font-size: var(--text-base);
	}
	.score-value {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
	}
	.pip {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--border);
	}
	.pip.on {
		background: var(--accent);
	}
	blockquote {
		margin: 0.3rem 0 0;
		padding-left: 0.6rem;
		border-left: 1px solid var(--border);
		color: var(--fg-dim);
		font-size: var(--text-base);
		font-style: italic;
	}
	.score-note {
		margin: 0.3rem 0 0;
		font-size: var(--text-base);
		color: var(--fg-dim);
	}
	.engaged {
		margin: 0.3rem 0 0;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.principle {
		color: var(--accent);
	}
	.block {
		border-top: 1px solid var(--border);
		padding-top: 0.5rem;
		margin-top: 0.4rem;
	}
	h4 {
		margin: 0 0 0.4rem;
		font-size: var(--text-sm);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.tension,
	.gap {
		padding: 0.3rem 0;
	}
	.pair {
		color: var(--fg);
	}
	.chose {
		color: var(--fg-dim);
		font-size: var(--text-base);
		margin-left: 0.4rem;
	}
	.declared {
		display: inline-block;
		margin-left: 0.4rem;
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--accent);
	}
	.mechanisms {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}
	.mechanism {
		font-size: var(--text-xs);
		padding: 0.1rem 0.4rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--fg-dim);
	}
	footer {
		border-top: 1px solid var(--border);
		margin-top: 0.5rem;
		padding-top: 0.5rem;
	}
	.next,
	.question {
		margin: 0 0 0.3rem;
		font-size: var(--text-base);
	}
	.lead {
		display: block;
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--heading);
	}
	.question {
		color: var(--fg-dim);
		font-style: italic;
	}
</style>
