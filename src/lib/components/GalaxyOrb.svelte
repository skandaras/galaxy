<script lang="ts">
	import { scale } from 'svelte/transition';
	import { orbDots, type OrbPattern } from '$lib/galaxy-orb';
	import type { Presence, ToolKind } from '$lib/presence';

	let {
		/** What the turn is doing. Decides the orbits, their speed and the colour. */
		presence = 'thinking',
		/** The calls running now, one satellite each. */
		calls = [],
		/** Read out to assistive tech, and shown beside the orb unless `bare`. */
		label = 'Thinking',
		/** The model's own passing words, under the label. */
		detail = '',
		/** Any CSS length. */
		size = '1.8em',
		/** The sphere alone, as decoration: no label, and hidden from assistive tech. */
		bare = false,
		/**
		 * Dot size against the sphere's. Dots are a fraction of the orb, which is
		 * right at the size of a line of text and balloons into soft blobs at the
		 * size of the empty-chat hero, so a big orb asks for smaller dots, and
		 * more of them.
		 */
		dotScale = 1,
		count = 32
	}: {
		presence?: Presence;
		calls?: { id: string; kind: ToolKind }[];
		label?: string;
		detail?: string;
		size?: string;
		bare?: boolean;
		dotScale?: number;
		count?: number;
	} = $props();

	// The states are told apart by how the dots move before anything else: free
	// tilts every orbit differently and reads as association, axial allows only
	// circles of latitude and meridians and reads as a sweep being conducted,
	// the ring faces you and plainly is not working. Colour follows, so no state
	// depends on it being seen.
	const PATTERN: Record<Presence, OrbPattern> = {
		idle: 'free',
		typing: 'free',
		thinking: 'free',
		searching: 'axial',
		tool: 'free',
		streaming: 'free',
		waiting: 'ring',
		error: 'free',
		done: 'free'
	};
	/** Seconds for the outermost dot to come round. Inner ones are faster. */
	const SWIRL: Record<Presence, number> = {
		idle: 14,
		typing: 10,
		thinking: 4.6,
		searching: 3,
		tool: 5.5,
		streaming: 6,
		waiting: 9,
		error: 16,
		done: 6
	};
	const pattern = $derived<OrbPattern>(
		presence === 'tool' && calls.some((c) => c.kind === 'code') ? 'planar' : PATTERN[presence]
	);
	const swirl = $derived(SWIRL[presence]);
	// One count for every pattern, so a change of state moves the same dots onto
	// new orbits rather than swapping one crowd for another.
	const dots = $derived(orbDots({ count, pattern, turn: pattern === 'axial' ? 0.5 : 0 }));

	const reduced =
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	/** Where a satellite starts on its orbit, from its call id, so two calls rarely start side by side. */
	const satPhase = (id: string) =>
		[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7) / 997;

	/*
	 * Keeping each dot where it was when the state changes.
	 *
	 * A dot's place on its circle is how far its CSS animation has run divided
	 * by its duration, and a new state brings a new duration (the swirl, and the
	 * new pattern's periods). Left alone, the browser keeps the elapsed time and
	 * every dot jumps to a different point on its circle at once, a visible
	 * reshuffle on each change of state. So the progress is read before the
	 * update and written back after it, as a time in the new duration.
	 */
	let orbEl = $state<HTMLElement | null>(null);
	let held: (number | null)[] = [];
	// The orbit itself, not the morph: a dot mid-glide also carries a transition
	// per orbit property, and getAnimations lists those alongside the orbit, so
	// taking the first one read and rewrote a transition's clock instead.
	const pipAnimations = (el: HTMLElement) =>
		[...el.querySelectorAll<HTMLElement>('.pip')].map((pip) =>
			typeof pip.getAnimations === 'function'
				? (pip.getAnimations().find((a) => 'animationName' in a) ?? null)
				: null
		);
	$effect.pre(() => {
		void dots;
		void swirl;
		held = orbEl ? pipAnimations(orbEl).map((a) => a?.effect?.getComputedTiming().progress ?? null) : [];
	});
	$effect(() => {
		void dots;
		void swirl;
		if (!orbEl || !held.length) return;
		pipAnimations(orbEl).forEach((a, i) => {
			const progress = held[i];
			const timing = a?.effect?.getTiming();
			if (!a || progress == null || !timing || typeof timing.duration !== 'number') return;
			const at = Number(timing.delay ?? 0) + progress * timing.duration;
			a.currentTime = at < 0 ? at + timing.duration : at;
		});
	});
</script>

<span
	class="orrery {presence}"
	class:bare
	style={`--orb-size:${size}; --swirl:${swirl}s; --dot-scale:${dotScale}`}
	role={bare ? undefined : 'status'}
	aria-label={bare ? undefined : label}
	aria-hidden={bare ? 'true' : undefined}
