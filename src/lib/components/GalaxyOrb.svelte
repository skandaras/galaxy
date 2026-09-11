<script lang="ts">
	import { orbDots } from '$lib/galaxy-orb';

	let {
		/** What the turn is doing. Decides the colour and how the sphere moves. */
		mode = 'thinking',
		/** Read out to assistive tech, and shown beside the orb unless `bare`. */
		label = 'Thinking',
		/** Any CSS length. */
		size = '1.8em',
		/** Seconds for a polar dot to come round. Equatorial ones are faster. */
		swirl = mode === 'searching' ? 2.8 : 4.6,
		/** Drop the pill and the label, leaving just the sphere. */
		bare = false
	}: {
		mode?: 'thinking' | 'searching';
		label?: string;
		size?: string;
		swirl?: number;
		bare?: boolean;
	} = $props();

	// Searching shears the bands harder, so the sphere churns rather than
	// turning. The two states are told apart by movement first and colour
	// second, which is what keeps them legible to anyone who cannot rely on
	// the colour.
	const dots = $derived(
		orbDots(mode === 'searching' ? { count: 34, shear: 0.42, turn: 0.5 } : { count: 30 })
	);
</script>

<span
	class="orb-pill"
	class:searching={mode === 'searching'}
	class:bare
	style={`--orb-size:${size}; --swirl:${swirl}s`}
	role="status"
	aria-label={label}
