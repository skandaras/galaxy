<script lang="ts">
	import { orbDots } from '$lib/galaxy-orb';

	let {
		/** What the turn is doing. Decides the orbits, and the colour after them. */
		mode = 'thinking',
		/** Read out to assistive tech, and shown beside the orb unless `bare`. */
		label = 'Thinking',
		/** Any CSS length. */
		size = '1.8em',
		/** Seconds for the outermost dot to come round. Inner ones are faster. */
		swirl = mode === 'searching' ? 3 : 4.6,
		/** Drop the pill and the label, leaving just the sphere. */
		bare = false
	}: {
		mode?: 'thinking' | 'searching';
		label?: string;
		size?: string;
		swirl?: number;
		bare?: boolean;
	} = $props();

	// The states are told apart by how the dots move before anything else: free
	// tilts every orbit differently and reads as association, axial allows only
	// circles of latitude and meridians and reads as a sweep being conducted.
	// Colour follows, so neither state depends on it being seen.
	const dots = $derived(
		mode === 'searching'
			? orbDots({ count: 34, pattern: 'axial', turn: 0.5 })
			: orbDots({ count: 30, pattern: 'free' })
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
		{#each dots as d, i (i)}
			<span
				class="pip"
				style={`--cy:${d.cy}; --rad:${d.rad}; --ux:${d.ux}; --uy:${d.uy}; --uz:${d.uz}; --vx:${d.vx}; --vy:${d.vy}; --vz:${d.vz}; --size:${d.size}; --dim:${d.dim}; --period:${d.period}; --phase:${d.phase}`}
			></span>
		{/each}
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
		--sheen-base: var(--fg-dim);
		--sheen-hi: var(--fg);
	}
	/* Falls back to the accent, matching GalaxyBackdrop and GalaxySpinner — a
	   theme saved before the backdrop had a colour of its own still lights up.
	   Mixed back toward the body colour rather than used neat, so searching
	   reads as the same dots tinted rather than as a second palette; the plain
	   value above it stands where color-mix is not supported. */
	.orb-pill.searching {
		--pip: var(--galaxy, var(--accent));
		--pip: color-mix(in oklab, var(--galaxy, var(--accent)) 72%, var(--fg));
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
	/*
	 * One dot, carried around its own circle by the keyframes below.
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
		/* Its own light, rather than the theme's --glow: that one is documented
		   as the hover glow on buttons, a user can switch it off entirely with
		   glowStrength, and a white button glow over blue dots would fight them.
		   The element's own opacity covers the shadow too, so a dot's halo
		   fades as it goes round the back without being animated separately. */
		box-shadow: 0 0 calc(var(--orb-size) * var(--size) * 0.35) var(--pip);
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
	 * The dot sits at `centre + rad · (u·cos θ + v·sin θ)`, so each of its three
	 * coordinates is a single sinusoid and the whole orbit survives being cut
	 * into keyframes. That is what lets one rule drive orbits of every
	 * orientation: the plane arrives per dot as u and v, and only the cosines
	 * are baked in here. Keyframes interpolate linearly, so this is a
	 * twelve-sided approximation of a circle — under two percent of a dot's
	 * travel at this size, and invisible.
	 *
	 * Depth rides the same track: a dot grows and brightens as it comes to the
	 * front and shrinks as it goes behind, by however much its own circle
	 * actually carries it toward the viewer. A dot on a meridian seen edge-on
	 * barely changes; one whose plane faces us changes most.
	 */
	@keyframes orb-orbit {
		0% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * 1 + var(--vx) * 0)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * 1 + var(--vy) * 0))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * 1 + var(--vz) * 0))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * 1 + var(--vz) * 0)));
		}
		8.333% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * 0.866 + var(--vx) * 0.5)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * 0.866 + var(--vy) * 0.5))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * 0.866 + var(--vz) * 0.5))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * 0.866 + var(--vz) * 0.5)));
		}
		16.667% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * 0.5 + var(--vx) * 0.866)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * 0.5 + var(--vy) * 0.866))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * 0.5 + var(--vz) * 0.866))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * 0.5 + var(--vz) * 0.866)));
		}
		25% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * 0 + var(--vx) * 1)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * 0 + var(--vy) * 1))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * 0 + var(--vz) * 1))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * 0 + var(--vz) * 1)));
		}
		33.333% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * -0.5 + var(--vx) * 0.866)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * -0.5 + var(--vy) * 0.866))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * -0.5 + var(--vz) * 0.866))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * -0.5 + var(--vz) * 0.866)));
		}
		41.667% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * -0.866 + var(--vx) * 0.5)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * -0.866 + var(--vy) * 0.5))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * -0.866 + var(--vz) * 0.5))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * -0.866 + var(--vz) * 0.5)));
		}
		50% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * -1 + var(--vx) * 0)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * -1 + var(--vy) * 0))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * -1 + var(--vz) * 0))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * -1 + var(--vz) * 0)));
		}
		58.333% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * -0.866 + var(--vx) * -0.5)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * -0.866 + var(--vy) * -0.5))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * -0.866 + var(--vz) * -0.5))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * -0.866 + var(--vz) * -0.5)));
		}
		66.667% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * -0.5 + var(--vx) * -0.866)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * -0.5 + var(--vy) * -0.866))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * -0.5 + var(--vz) * -0.866))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * -0.5 + var(--vz) * -0.866)));
		}
		75% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * 0 + var(--vx) * -1)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * 0 + var(--vy) * -1))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * 0 + var(--vz) * -1))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * 0 + var(--vz) * -1)));
		}
		83.333% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * 0.5 + var(--vx) * -0.866)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * 0.5 + var(--vy) * -0.866))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * 0.5 + var(--vz) * -0.866))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * 0.5 + var(--vz) * -0.866)));
		}
		91.667% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * 0.866 + var(--vx) * -0.5)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * 0.866 + var(--vy) * -0.5))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * 0.866 + var(--vz) * -0.5))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * 0.866 + var(--vz) * -0.5)));
		}
		100% {
			transform: translate3d(
					calc(var(--orb-size) * 0.5 * var(--rad) * (var(--ux) * 1 + var(--vx) * 0)),
					calc(var(--orb-size) * -0.5 * (var(--cy) + var(--rad) * (var(--uy) * 1 + var(--vy) * 0))),
					0
				)
				scale(calc(1 + 0.3 * (var(--rad) * (var(--uz) * 1 + var(--vz) * 0))));
			opacity: calc(var(--dim) + 0.32 * (var(--rad) * (var(--uz) * 1 + var(--vz) * 0)));
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
	   people cannot have. Each dot holds the place its own phase puts it at, so
	   the cluster stays a sphere rather than collapsing onto one meridian. The
	   label keeps a solid fill rather than freezing mid-sheen, which lands on
	   whatever colour the gradient stopped on. */
	@media (prefers-reduced-motion: reduce) {
		.pip {
			animation: none;
			transform: translate3d(
				calc(
					var(--orb-size) * 0.5 * var(--rad) *
						(var(--ux) * cos(var(--phase) * 1turn) + var(--vx) * sin(var(--phase) * 1turn))
				),
				calc(
					var(--orb-size) * -0.5 *
						(
							var(--cy) + var(--rad) *
								(var(--uy) * cos(var(--phase) * 1turn) + var(--vy) * sin(var(--phase) * 1turn))
						)
				),
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