>
	<span class="orb" bind:this={orbEl} aria-hidden="true">
		{#each dots as d, i (i)}
			<span
				class="pip"
				style={`--cy:${d.cy}; --rad:${d.rad}; --ux:${d.ux}; --uy:${d.uy}; --uz:${d.uz}; --vx:${d.vx}; --vy:${d.vy}; --vz:${d.vz}; --size:${d.size}; --dim:${d.dim}; --period:${d.period}; --phase:${d.phase}`}
			></span>
		{/each}
		{#each calls as call (call.id)}
			<span
				class="sat {call.kind}"
				style={`--sat-phase:${satPhase(call.id)}`}
				transition:scale={{ duration: reduced ? 0 : 320, start: 0.1 }}
			></span>
		{/each}
	</span>
	{#if !bare}
		<span class="words">
			<span class="label">{label}</span>
			{#if detail}<span class="detail">{detail}</span>{/if}
		</span>
	{/if}
</span>

<style>
	/* Registered so a change of state can glide each dot from one orbit to the
	   next: an unregistered custom property cannot be transitioned. Where
	   @property is unsupported the dots land on their new orbits at once. */
	@property --cy {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --rad {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --ux {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --uy {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --uz {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --vx {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --vy {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}
	@property --vz {
		syntax: '<number>';
		inherits: false;
		initial-value: 0;
	}

	.orrery {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
		/* The dots take the body colour rather than the dimmed one the label
		   uses: they are the one part that must stay visible on every preset. */
		--pip: var(--fg);
		--sheen-base: var(--fg-dim);
		--sheen-hi: var(--fg);
	}
	/* Falls back to the accent, matching GalaxyBackdrop and GalaxySpinner: a
	   theme saved before the backdrop had a colour of its own still lights up.
	   Mixed back toward the body colour rather than used neat, so searching
	   reads as the same dots tinted rather than as a second palette; the plain
	   value above it stands where color-mix is not supported. */
	.orrery.searching {
		--pip: var(--galaxy, var(--accent));
		--pip: color-mix(in oklab, var(--galaxy, var(--accent)) 72%, var(--fg));
		--sheen-hi: var(--galaxy, var(--accent));
	}
	/* Your turn: the ring takes the accent, the colour every control you can
	   press already wears. */
	.orrery.waiting {
		--pip: var(--accent);
		--pip: color-mix(in oklab, var(--accent) 80%, var(--fg));
		--sheen-hi: var(--accent);
	}
	.orrery.error {
		--pip: var(--danger);
		--sheen-hi: var(--danger);
	}

	.orb {
		position: relative;
		display: block;
		width: var(--orb-size);
		height: var(--orb-size);
		flex: 0 0 auto;
		/* Room either side for the satellites, whose orbit is wider than the
		   sphere, so one coming round does not overlap the label. */
		margin-inline: calc(var(--orb-size) * 0.22);
		transition:
			opacity var(--dur-2) var(--ease-out),
			transform var(--dur-3) var(--ease-out);
	}
	.idle .orb {
		opacity: 0.6;
	}
	.typing .orb {
		transform: scale(1.06);
	}
	/* Slowed, reddened and sagging: the one pose that should look unwell. */
	.error .orb {
		transform: translateY(calc(var(--orb-size) * 0.06)) scale(0.94);
	}
	.streaming .orb {
		animation: orb-breathe 2.6s ease-in-out infinite;
	}
	.done .orb {
		animation: orb-settle 0.9s var(--ease-out) both;
	}
	@keyframes orb-breathe {
		50% {
			transform: scale(1.06);
		}
	}
	@keyframes orb-settle {
		35% {
			transform: scale(0.84);
		}
		100% {
			transform: scale(1);
		}
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
		width: calc(var(--orb-size) * var(--size) * var(--dot-scale, 1));
		height: calc(var(--orb-size) * var(--size) * var(--dot-scale, 1));
		margin: calc(var(--orb-size) * var(--size) * var(--dot-scale, 1) / -2);
		border-radius: 50%;
		background: var(--pip);
		/* Its own light, rather than the theme's --glow: that one is documented
		   as the hover glow on buttons, a user can switch it off entirely with
		   glowStrength, and a white button glow over blue dots would fight them.
		   The element's own opacity covers the shadow too, so a dot's halo
		   fades as it goes round the back without being animated separately. */
		box-shadow: 0 0 calc(var(--orb-size) * var(--size) * var(--dot-scale, 1) * 0.35) var(--pip);
		opacity: var(--dim);
		animation: orb-orbit calc(var(--swirl) * var(--period)) linear infinite;
		/* Negative, so every dot is already somewhere else on its circle at the
		   first frame. Without it the sphere starts as a single meridian and
		   unwinds, which is visible every time the indicator appears. */
		animation-delay: calc(var(--swirl) * var(--period) * var(--phase) * -1);
		/* The glide between orbit families; see the @property rules above.
		   Eased in and out rather than with the shared ease-out, which spends
		   most of its distance in the first few frames: every dot lurched toward
		   its new orbit at once and then crept the rest of the way. */
		--glide: 1.1s cubic-bezier(0.45, 0.05, 0.35, 1);
		transition:
			--cy var(--glide),
			--rad var(--glide),
			--ux var(--glide),
			--uy var(--glide),
			--uz var(--glide),
			--vx var(--glide),
			--vy var(--glide),
			--vz var(--glide);
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

	/* A running call, out on its own wider orbit and coloured by kind. The
	   label beside it says what is running, so the colour is never the only
	   signal. The near half of the orbit draws larger and brighter than the far
	   half, which is all the depth a dot this size needs. */
	.sat {
		position: absolute;
		left: 50%;
		top: 50%;
		width: calc(var(--orb-size) * 0.14);
		height: calc(var(--orb-size) * 0.14);
		margin: calc(var(--orb-size) * -0.07);
		border-radius: 50%;
		--sat: var(--fg-dim);
		background: var(--sat);
		box-shadow: 0 0 calc(var(--orb-size) * 0.12) var(--sat);
		animation: orb-sat calc(var(--swirl) * 0.9) linear infinite;
		animation-delay: calc(var(--swirl) * 0.9 * var(--sat-phase) * -1);
	}
	.sat.web {
		--sat: var(--accent-2);
	}
	.sat.knowledge {
		--sat: var(--accent);
	}
	.sat.code {
		--sat: var(--success);
	}
	.sat.media {
		--sat: color-mix(in oklab, var(--accent-2) 60%, var(--danger));
	}
	.sat.boards {
		--sat: color-mix(in oklab, var(--accent) 50%, var(--success));
	}
	@keyframes orb-sat {
		0% {
			transform: translate(calc(var(--orb-size) * 0.7200), calc(var(--orb-size) * 0.0000)) scale(1.000);
			opacity: 0.700;
		}
		8.333% {
			transform: translate(calc(var(--orb-size) * 0.6235), calc(var(--orb-size) * 0.1300)) scale(1.100);
			opacity: 0.850;
		}
		16.667% {
			transform: translate(calc(var(--orb-size) * 0.3600), calc(var(--orb-size) * 0.2252)) scale(1.173);
			opacity: 0.960;
		}
		25% {
			transform: translate(calc(var(--orb-size) * 0.0000), calc(var(--orb-size) * 0.2600)) scale(1.200);
			opacity: 1.000;
		}
		33.333% {
			transform: translate(calc(var(--orb-size) * -0.3600), calc(var(--orb-size) * 0.2252)) scale(1.173);
			opacity: 0.960;
		}
		41.667% {
			transform: translate(calc(var(--orb-size) * -0.6235), calc(var(--orb-size) * 0.1300)) scale(1.100);
			opacity: 0.850;
		}
		50% {
			transform: translate(calc(var(--orb-size) * -0.7200), calc(var(--orb-size) * 0.0000)) scale(1.000);
			opacity: 0.700;
		}
		58.333% {
			transform: translate(calc(var(--orb-size) * -0.6235), calc(var(--orb-size) * -0.1300)) scale(0.900);
			opacity: 0.550;
		}
		66.667% {
			transform: translate(calc(var(--orb-size) * -0.3600), calc(var(--orb-size) * -0.2252)) scale(0.827);
			opacity: 0.440;
		}
		75% {
			transform: translate(calc(var(--orb-size) * -0.0000), calc(var(--orb-size) * -0.2600)) scale(0.800);
			opacity: 0.400;
		}
		83.333% {
			transform: translate(calc(var(--orb-size) * 0.3600), calc(var(--orb-size) * -0.2252)) scale(0.827);
			opacity: 0.440;
		}
		91.667% {
			transform: translate(calc(var(--orb-size) * 0.6235), calc(var(--orb-size) * -0.1300)) scale(0.900);
			opacity: 0.550;
		}
		100% {
			transform: translate(calc(var(--orb-size) * 0.7200), calc(var(--orb-size) * -0.0000)) scale(1.000);
			opacity: 0.700;
		}
	}

	.words {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.label {
		color: var(--sheen-base);
		font-size: var(--text-md);
		overflow-wrap: anywhere;
	}
	/* The model's own words about what it is doing. Dim, small and italic so it
	   reads as a status line rather than as the beginning of the reply: it is
	   not kept, and mistaking it for the answer would be worse than not showing
	   it. Held to a readable measure so a long thought does not stretch the
	   pane. */
	.detail {
		max-width: 62ch;
		color: var(--fg-dim);
		font-size: var(--text-sm);
		font-style: italic;
		line-height: 1.45;
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
		.sat {
			animation: none;
			transform: translate(
				calc(var(--orb-size) * 0.72 * cos(var(--sat-phase) * 1turn)),
				calc(var(--orb-size) * 0.26 * sin(var(--sat-phase) * 1turn))
			);
		}
		.streaming .orb,
		.done .orb {
			animation: none;
		}
		.pip,
		.orb {
			transition: none;
		}
		.label {
			background-image: none;
			color: var(--sheen-base);
			animation: none;
		}
	}
</style>
