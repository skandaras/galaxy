<script lang="ts">
	const art = String.raw`
                    .                *                   .        ·
        ·                   .                 ·                        .
              *        .          · ∙ ˚ ∙ ·        .         *
   .                        · ∙ ˚ * ˚ ˚ * ˚ ∙ ·                    .
              .        · ∙ ˚ ˚ · ∙ ∙ ∙ ∙ · ˚ ˚ ∙ ·        ·
     ·           . ∙ ˚ * ∙ · ˚ ∙ * ∙ ∙ * ∙ ˚ · ∙ * ˚ ∙ .
                · ∙ ˚ ∙ · ∙ ˚ ˚ ∙ · ✦ · ∙ ˚ ˚ ∙ · ∙ ˚ ∙ ·           .
   *              . ∙ ˚ * ∙ · ˚ ∙ * ∙ ∙ * ∙ ˚ · ∙ * ˚ ∙ .
              ·        · ∙ ˚ ˚ · ∙ ∙ ∙ ∙ · ˚ ˚ ∙ ·        .
   .                        · ∙ ˚ * ˚ ˚ * ˚ ∙ ·                 ·
              .        *          · ∙ ˚ ∙ ·         .
        ·                   .                  ·             *        .
                    *                 .                   ·
   .        ·               .                    .               ·
                                          ·                              *`;
</script>

<pre class="backdrop" aria-hidden="true">{art}
{art}</pre>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		margin: 0;
		z-index: 0;
		overflow: hidden;
		color: var(--accent);
		opacity: 0.05;
		font-size: 0.85rem;
		line-height: 1.6;
		pointer-events: none;
		user-select: none;
		white-space: pre;
	}
</style>
