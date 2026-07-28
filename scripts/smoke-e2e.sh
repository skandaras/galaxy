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
# ALLOW_PRIVATE_RESEARCH_FETCH: the mock "web" lives on 127.0.0.1, which the
# SSRF guard rightly blocks in production.
AUTH_MODE=dev DEV_USER=smoke DATA_DIR=$DATA PORT=$APP_PORT CODING_EXECUTOR=local ALLOW_PRIVATE_RESEARCH_FETCH=1 node build &
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

# A blocked provider must surface a visible error, never a silent empty list.
api -X PUT $B/api/admin/settings -d "{\"key\":\"websearch\",\"value\":{\"provider\":\"searxng\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/searxng-blocked\",\"fallbackProvider\":\"none\"}}" > /dev/null
BLOCKED=$(api -X POST $B/api/admin/settings/test-search)
check "blocked provider reports failure" "$BLOCKED" '"ok":false'
check "blocked provider gives a reason" "$BLOCKED" 'expected JSON, got HTML'

# Restore a working provider and confirm the same probe reports success.
# (Failover between two providers is covered by unit tests: both providers share
# one baseUrl setting, so it can't be staged meaningfully against the mock.)
api -X PUT $B/api/admin/settings -d "{\"key\":\"websearch\",\"value\":{\"provider\":\"searxng\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/searxng\",\"fallbackProvider\":\"none\"}}" > /dev/null
WORKING=$(api -X POST $B/api/admin/settings/test-search)
check "working provider reports results" "$WORKING" '"ok":true'

# Stopping a run: cancel mid-stream, keep the partial reply, and — the part
# worth guarding — do NOT treat the abort as a retryable failure and fail over.
CCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
CJOB=$(api -X POST $B/api/chats/$CCHAT/messages -d '{"content":"SLOW-STREAM please","webSearch":false}' | jqn .jobId)
# Note: wait on this PID specifically — a bare `wait` would also wait on the
# mock provider and the app, which run for the whole script.
( sleep 1.5; curl -sf -X POST $B/api/jobs/$CJOB/cancel > /dev/null ) &
CANCEL_PID=$!
CSTREAM=$(curl -sN --max-time 30 $B/api/jobs/$CJOB/stream)
wait $CANCEL_PID
check "cancelled run ends with done" "$CSTREAM" '"type":"done"'
check "cancelled run is flagged stopped" "$CSTREAM" '"stopped":true'
check "cancelled run kept its partial text" "$CSTREAM" '"text":"word1 "'
CMETA=$(printf '%s' "$CSTREAM" | grep -c '"type":"meta"' || true)
check "cancelled run did not fail over" "$CMETA" '1'
CAFTER=$(api $B/api/chats/$CCHAT)
check "partial reply was saved" "$CAFTER" '"role":"assistant"'
check "no job left running" "$CAFTER" '"runningJobId":null'
check "cancelling again is a no-op" "$(api -X POST $B/api/jobs/$CJOB/cancel)" '"cancelled":false'
check "cancelling an unknown job 404s" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/jobs/nope/cancel)" '404'

# A chat remembers the model it was last used with, so reopening it doesn't
# inherit whatever the composer happened to be set to.
MCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
check "new chat has no model yet" "$(api $B/api/chats/$MCHAT | jqn .chat.modelId)" 'null'
MJOB=$(api -X POST $B/api/chats/$MCHAT/messages -d "{\"content\":\"hello\",\"modelId\":\"$MODEL_ID\",\"webSearch\":false}" | jqn .jobId)
curl -sN --max-time 30 $B/api/jobs/$MJOB/stream > /dev/null
check "chat remembered the model it used" "$(api $B/api/chats/$MCHAT | jqn .chat.modelId)" "$MODEL_ID"

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

# Web search inside a coding session: on by default, and actually withheld when
# the composer toggle is off.
WJOB=$(api -X POST $B/api/code/sessions/$SID/messages -d '{"content":"Please search for galaxy news"}' | jqn .jobId)
WSTREAM=$(curl -sN --max-time 60 $B/api/jobs/$WJOB/stream)
check "coding can web search" "$WSTREAM" '"name":"web_search","status":"ok"'

OJOB=$(api -X POST $B/api/code/sessions/$SID/messages -d '{"content":"Please search for galaxy news","webSearch":false}' | jqn .jobId)
OSTREAM=$(curl -sN --max-time 60 $B/api/jobs/$OJOB/stream)
# The mock calls web_search whenever any tools are offered, so the loop
# reporting it as unknown is what proves the tool was genuinely withheld.
check "coding honours the web search toggle" "$OSTREAM" 'unknown tool'

# The nav cost bar reads this; it must be available to a non-admin user, since
# the cap blocks everyone's turns.
BUD=$(api $B/api/usage/budget)
check "budget status readable" "$BUD" '"spentUsd"'
check "budget status reports pricing gaps" "$BUD" '"unpricedCalls"'

# library + skills + memory
api -X POST $B/api/library -d '{"title":"Smoke Doc","content":"The smoke marker is LANTERN-9"}' > /dev/null
check "library search" "$(api "$B/api/library?q=LANTERN")" 'Smoke Doc'
api -X POST $B/api/skills -d '{"name":"smoke-skill","description":"smoke","body":"body"}' > /dev/null
MEM=$(api -X POST $B/api/memory/run)
check "memory run" "$MEM" '"ran":true'

