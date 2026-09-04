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

> **De-Googled Android.** On GrapheneOS, CalyxOS and similar, "Install app"
> gives you a shortcut rather than an app. The signed package Chrome normally
> installs — a WebAPK — is generated on Google's servers, so Vanadium does not
> support it; Firefox has no minting server it trusts either and behaves the
> same. If you want a real launcher entry on one of these, build the APK below.
> That is the only route, not an optional extra.

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

> **De-Googled Android note.** Web push on Android is delivered over Firebase
> Cloud Messaging, which is part of Google Play services. Chromium browsers
> need it, and so does Firefox — its Android build uses FCM as the transport
> even though the push service itself is Mozilla's. So on a device with no
> Google services at all, **no browser can receive these notifications**. On
> GrapheneOS, sandboxed Google Play from the GrapheneOS App Store restores
> them; give it unrestricted battery access or they arrive late or not at all.
> Without it, the **Alerts** bell still works while Galaxy is open — a
> transport that needs nothing from Google (UnifiedPush/ntfy) is not built.

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

- The left rail collapses into a sticky top bar that scrolls sideways, so every
  destination stays reachable without a menu.
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

`scripts/build-twa.sh` produces a **Trusted Web Activity**: an APK that is a
launcher icon, a name and a URL. It contains no web code — the site is rendered
by a browser already on the phone — so deploying Galaxy updates the app, and
this only needs re-running when the shell itself changes.

Everything runs in a container, so you need Docker but no JDK and no Android
SDK. The first run downloads ~1 GB of Android tooling into a named volume and
is slow; later runs are not.

```sh
npm run icons                     # only if you changed static/icon*.svg
bash scripts/build-twa.sh         # reads ORIGIN from .env, or pass --origin
```

The first run walks you through `bubblewrap init` — the defaults are right, and
it offers to create a signing key. **Back that keystore up.** It lives in the
`galaxy-bubblewrap` docker volume, and losing it means you can never update the
installed app in place, only uninstall and start again.

When it finishes it prints the key's SHA-256 fingerprint. Put that and the
package id in your `.env`:

```sh
TWA_PACKAGE_ID=net.starbasehome.ai.galaxy
TWA_FINGERPRINTS=A1:B2:C3:...
```

Redeploy, then check the fingerprint is readable **signed out**, from outside
your network — this is the step that goes wrong:

```sh
curl -s https://ai.example.com/.well-known/assetlinks.json
```

If that returns a login page instead of JSON, your reverse proxy is sending it
to Authelia; `docs/INSTALL.md` §3 has the bypass rule. Galaxy serves this route
without auth on purpose, but it never sees the request until the proxy lets it
through.

Then install it:

```sh
adb install twa/app-release-signed.apk
```

Sideloading needs "install from unknown sources" for whatever app is doing the
installing.

### What to expect on first launch

**No address bar** means Digital Asset Links verified and you are done.

**An address bar** means it did not, and there are three causes in order of
likelihood: the fingerprint in `.env` does not match the APK you installed; the
proxy is not serving `/.well-known/assetlinks.json` (check with the `curl`
above); or the browser providing the shell does not implement TWA at all.

That last one is a real possibility on GrapheneOS and cannot be looked up —
Vanadium's lack of *WebAPK* support is documented and certain, but its *TWA*
support is not written down either way. TWA is ordinary client-side Chromium
plumbing with nothing of Google's in it, so it very likely works. If you have
ruled out the first two causes, edit `twa/twa-manifest.json`:

```json
"fallbackType": "webview"
```

and re-run the script. The app then renders in a full-screen Android WebView
instead: no address bar, but it keeps its own cookie jar (one more Authelia
sign-in) and **no web push**, because Android's WebView has no Push API. Your
hand edits to that file survive re-runs; the host and package id are re-applied
from `.env` each time.

### Things that are true either way

- **The app has its own sign-in.** It renders in whichever browser provides the
  shell — Vanadium, say — so it uses that browser's cookies, not the ones in
  the browser you actually read the web in. Expect one Authelia sign-in inside
  the app. It is a one-off if your Authelia session is long-lived.
- **Session expiry briefly shows a browser.** Authelia lives on another domain,
  which is outside the app's verified scope, so the login appears in a Custom
  Tab with a visible URL and then hands back. It works; it just looks abrupt.
- **Firefox is not involved.** TWA is a Chromium protocol and Firefox has never
  implemented it. Which browser you prefer for browsing makes no difference to
  the app.

### Alternatives

- **PWABuilder** — <https://www.pwabuilder.com> generates the same kind of
  package in a browser with no local tooling. It cannot read a manifest behind
  Authelia, so it only suits an instance you can expose.
- **Capacitor** — only if you want native APIs (biometrics, native file
  pickers). It means a real Android project to maintain and update, which is a
  much larger commitment than a shell that never changes.