>
	<span class="orb" aria-hidden="true">
		<span class="shell">
			{#each dots as d, i (i)}
				<span
					class="pip"
					style={`--y:${d.y}; --ring:${d.ring}; --size:${d.size}; --dim:${d.dim}; --period:${d.period}; --phase:${d.phase}`}
				></span>
			{/each}
		</span>
	</span>
	{#if !bare}<span class="label">{label}</span>{/if}
</span>

<style>
	.orb-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.85rem 0.3rem 0.45rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-pane);
		font-size: var(--text-md);
		/* The dots take the body colour rather than the dimmed one the label
		   uses: they are the one part that must stay visible on every preset. */
		--pip: var(--fg);
		--pip-lit: var(--fg);
		--sheen-base: var(--fg-dim);
		--sheen-hi: var(--fg);
	}
	/* Falls back to the accent, matching GalaxyBackdrop and GalaxySpinner — a
	   theme saved before the backdrop had a colour of its own still lights up. */
	.orb-pill.searching {
		--pip: var(--galaxy, var(--accent));
		--pip-lit: var(--fg);
		--sheen-hi: var(--galaxy, var(--accent));
	}
	.orb-pill.bare {
		padding: 0;
		border: 0;
		background: none;
	}

	.orb {
		position: relative;
		display: block;
		width: var(--orb-size);
		height: var(--orb-size);
		flex: 0 0 auto;
	}
	.shell {
		position: absolute;
		inset: 0;
	}
	/*
	 * One dot, carried around its circle of latitude by the keyframes below.
	 *
	 * This was three nested elements and a real 3D rotation once — a ring
	 * turning about the Y axis, and the dot counter-rotating inside it to stay
	 * facing front. It was correct and it rendered badly: a 3D transform puts
	 * every dot on its own composited layer, and a layer three or four pixels
	 * across rasterises too coarsely to keep a border radius, so half the
	 * sphere drew as little squares. Sampling the orbit as keyframes instead
	 * keeps the dots in their parent's layer, where they paint at full device
	 * resolution — and collapses three elements per dot to one. The cost is
	 * that a transform built from custom properties cannot be handed to the
	 * compositor; for thirty dots in a space this size that is not a trade
	 * worth taking back.
	 */
	.pip {
		position: absolute;
		left: 50%;
		top: 50%;
		width: calc(var(--orb-size) * var(--size));
		height: calc(var(--orb-size) * var(--size));
		margin: calc(var(--orb-size) * var(--size) / -2);
		border-radius: 50%;
		background: var(--pip);
		/* How far this dot swings across the face of the sphere, and the height
		   it holds while it does. Screen Y runs down and the sphere's does not,
		   hence the negation. */
		--ox: calc(var(--orb-size) * var(--ring) * 0.5);
		--oy: calc(var(--orb-size) * var(--y) * -0.5);
		opacity: var(--dim);
		animation: orb-orbit calc(var(--swirl) * var(--period)) linear infinite;
		/* Negative, so every dot is already somewhere else on its circle at the
		   first frame. Without it the sphere starts as a single meridian and
		   unwinds, which is visible every time the indicator appears. */
		animation-delay: calc(var(--swirl) * var(--period) * var(--phase) * -1);
	}

	/*
	 * The circle, sampled every thirty degrees.
	 *
	 * Keyframes interpolate linearly, so this is a twelve-sided approximation
	 * of the orbit rather than the orbit; at this size the error is under two
	 * percent of a dot's travel and invisible. Depth rides the same track —
	 * a dot grows and brightens as it comes to the front and shrinks as it goes
	 * behind, scaled by how far it actually travels, so a dot near a pole
	 * barely changes and one at the equator changes most. That scaling is what
	 * makes the cluster read as a sphere rather than as a flat scatter.
	 */
	@keyframes orb-orbit {
		0% {
			transform: translate3d(calc(var(--ox) * 1), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * 0));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * 0);
		}
		8.333% {
			transform: translate3d(calc(var(--ox) * 0.866), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * 0.5));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * 0.5);
		}
		16.667% {
			transform: translate3d(calc(var(--ox) * 0.5), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * 0.866));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * 0.866);
		}
		25% {
			transform: translate3d(calc(var(--ox) * 0), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * 1));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * 1);
		}
		33.333% {
			transform: translate3d(calc(var(--ox) * -0.5), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * 0.866));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * 0.866);
		}
		41.667% {
			transform: translate3d(calc(var(--ox) * -0.866), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * 0.5));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * 0.5);
		}
		50% {
			transform: translate3d(calc(var(--ox) * -1), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * 0));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * 0);
		}
		58.333% {
			transform: translate3d(calc(var(--ox) * -0.866), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * -0.5));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * -0.5);
		}
		66.667% {
			transform: translate3d(calc(var(--ox) * -0.5), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * -0.866));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * -0.866);
		}
		75% {
			transform: translate3d(calc(var(--ox) * 0), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * -1));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * -1);
		}
		83.333% {
			transform: translate3d(calc(var(--ox) * 0.5), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * -0.866));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * -0.866);
		}
		91.667% {
			transform: translate3d(calc(var(--ox) * 0.866), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * -0.5));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * -0.5);
		}
		100% {
			transform: translate3d(calc(var(--ox) * 1), var(--oy), 0)
				scale(calc(1 + 0.3 * var(--ring) * 0));
			opacity: calc(var(--dim) + 0.32 * var(--ring) * 0);
		}
	}

	/*
	 * Searching moves differently, not just faster.
	 *
	 * The whole sphere rolls in the plane of the screen, so it tumbles rather
	 * than spinning on the spot, and a brightening travels through the dots on
	 * a period of its own — a sweep crossing the body rather than a rotation of
	 * it. The sweep rides a property nothing else animates, so it composes with
	 * the orbit instead of replacing it.
	 */
	.searching .shell {
		animation: orb-roll calc(var(--swirl) * 4.5) linear infinite;
	}
	.searching .pip {
		animation:
			orb-orbit calc(var(--swirl) * var(--period)) linear infinite,
			orb-sweep calc(var(--swirl) * 0.8) ease-in-out infinite;
		animation-delay:
			calc(var(--swirl) * var(--period) * var(--phase) * -1),
			calc(var(--swirl) * 0.8 * var(--phase) * -1);
	}
	@keyframes orb-roll {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes orb-sweep {
		0%,
		70%,
		100% {
			background-color: var(--pip);
		}
		85% {
			background-color: var(--pip-lit);
		}
	}

	.label {
		color: var(--sheen-base);
		white-space: nowrap;
	}
	/* The sheen is the label's only animation, and it is the part that says the
	   run is alive when the model is quiet for a long time. Guarded because
	   without background-clip the transparent fill is an invisible label. */
	@supports ((background-clip: text) or (-webkit-background-clip: text)) {
		.label {
			background-image: linear-gradient(
				95deg,
				var(--sheen-base) 40%,
				var(--sheen-hi) 50%,
				var(--sheen-base) 60%
			);
			background-size: 280% 100%;
			-webkit-background-clip: text;
			background-clip: text;
			color: transparent;
			animation: orb-sheen 2.8s linear infinite;
		}
	}
	@keyframes orb-sheen {
		from {
			background-position: 140% 0;
		}
		to {
			background-position: -40% 0;
		}
	}

	/* The sphere still reads as a sphere standing still; the churn is what some
	   people cannot have. Each dot keeps the position its own phase puts it at,
	   so the cluster stays a sphere rather than collapsing to one meridian. The
	   label keeps a solid fill rather than freezing mid-sheen, which lands on
	   whatever colour the gradient stopped on. */
	@media (prefers-reduced-motion: reduce) {
		.shell,
		.pip {
			animation: none;
		}
		.pip {
			transform: translate3d(
				calc(var(--ox) * cos(var(--phase) * 360deg)),
				var(--oy),
				0
			);
		}
		.label {
			background-image: none;
			color: var(--sheen-base);
			animation: none;
		}
	}
</style>
