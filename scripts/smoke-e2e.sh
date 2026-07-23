#!/bin/bash
# End-to-end smoke against the built app and the mock provider. Run by CI on
# every build (the promotion gate): if this fails, the :dev image is not cut.
#   Usage: bash scripts/smoke-e2e.sh   (requires `npm run build` first)
set -euo pipefail
cd "$(dirname "$0")/.."

DATA=$(mktemp -d)
MOCK_PORT=39900
APP_PORT=39901
FAIL=0

node scripts/mock-provider.mjs $MOCK_PORT &
MOCK_PID=$!
AUTH_MODE=dev DEV_USER=smoke DATA_DIR=$DATA PORT=$APP_PORT CODING_EXECUTOR=local node build &
APP_PID=$!
trap 'kill $MOCK_PID $APP_PID 2>/dev/null; rm -rf $DATA' EXIT
sleep 3

api() { curl -sf -H 'content-type: application/json' "$@"; }
B=http://127.0.0.1:$APP_PORT
jqn() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
check() { # check <label> <actual> <expected-substring>
  if [[ "$2" == *"$3"* ]]; then echo "ok: $1"; else echo "FAIL: $1 — got: $2"; FAIL=1; fi
}

check "healthz" "$(curl -s $B/healthz)" '"status":"ok"'

PROV_ID=$(api -X POST $B/api/admin/providers -d "{\"kind\":\"openai-compatible\",\"name\":\"mock\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/v1\"}" | jqn .id)
api -X POST $B/api/admin/providers/$PROV_ID/sync > /dev/null
MODEL_ID=$(api $B/api/admin/models | jqn '[0].id')
api -X PATCH $B/api/admin/models/$MODEL_ID -d '{"enabled":true}' > /dev/null
api -X PUT $B/api/admin/settings -d "{\"key\":\"websearch\",\"value\":{\"provider\":\"searxng\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/searxng\"}}" > /dev/null
echo "ok: provider + model + search wired"

# chat turn with tool round trip
CHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
JOB=$(api -X POST $B/api/chats/$CHAT/messages -d '{"content":"Please search for galaxy news"}' | jqn .jobId)
STREAM=$(curl -sN --max-time 30 $B/api/jobs/$JOB/stream)
check "chat stream tool call" "$STREAM" '"type":"tool","name":"web_search","status":"ok"'
check "chat stream completes" "$STREAM" '"type":"done"'

# hidden chat leaves no trace
HID=$(api -X POST $B/api/chats -d '{"hidden":true}' | jqn .id)
HJOB=$(api -X POST $B/api/chats/$HID/messages -d '{"content":"secret smoke","webSearch":false}' | jqn .jobId)
curl -sN --max-time 20 $B/api/jobs/$HJOB/stream > /dev/null
LEAK=$(node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database('$DATA/galaxy.db');
console.log(db.prepare(\"SELECT COUNT(*) c FROM messages WHERE content LIKE '%secret smoke%'\").get().c);")
check "hidden chat not persisted" "leak=$LEAK" "leak=0"

# deep research pipeline
RCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
RJOB=$(api -X POST $B/api/chats/$RCHAT/messages -d '{"content":"How do nebulae form?","deepResearch":true}' | jqn .jobId)
RSTREAM=$(curl -sN --max-time 60 $B/api/jobs/$RJOB/stream)
check "research stages" "$RSTREAM" '"type":"stage","name":"synthesising"'
check "research cites evidence" "$RSTREAM" 'FACT-42 confirmed'

# coding session against a local repo
ORIGIN=$DATA/origin
git init -q -b main "$ORIGIN" && echo "# origin" > "$ORIGIN/README.md"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" -c user.email=t@t -c user.name=t commit -qm init
git clone -q --bare "$ORIGIN" "$ORIGIN.git"
api -X PUT $B/api/admin/task-configs -d "{\"task\":\"coding\",\"primaryModelId\":\"$MODEL_ID\"}" > /dev/null
SID=$(api -X POST $B/api/code/sessions -d "{\"repoUrl\":\"$ORIGIN.git\",\"repoName\":\"local/origin\",\"mode\":\"implement\"}" | jqn .chatId)
CJOB=$(api -X POST $B/api/code/sessions/$SID/messages -d '{"content":"Update the README"}' | jqn .jobId)
curl -sN --max-time 90 $B/api/jobs/$CJOB/stream > /dev/null
check "coding pushed to origin" "$(git -C $ORIGIN.git log --all --oneline)" "Add project description"

# library + skills + memory
api -X POST $B/api/library -d '{"title":"Smoke Doc","content":"The smoke marker is LANTERN-9"}' > /dev/null
check "library search" "$(api "$B/api/library?q=LANTERN")" 'Smoke Doc'
api -X POST $B/api/skills -d '{"name":"smoke-skill","description":"smoke","body":"body"}' > /dev/null
MEM=$(api -X POST $B/api/admin/memory/run)
check "memory run" "$MEM" '"ran":true'

# pages render
for p in /chat /code /library /settings /admin /observatory; do
  code=$(curl -s -o /dev/null -w '%{http_code}' $B$p)
  check "page $p" "$code" "200"
done
check "manifest served" "$(curl -s -o /dev/null -w '%{http_code}' $B/manifest.webmanifest)" "200"

if [ "$FAIL" -ne 0 ]; then echo "SMOKE FAILED"; exit 1; fi
echo "SMOKE PASSED"
