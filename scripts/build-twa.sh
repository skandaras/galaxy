#!/usr/bin/env bash
#
# Build the Android package: a Trusted Web Activity around this instance.
#
#   bash scripts/build-twa.sh [--origin https://ai.example.com]
#
# The APK contains no web code. It is a launcher icon, a name, and a URL — the
# site is rendered by the browser already on the phone, so deploying the site
# updates the app and this only needs re-running when the shell itself changes.
#
# Everything runs inside a container because Bubblewrap wants a JDK and the
# Android SDK, and neither is worth installing on a laptop to build one APK a
# year. The named volume keeps that ~1 GB between runs; the first run is slow.
#
# Two things here are not obvious:
#
#   - `bubblewrap init --manifest https://your-host/manifest.webmanifest` does
#     not work on a Galaxy instance. Authelia sits in front of the whole domain
#     and answers the fetch with a redirect to a login page, so Bubblewrap
#     parses an HTML sign-in form as the manifest and fails. The manifest is
#     served from this checkout instead and the host is patched in afterwards.
#
#   - The signing key is what ties the APK to the domain. Its fingerprint has
#     to be served at /.well-known/assetlinks.json or the app launches with a
#     browser address bar drawn over it, so the last thing printed here is the
#     line to paste into .env.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Pinned: a TWA shell that silently changes shape between builds is a debugging
# session nobody wants. Bump deliberately.
BUBBLEWRAP_VERSION="1.24.1"
NODE_IMAGE="node:22"
VOLUME="galaxy-bubblewrap"
PROJECT_DIR="twa"
PORT=8724

ORIGIN_ARG=""
while [ $# -gt 0 ]; do
	case "$1" in
		--origin) ORIGIN_ARG="$2"; shift 2 ;;
		-h|--help) sed -n '2,30p' "$0"; exit 0 ;;
		*) echo "Unknown argument: $1" >&2; exit 2 ;;
	esac
done

if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.env
	set +a
fi
ORIGIN="${ORIGIN_ARG:-${ORIGIN:-}}"

if [ -z "$ORIGIN" ]; then
	echo "Set ORIGIN in .env or pass --origin https://ai.example.com" >&2
	exit 1
fi

HOST="${ORIGIN#*://}"
HOST="${HOST%%/*}"
HOST="${HOST%%:*}"

# Reverse the host into a package id, the Android convention. Hyphens are not
# legal in a package segment and a segment may not start with a digit.
derive_package_id() {
	local reversed=""
	local IFS='.'
	# shellcheck disable=SC2206
	local parts=($HOST)
	for part in "${parts[@]}"; do
		part="${part//-/_}"
		case "$part" in [0-9]*) part="_$part" ;; esac
		reversed="$part${reversed:+.}$reversed"
	done
	echo "$reversed.galaxy"
}
PACKAGE_ID="${TWA_PACKAGE_ID:-$(derive_package_id)}"

echo "Origin:     $ORIGIN"
echo "Package id: $PACKAGE_ID"
echo

if ! docker info >/dev/null 2>&1; then
	echo "Docker is not running — this script builds inside a container." >&2
	exit 1
fi

mkdir -p "$PROJECT_DIR"

TTY_FLAGS="-i"
[ -t 0 ] && TTY_FLAGS="-it"

# Passwords are prompted for if these are unset, which is the right default for
# a key that signs something you install on your own phone.
PASS_ENV=()
[ -n "${BUBBLEWRAP_KEYSTORE_PASSWORD:-}" ] && PASS_ENV+=(-e "BUBBLEWRAP_KEYSTORE_PASSWORD")
[ -n "${BUBBLEWRAP_KEY_PASSWORD:-}" ] && PASS_ENV+=(-e "BUBBLEWRAP_KEY_PASSWORD")

