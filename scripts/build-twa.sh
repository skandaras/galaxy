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
#     served from this checkout instead, over --add-host so that the real
#     hostname resolves to the local server for the length of the build. Init
#     derives its suggested answers from that URL's host, and every one of them
#     is validated, so the host it sees has to be the real one: an IP and port
#     produce a Domain that domainToASCII() rejects and a package id whose
#     reversed sections start with digits, and the interview dead-ends on both.
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
# Port 80 so the manifest URL carries no port at all. Init's defaults are
# derived from that URL's host and then validated: domainToASCII() returns ""
# for a host with a port, and generatePackageId() reverses the host into
# sections that must each begin with a letter. Any port breaks the first; the
# hostname carries the second. Nothing is published out of the container and it
# runs as root, so binding a privileged port here costs nothing.
PORT=80

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
	--add-host "$HOST:127.0.0.1" \
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
		echo "--- bubblewrap init ---"
		echo "Press Enter to accept every default until the signing key."
		echo "Its certificate — name, organisational unit, organisation, and a"
		echo "two-letter country — has no defaults and rejects blanks. Nothing"
		echo "verifies what you put there. Then you choose two passwords,"
		echo "keystore then key: save both, they cannot be recovered."
		echo
		echo "If it ever refuses a default, these are the right answers:"
		echo "  Domain:         ${HOST}"
		echo "  Application ID: ${PACKAGE_ID}"
		echo
		bubblewrap init --manifest "http://${HOST}/manifest.webmanifest" --directory .
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
		m.packageId = process.env.PACKAGE_ID;

		// The icons and the manifest deliberately stay on the local server.
		// Pointing them at the deployment would mean every \`bubblewrap update\`
		// fetching them through Authelia, which answers with a login page — so
		// the build would either fail or bake a screenshot of a sign-in form
		// into the launcher icon. Generation copies the manifest contents into
		// the APK and never reads the URL again, so a local one loses nothing:
		// the app targets the host and startUrl fields above, not this.
		const local = \"http://127.0.0.1:\" + process.env.PORT;
		m.webManifestUrl = local + \"/manifest.webmanifest\";
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
	echo "=== Signing key ==="

	# NOT `bubblewrap fingerprint list`: that prints the fingerprints recorded
	# in twa-manifest.json, and nothing ever writes one there — creating a key
	# does not, and neither does build — so on a fresh project it prints an
	# empty list where the one value this whole exercise needs should be. Ask
	# the keystore directly, with the JDK bubblewrap installed for itself.
	KEY_PATH=$(node -p "JSON.parse(require(\"fs\").readFileSync(\"twa-manifest.json\",\"utf8\")).signingKey.path")
	KEY_ALIAS=$(node -p "JSON.parse(require(\"fs\").readFileSync(\"twa-manifest.json\",\"utf8\")).signingKey.alias")

	# init resolves that path against the project directory, so it is absolute
	# and container-side: /work is $PROJECT_DIR out on the host.
	KEY_ON_HOST="twa/${KEY_PATH#/work/}"
	echo "File:   $KEY_ON_HOST   <- back this up"

	KEYTOOL=$(find /root/.bubblewrap -name keytool -type f | head -1)
	if [ -z "${BUBBLEWRAP_KEYSTORE_PASSWORD:-}" ]; then
		printf "Keystore password, to read the fingerprint: "
		read -rs BUBBLEWRAP_KEYSTORE_PASSWORD || true
		echo
	fi
	SHA=$("$KEYTOOL" -list -v -keystore "$KEY_PATH" -alias "$KEY_ALIAS" \
		-storepass "$BUBBLEWRAP_KEYSTORE_PASSWORD" 2>/dev/null \
		| grep -m1 "SHA256:" | sed "s/.*SHA256: *//" | tr -d "\r") || true

	echo
	if [ -n "$SHA" ]; then
		echo "SHA256: $SHA"
		echo
		echo "Add these two lines to the .env beside docker-compose.yml on the"
		echo "server, then: docker compose up -d"
		echo
		echo "  TWA_PACKAGE_ID=$PACKAGE_ID"
		echo "  TWA_FINGERPRINTS=$SHA"
	else
		echo "SHA256: could not be read — wrong password, most likely."
		echo "Nothing is lost; read it whenever you like with:"
		echo
		echo "  keytool -list -v -keystore $KEY_ON_HOST -alias $KEY_ALIAS"
		echo
		echo "and pair it with TWA_PACKAGE_ID=$PACKAGE_ID"
	fi
'

echo
echo "APK: $PROJECT_DIR/app-release-signed.apk"
echo
echo "Then: adb install $PROJECT_DIR/app-release-signed.apk"
echo
echo "And back up the signing key printed above, with the passwords you chose,"
echo "somewhere outside this checkout. $PROJECT_DIR/ is gitignored, so nothing else"
echo "is keeping it — lose it and the installed app can never be updated in place,"
echo "only uninstalled and replaced."
