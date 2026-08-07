# Galaxy on mobile

Galaxy is a **progressive web app**: it is responsive down to phone widths and
installs to a home screen with its own icon and no browser chrome. No app store,
no build step, nothing extra to deploy — it works as soon as the site is served
over HTTPS.

## Installing to a home screen

**iPhone / iPad (Safari).** Open the site → Share → **Add to Home Screen**. Safari
is the only iOS browser that can install a web app; Chrome/Firefox on iOS cannot.

**Android (Chrome/Edge).** Open the site → you should get an "Install app"
prompt, or use ⋮ → **Install app** / **Add to Home screen**.

**Desktop (Chrome/Edge).** An install icon appears in the address bar, or
⋮ → **Cast, save and share** → **Install page as app**.

Installed, it launches standalone (no address bar), starts on `/chat`, and picks
up the galaxy icon. Requirements are already met by the deployment: HTTPS, a
web manifest, and a registered service worker.

> **Authelia note.** On iOS an installed web app keeps a **separate cookie jar
> from Safari**, so the first launch will ask you to sign in to Authelia again
> even though you are signed in in the browser. That is expected, and it is a
> one-off per install as long as your Authelia session cookie is long-lived.
> If the app logs you out constantly, raise the session/remember-me duration in
> your Authelia config.

## Notifications

Galaxy pushes to your phone only when something is genuinely holding work up.
Today that means one thing: an agent has stopped mid-run to ask you a question,
and gives up after ten minutes if nobody answers. Cards, shared boards and
failed runs appear in the **Alerts** bell in the sidebar, but they will not
buzz you.

Two steps, in order:

1. **An admin generates the keys once** for the whole instance, in
   **Admin → Settings → Push**. Regenerating them later signs out every
   registered device, so do it once and leave it alone.
2. **Each person enables it per device**, in **Settings → Notifications**.
   Your phone and your laptop are separate registrations, and the browser only
   allows the permission prompt from a real button press — which is why it is a
   button rather than something that happens on first load.

> **iPhone note.** Safari only delivers Web Push to a web app **installed to
> the home screen** — the Add to Home Screen step above is a prerequisite, not
> a nicety. Open Galaxy from the home-screen icon, then enable notifications
> from inside it. Enabling in Safari itself will not work.

Android and desktop Chrome/Edge do not need the install, though it still helps.

## What works offline

Deliberately little. The service worker caches only the immutable build assets
(JS/CSS/icons), so the shell loads instantly and survives a flaky connection.
Everything meaningful — chats, models, the Library, streaming responses — is a
live API call and needs the network. There is no offline queue and no cached
conversation data; a self-hosted AI workspace that silently served stale state
would be worse than one that says it's offline.

Server-sent events (streaming replies, the Observatory feed) are deliberately
not intercepted by the service worker, so streaming behaves identically in the
installed app and the browser.

## What adapts on small screens

- The left rail collapses into a sticky top bar; the chat/session/document lists
  become a slide-over drawer behind the ☰ button.
- The composer respects the iOS home-indicator inset; the top bar respects the
  notch (`viewport-fit=cover` + safe-area insets).
- Admin tables scroll horizontally inside their panel instead of stretching the
  page, and multi-column forms collapse to one column.
- The docked Observatory feed is hidden below 720px — it needs vertical room a
  top bar doesn't have. The full view at `/observatory` remains available and is
  itself responsive.
- Long model lists page in with **Show more / Show all** rather than rendering
  thousands of rows on a phone.

Because a coding session streams a lot of tool output, phones are best for chat,
research and reviewing/approving plans; driving a long implement run is more
comfortable on a desktop.

## Wrapping it as an installable APK

Not required — the PWA install above already gives an app-like launcher entry.
If you specifically want a `.apk` to sideload or put in a private store:

- **PWABuilder** (easiest): visit <https://www.pwabuilder.com>, enter your
  Galaxy URL, and download the generated Android package. It produces a **Trusted
  Web Activity** — a thin native shell around the same PWA, so it stays in sync
  with your deployment automatically.
- **Bubblewrap** (CLI equivalent): `npx @bubblewrap/cli init --manifest
  https://your-host/manifest.webmanifest` then `npx @bubblewrap/cli build`.
- **Capacitor** if you ever want native APIs (push, biometrics, native file
  pickers) — a bigger commitment, since it means shipping and updating a real
  native project.

Two caveats for the TWA route: an unsigned/sideloaded APK needs "install from
unknown sources", and Digital Asset Links verification (for hiding the URL bar)
requires serving `/.well-known/assetlinks.json` from your domain — PWABuilder
generates that file for you. Without it the app still works, it just shows a
thin address bar on first launch.

Push notifications for finished jobs are on the backlog (see PLAN.md); they need
a VAPID key pair and a subscription store, and iOS only supports web push for
apps installed to the home screen.
