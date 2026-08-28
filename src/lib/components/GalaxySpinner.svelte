<script lang="ts">
	import { spiralArmPath } from '$lib/galaxy-spinner';

	let {
		/** Any CSS length. Defaults to just over a line of text, so it sits inline. */
		size = '1.15em',
		/** Seconds per revolution. The backdrop takes 240; this is the fast one. */
		spin = 1.1,
		label = 'Working'
	}: { size?: string; spin?: number; label?: string } = $props();

	// Two arms half a turn apart, exactly as the backdrop's cos(2θ − …) draws.
	const armA = spiralArmPath();
	const armB = spiralArmPath({ phase: Math.PI });
</script>

<span
	class="galaxy-spinner"
	style={`--spinner-size:${size}; --spin-duration:${spin}s`}
	role="img"
	aria-label={label}
>
	<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
		<!-- The disc: what the arms are wound through, at the edge of visible. -->
		<circle cx="12" cy="12" r="9.5" class="disc" />
		<path d={armA} class="arm" />
		<path d={armB} class="arm" />
		<circle cx="12" cy="12" r="2.1" class="core" />
	</svg>
</span>

<style>
	.galaxy-spinner {
		display: inline-block;
		width: var(--spinner-size);
		height: var(--spinner-size);
		/* Sits on the text baseline rather than hanging below it. */
		vertical-align: -0.15em;
		flex: 0 0 auto;
	}
	svg {
		display: block;
		width: 100%;
		height: 100%;
		animation: swirl var(--spin-duration) linear infinite;
	}
	.arm {
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		opacity: 0.85;
	}
	.disc {
		stroke: currentColor;
		stroke-width: 0.6;
		opacity: 0.18;
	}
	/* Falls back to the accent, matching GalaxyBackdrop — a theme saved before
	   the backdrop had a colour of its own still lights the core. */
	.core {
		fill: var(--galaxy, var(--accent));
	}
	@keyframes swirl {
		to {
			transform: rotate(360deg);
		}
	}
	/* The shape still says "galaxy" standing still; the rotation is what some
	   people cannot have. */
	@media (prefers-reduced-motion: reduce) {
		svg {
			animation: none;
		}
	}
</style>
