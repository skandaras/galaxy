# Accessibility

What has been fixed, what is measured automatically, and what is still open.

Contrast figures are WCAG 2.1 ratios computed with `contrastRatio()` in
`src/lib/theme.ts` — the same function the theme editor shows you per colour.
The thresholds that matter here: **4.5:1** for normal-size text, **3:1** for
large text (18.66px bold or 24px plain) and for the boundary of a control you
have to find.

## Fixed, and held by tests

`src/lib/theme.test.ts` asserts all of the following for **every shipped
preset**, so a future palette edit cannot quietly undo them.

### Text colour

`--fg-dim` and `--label` carry `.hint`, `.meta` and `.field-hint` across the
whole interface, at 0.65–0.72rem. That is normal-size text, so the large-text
allowance does not apply to it — and four of the five themes were failing:

| Theme | was | now | worst surface |
|---|---|---|---|
| Galaxy | `#5a627e` | `#717994` | 3.22 → 4.50:1 |
| Nebula | `#71618a` | `#84759b` | 3.45 → 4.57:1 |
| Solar | unchanged | `#8a7c5e` | 4.53:1 |
| Void | `#6a6a6a` | `#797979` | 3.66 → 4.55:1 |
| Paper | `#8a8a96` | `#6e6e79` | 3.05 → 4.50:1 |

Each colour is now checked against **both** `bg` and `bgPane`. That matters more
than it sounds: Paper's page is cream and its panels are white, so for dark text
the page is the harder surface, and measuring only against the panel gave a
figure that passed while the real one did not.

Paper was also below AA on `heading`, `accent` and `danger`, and its primary
buttons — which put `--bg` on `--accent` — sat at 3.87:1. Darkening the accent to
`#3d5ccc` fixed the link colour, the heading colour and the button together;
danger is now `#b8384e`.

### Control boundaries

`--border` was 1.18–1.27:1 against the page in every theme. As a card separator
that is a deliberate whisper; as the outline of a text field it means you cannot
see where the field is, which is a WCAG 1.4.11 failure.

Rather than adding another colour to tune, `controlBorder()` derives one: it
steps `--border` toward `--fg` until it clears 3:1 against `--bg`, and
`themeCss()` applies the result to `input`, `select` and `textarea`. Every theme
— including ones saved before today and any saved later — gets a visible field
border without anyone configuring it.

### Names for controls

Controls identified only by a placeholder now have real labels. Placeholders are
not labels: they vanish on focus, are not announced reliably, and a `<select>`
cannot have one at all.

- **Admin → Providers**, the whole Add-provider form — visible captions, since
  four adjacent boxes distinguished only by grey hint text is a usability
  problem as much as an accessibility one
- **Admin → Usage**, the period select — it previously had no accessible name of
  any kind
- **Admin → Models**, the filter box; **Settings → Theme**, the preset name;
  **Alignment**, the journal composer's title/body/tags and the tension row's
  two selects and note — all given names via the `.sr-only` utility, so the
  layout is unchanged

## Open — worth doing next

Not fixed here, in rough priority order.

### 1. Small text

112 `font-size` declarations sit at or below 0.7rem, the smallest 0.58rem — about
9px at the default root size. Repairing the colour raised the floor on contrast
but not on size, and the two compound: dim text that is both faint and tiny is
the app's most common readability problem.

This got marginally worse with the font change. Quicksand has a smaller x-height
than the monospace it replaced, so the same declared size renders visually
smaller. A floor of about 0.75rem for anything carrying real content, with the
sub-0.7rem sizes reserved for uppercase tracking labels, would settle it.

### 2. Invisible keyboard focus

Nine rules remove the focus outline without putting anything back, so a keyboard
user loses their place entirely:

`chat/+page.svelte:1198,1427` · `library/+page.svelte:382,471,490` ·
`code/+page.svelte:1193` · `boards/CardDetail.svelte:301` ·
`PaneResizer.svelte:47`

Each wants a `:focus-visible` style — a 2px `--accent` outline with a small
offset would match the interface and cost nothing.

(`AlignmentConstellation.svelte:124` also sets `outline: none`, but it does
restyle `:focus-visible`, so it is not in the list.)

### 3. Disabled controls

`opacity: 0.5` on a disabled button drops its label below AA. Disabled controls
are exempt from the contrast requirement, so this is a judgement call rather than
a violation — but at these text sizes it makes "why is this greyed out?"
genuinely hard to read. A dedicated disabled colour would read better than
fading the text.

### 4. Smaller things

- Touch targets: several buttons are around 24–28px tall, under the 44px that
  makes a control comfortable on a phone. The interface is used on mobile.
- A few tables use `<td>` in the header row rather than `<th>`, so their columns
  are not announced.
- Heading levels jump in places (a `<h3>` with no `<h2>` above it), which makes
  the document outline harder to navigate by heading.

## Checking your own theme

The colour grid in **Settings → Theme** shows a live contrast ratio and grade for
every colour, measured against the surface it is actually used on. Aim for
**AA** or better on anything you have to read; `AA large only` is honest for a
heading colour and not good enough for body text.