docker run --rm $TTY_FLAGS \
	-v "$VOLUME:/root/.bubblewrap" \
	-v "$REPO_ROOT/static:/static:ro" \
	-v "$REPO_ROOT/$PROJECT_DIR:/work" \
	-e "ORIGIN=$ORIGIN" \
	-e "HOST=$HOST" \
	-e "PACKAGE_ID=$PACKAGE_ID" \
	-e "PORT=$PORT" \
	-e "BUBBLEWRAP_VERSION=$BUBBLEWRAP_VERSION" \
	"${PASS_ENV[@]}" \
	-w /work \
	"$NODE_IMAGE" bash -euo pipefail -c '
	npm install -g "@bubblewrap/cli@${BUBBLEWRAP_VERSION}" >/dev/null 2>&1

	# Serve the checkout every request Bubblewrap makes for the manifest and
	# its icons, so nothing has to reach the deployed instance and get bounced
	# to a login page.
	node -e "
		const http = require(\"http\"), fs = require(\"fs\"), path = require(\"path\");
		const types = { \".webmanifest\": \"application/manifest+json\", \".png\": \"image/png\", \".svg\": \"image/svg+xml\" };
		http.createServer((req, res) => {
			const file = path.join(\"/static\", decodeURIComponent(req.url.split(\"?\")[0]));
			if (!file.startsWith(\"/static/\") || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
				res.writeHead(404); return res.end();
			}
			res.writeHead(200, { \"content-type\": types[path.extname(file)] || \"application/octet-stream\" });
			fs.createReadStream(file).pipe(res);
		}).listen(process.env.PORT);
	" &
	SERVER=$!
	trap "kill $SERVER 2>/dev/null || true" EXIT
	sleep 1

	FRESH=0
	if [ ! -f twa-manifest.json ]; then
		FRESH=1
		echo "--- bubblewrap init (answer its questions; the defaults are sane) ---"
		bubblewrap init --manifest "http://127.0.0.1:${PORT}/manifest.webmanifest" --directory .
	else
		echo "--- twa-manifest.json exists; edit it to change the shell, then re-run ---"
	fi

	# init read the manifest off localhost, so every URL in it says 127.0.0.1.
	# Re-applied on every run rather than only after init, so that changing
	# ORIGIN and re-running actually moves the app to the new host.
	FRESH="$FRESH" node -e "
		const fs = require(\"fs\");
		const m = JSON.parse(fs.readFileSync(\"twa-manifest.json\", \"utf8\"));
		m.host = process.env.HOST;
		m.startUrl = \"/chat\";
		m.webManifestUrl = process.env.ORIGIN + \"/manifest.webmanifest\";
		m.packageId = process.env.PACKAGE_ID;

		// The icons deliberately stay on the local server. Pointing them at the
		// deployment would mean every \`bubblewrap update\` fetching them through
		// Authelia, which answers with a login page — so the build would either
		// fail or bake a screenshot of a sign-in form into the launcher icon.
		const local = \"http://127.0.0.1:\" + process.env.PORT;
		if (m.iconUrl) m.iconUrl = local + new URL(m.iconUrl).pathname;
		if (m.maskableIconUrl) m.maskableIconUrl = local + new URL(m.maskableIconUrl).pathname;

		// Only on the first build, so that turning one of these off by hand
		// stays off. Web push is the whole reason the phone is worth notifying:
		// without it the service worker still receives and Android shows nothing.
		if (process.env.FRESH === \"1\") {
			m.name = \"Galaxy\";
			m.launcherName = \"Galaxy\";
			m.enableNotifications = true;
		}
		fs.writeFileSync(\"twa-manifest.json\", JSON.stringify(m, null, 2));
	"

	echo "--- rebuilding the project against $ORIGIN ---"
	bubblewrap update --manifest ./twa-manifest.json

	# Validation Lighthouses the live URL, which is behind Authelia and scores
	# zero. It is checking the site, which CI already does.
	bubblewrap build --skipPwaValidation

	echo
	echo "=== Signing key fingerprint ==="
	bubblewrap fingerprint list
'

echo
echo "APK: $PROJECT_DIR/app-release-signed.apk"
echo
echo "Put the SHA-256 fingerprint printed above into .env, redeploy, and the"
echo "address bar goes away on next launch:"
echo
echo "  TWA_PACKAGE_ID=$PACKAGE_ID"
echo "  TWA_FINGERPRINTS=<SHA-256 from above>"
echo
echo "Then: adb install $PROJECT_DIR/app-release-signed.apk"
