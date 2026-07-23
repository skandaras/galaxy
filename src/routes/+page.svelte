<script lang="ts">
	// Placeholder ambient galaxy — replaced by the themeable renderer in M7.
	const galaxy = String.raw`
                 .      *          .
        *              .        ·         .
             ·   . ·∙˚*˚∙· .          *
   .           ·∙˚ ˚ ∙ ∙ ˚ ˚∙·    .
          . ·∙ ˚ ∙ · ✦ · ∙ ˚ ∙· .          ·
    ·       ·∙˚ ∙ · ˚ ˚ · ∙ ˚∙·       .
             ·   ' ·∙˚∙· '   ·    *
        .          ·        .           .
   *          .        ·          *        .`;
</script>

<div class="welcome">
	<pre class="galaxy" aria-hidden="true">{galaxy}</pre>
	<p class="tagline">the machinery is warming up</p>
</div>

<style>
	.welcome {
		text-align: center;
	}
	.galaxy {
		color: var(--fg-dim);
		font-size: 0.7rem;
		line-height: 1.2;
		user-select: none;
	}
	.tagline {
		color: var(--fg-dim);
		font-size: 0.8rem;
		letter-spacing: 0.2em;
	}
</style>