# pages render
for p in /chat /code /library /settings /admin /observatory; do
  code=$(curl -s -o /dev/null -w '%{http_code}' $B$p)
  check "page $p" "$code" "200"
done
check "manifest served" "$(curl -s -o /dev/null -w '%{http_code}' $B/manifest.webmanifest)" "200"

# ---------------------------------------------------------------------------
# Multi-user: memory must be private per user. Needs real identities, so a
# second instance runs in authelia mode against the same data dir and is driven
# with Remote-User headers (same technique as the M0 auth checks).
# ---------------------------------------------------------------------------
MU_PORT=39902
AUTH_MODE=authelia TRUSTED_PROXY_IPS=127.0.0.1 ADMIN_GROUP=galaxy-admins \
  DATA_DIR=$DATA PORT=$MU_PORT CODING_EXECUTOR=local ALLOW_PRIVATE_RESEARCH_FETCH=1 node build &
MU_PID=$!
trap 'kill $MOCK_PID $APP_PID $MU_PID 2>/dev/null; rm -rf $DATA' EXIT
sleep 3
M=http://127.0.0.1:$MU_PORT
as() { # as <user> <curl args...>
  local u=$1; shift
  curl -sf -H "Remote-User: $u" -H 'content-type: application/json' "$@"
}
asadmin() { curl -sf -H 'Remote-User: root' -H 'Remote-Groups: galaxy-admins' -H 'content-type: application/json' "$@"; }

# Each user talks about their own distinct topic, then audits their own activity.
for pair in "alice alpha-topic" "bob beta-topic"; do
  set -- $pair
  C=$(as "$1" -X POST $M/api/chats -d '{}' | jqn .id)
  J=$(as "$1" -X POST $M/api/chats/$C/messages -d "{\"content\":\"let's discuss $2\",\"webSearch\":false}" | jqn .jobId)
  curl -sN --max-time 20 -H "Remote-User: $1" $M/api/jobs/$J/stream > /dev/null
  as "$1" -X POST $M/api/memory/run > /dev/null
done

ALICE_MEM=$(as alice $M/api/memory)
BOB_MEM=$(as bob $M/api/memory)
check "alice has her own memory" "$ALICE_MEM" 'ALPHA-MEM'
check "alice cannot see bob's memory" "$(echo "$ALICE_MEM" | grep -c BETA-MEM)" "0"
check "bob has his own memory" "$BOB_MEM" 'BETA-MEM'
check "bob cannot see alice's memory" "$(echo "$BOB_MEM" | grep -c ALPHA-MEM)" "0"

# The admin view must carry status only — no memory text at all.
ADMIN_VIEW=$(asadmin $M/api/admin/memory)
check "admin sees per-user status" "$ADMIN_VIEW" '"username":"alice"'
check "admin cannot read alice's memory" "$(echo "$ADMIN_VIEW" | grep -c ALPHA-MEM)" "0"
check "admin cannot read bob's memory" "$(echo "$ADMIN_VIEW" | grep -c BETA-MEM)" "0"

# The bootstrap the model actually receives must be isolated too. This runs
# BEFORE the delete checks below: deleting a memory changes what the prompt
# contains, so the two must not overlap.
AC=$(as alice -X POST $M/api/chats -d '{}' | jqn .id)
AJ=$(as alice -X POST $M/api/chats/$AC/messages -d '{"content":"echo-system","webSearch":false}' | jqn .jobId)
ASYS=$(curl -sN --max-time 20 -H 'Remote-User: alice' $M/api/jobs/$AJ/stream | grep -o 'SYSCHECK[^"]*' | head -1)
check "alice's prompt carries her memory" "$ASYS" 'alpha=true'
check "alice's prompt excludes bob's memory" "$ASYS" 'beta=false'

# Cross-user mutation must 404 exactly like a missing item. Target an item
# explicitly chosen NOT to be the marker, so this can never invalidate the
# prompt checks above regardless of row ordering.
ALICE_ITEM=$(echo "$ALICE_MEM" | node -pe '
  const d = JSON.parse(require("fs").readFileSync(0));
  const victim = d.items.find((i) => !i.content.includes("ALPHA-MEM"));
  if (!victim) throw new Error("expected a non-marker memory item to delete");
  victim.id')
BOB_DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H 'Remote-User: bob' $M/api/memory/items/$ALICE_ITEM)
check "bob cannot delete alice's item" "$BOB_DEL" "404"
ALICE_DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H 'Remote-User: alice' $M/api/memory/items/$ALICE_ITEM)
check "alice can delete her own item" "$ALICE_DEL" "200"
check "alice's marker survived the delete" "$(as alice $M/api/memory)" 'ALPHA-MEM'

# Opting out must stop the scheduler touching that user.
as alice -X PUT $M/api/memory/settings -d '{"enabled":false}' > /dev/null
check "opt-out persists" "$(as alice $M/api/memory)" '"enabled":false'

if [ "$FAIL" -ne 0 ]; then echo "SMOKE FAILED"; exit 1; fi
echo "SMOKE PASSED"
