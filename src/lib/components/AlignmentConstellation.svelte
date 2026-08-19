<script lang="ts">
	import {
		DIRECTION_GLYPH,
		constellationLines,
		layoutStars,
		type StarInput
	} from '$lib/alignment-constellation';

	let { dimensions = [] as StarInput[] } = $props();

	const stars = $derived(layoutStars(dimensions));
	const lines = $derived(constellationLines(stars));

	let hovered = $state<string | null>(null);
	const active = $derived(stars.find((s) => s.id === hovered) ?? null);

	/** Viewbox is 0-1000 so the fractions above turn into round numbers. */
	const S = 1000;
	const reading = (value: number | null) => (value === null ? 'not yet read' : value.toFixed(1));
</script>

<figure class="constellation">
	<svg viewBox="0 0 {S} {S * 0.72}" role="img" aria-label="Your alignment constellation">
		<!-- Joins are decorative: they make it a sky rather than a scatter plot,
		     and deliberately encode nothing about which dimensions relate. -->
		{#each lines as line, i (i)}
			<line
				x1={line.x1 * S}
				y1={line.y1 * S * 0.72}
				x2={line.x2 * S}
				y2={line.y2 * S * 0.72}
				class="join"
			/>
		{/each}

		{#each stars as star (star.id)}
			<g
				class="star"
				class:unlit={!star.lit}
				class:active={hovered === star.id}
				role="button"
				tabindex="0"
				aria-label="{star.name}: {reading(star.recent)}"
				onmouseenter={() => (hovered = star.id)}
				onmouseleave={() => (hovered = null)}
				onfocus={() => (hovered = star.id)}
				onblur={() => (hovered = null)}
			>
				<!-- Glow first, so the star core sits on top of its own halo. -->
				<circle
					cx={star.x * S}
					cy={star.y * S * 0.72}
					r={star.r * S * 2.6}
					class="glow"
					style="opacity: {star.brightness * 0.28}"
				/>
				<circle
					cx={star.x * S}
					cy={star.y * S * 0.72}
					r={star.r * S}
					class="core"
					style="opacity: {0.35 + star.brightness * 0.65}"
				/>
				<!-- Hit area: the drawn star is far too small to point at on a phone. -->
				<circle cx={star.x * S} cy={star.y * S * 0.72} r={star.r * S * 3.2} class="hit" />
			</g>
		{/each}
	</svg>

	<figcaption>
		{#if active}
			<span class="cap-name">{active.name}</span>
			<span class="cap-detail">
				{reading(active.recent)}
				{#if active.lit}
					· {DIRECTION_GLYPH[active.direction]}
					{active.direction}
					· {active.count}
					{active.count === 1 ? 'reading' : 'readings'}
				{/if}
			</span>
			<span class="cap-tradition">{active.tradition}</span>
		{:else}
			<span class="cap-detail">
				Each star is one dimension of the rubric; how brightly it burns is how it has been reading
				lately. Unlit means it has not come up yet. Hover one to name it.
			</span>
		{/if}
	</figcaption>
</figure>

<style>
	.constellation {
		margin: 0;
	}
	svg {
		width: 100%;
		height: auto;
		display: block;
		overflow: visible;
	}
	.join {
		stroke: var(--border);
		stroke-width: 1;
		opacity: 0.5;
	}
	.core {
		fill: var(--accent);
	}
	.glow {
		fill: var(--accent);
	}
	.hit {
		fill: transparent;
		cursor: pointer;
	}
	.star {
		outline: none;
	}
	.star.unlit .core {
		fill: var(--fg-dim);
	}
	.star.unlit .glow {
		fill: none;
	}
	.star.active .core,
	.star:focus-visible .core {
		fill: var(--fg);
	}
	figcaption {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-top: 0.6rem;
		/* Reserved so naming a star does not shunt the page around. */
		min-height: 2.9rem;
		font-size: 0.7rem;
		line-height: 1.5;
	}
	.cap-name {
		color: var(--fg);
		font-size: 0.78rem;
	}
	.cap-detail {
		color: var(--fg-dim);
	}
	.cap-tradition {
		color: var(--fg-dim);
		opacity: 0.7;
		font-size: 0.65rem;
	}
</style>
