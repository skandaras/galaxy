#!/bin/bash
# End-to-end smoke against the built app and the mock provider. Run by CI on
# every build (the promotion gate): if this fails, the :dev image is not cut.
#   Usage: bash scripts/smoke-e2e.sh   (requires `npm run build` first)
set -euo pipefail
cd "$(dirname "$0")/.."

DATA=$(mktemp -d)
# Below the ephemeral range (/proc/sys/net/ipv4/ip_local_port_range, normally
# 32768-60999). These used to be 3990x, inside it — so the kernel could hand
# one of them to an outbound connection as its source port, and the next
# server to start died with EADDRINUSE. It bit the third and fourth servers
# most often, because by then the run has made a few hundred connections.
MOCK_PORT=18900
APP_PORT=18901
FAIL=0

# Fail loudly and immediately when a server does not come up. A fixed sleep
# meant the first request got an empty reply and the run collapsed several
# checks later in `JSON.parse`, pointing at nothing.
wait_for() { # wait_for <label> <url> [--any]
  local label=$1 url=$2 flag=${3:-}
  for _ in $(seq 1 80); do
    if [ "$flag" = --any ]; then
      curl -s -o /dev/null --max-time 2 "$url" && return 0
    else
      curl -sf -o /dev/null --max-time 2 "$url" && return 0
    fi
    sleep 0.25
  done
  echo "SMOKE FAILED: $label never came up at $url"
  exit 1
}

node scripts/mock-provider.mjs $MOCK_PORT &
MOCK_PID=$!
# ALLOW_PRIVATE_RESEARCH_FETCH: the mock "web" lives on 127.0.0.1, which the
# SSRF guard rightly blocks in production.
AUTH_MODE=dev DEV_USER=smoke DATA_DIR=$DATA PORT=$APP_PORT CODING_EXECUTOR=local ALLOW_PRIVATE_RESEARCH_FETCH=1 node build &
APP_PID=$!
trap 'kill $MOCK_PID $APP_PID 2>/dev/null; rm -rf $DATA' EXIT
wait_for "the mock provider" "http://127.0.0.1:$MOCK_PORT/" --any
wait_for "the app" "http://127.0.0.1:$APP_PORT/healthz"

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

# Hidden chat leaves no trace. The content check is not enough on its own: the
# chat id used to reach usage_log unconditionally, which made a hidden
# conversation reconstructable by id, timing and cost without a word of it
# being stored. Every table that carries a chat_id is checked.
HID=$(api -X POST $B/api/chats -d '{"hidden":true}' | jqn .id)
HJOB=$(api -X POST $B/api/chats/$HID/messages -d '{"content":"secret smoke","webSearch":false}' | jqn .jobId)
curl -sN --max-time 20 $B/api/jobs/$HJOB/stream > /dev/null
LEAK=$(node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database('$DATA/galaxy.db');
const one = (sql) => db.prepare(sql).get().c;
console.log([
  one(\"SELECT COUNT(*) c FROM messages WHERE content LIKE '%secret smoke%'\"),
  one(\"SELECT COUNT(*) c FROM chats WHERE id = '$HID'\"),
  one(\"SELECT COUNT(*) c FROM usage_log WHERE chat_id = '$HID'\"),
  one(\"SELECT COUNT(*) c FROM events WHERE chat_id = '$HID'\"),
  one(\"SELECT COUNT(*) c FROM jobs WHERE chat_id = '$HID'\")
].join(','));")
check "hidden chat not persisted" "leak=$LEAK" "0,0,0,0,0"

# ---------------------------------------------------------------------------
# Chat naming and the archive.
# ---------------------------------------------------------------------------
api -X PUT $B/api/admin/task-configs -d "{\"task\":\"chat-title\",\"primaryModelId\":\"$MODEL_ID\"}" > /dev/null

# Primary path: the agent names the chat from inside the turn that answers, via
# set_chat_title. No second model call, so nothing can fail separately.
TCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
TJOB=$(api -X POST $B/api/chats/$TCHAT/messages -d '{"content":"tell me about nebulae","webSearch":false}' | jqn .jobId)
TSTREAM=$(curl -sN --max-time 40 $B/api/jobs/$TJOB/stream)
check "the agent names the chat itself" "$TSTREAM" '"name":"set_chat_title","status":"ok"'
check "the name it chose is stored" "$(api $B/api/chats/$TCHAT | jqn .chat.title)" 'Named from the turn'

# Fallback path: with set_chat_title switched off the agent cannot name it, so
# the separate titling pass has to.
api -X PATCH $B/api/admin/tools/set_chat_title -d '{"enabled":false}' > /dev/null
FTCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
FTJOB=$(api -X POST $B/api/chats/$FTCHAT/messages -d '{"content":"tell me about pulsars","webSearch":false}' | jqn .jobId)
curl -sN --max-time 40 $B/api/jobs/$FTJOB/stream > /dev/null
sleep 1  # the fallback runs after the reply, deliberately off the streaming path
TITLE=$(api $B/api/chats/$FTCHAT | jqn .chat.title)
check "the fallback names it when the agent cannot" "$TITLE" 'Mock conversation name'
# The mock deliberately answers `"Title: Mock conversation name"`. A substring
# check alone passes on the undecorated text, which is how a stray "Title:"
# prefix reached the sidebar unnoticed.
check "the title is stripped of the model's decorations" "$(echo "$TITLE" | grep -c 'Title:')" "0"
api -X DELETE $B/api/admin/tools/set_chat_title > /dev/null
TCHAT=$FTCHAT

# A name the user chose must survive the next turn untouched.
api -X PATCH $B/api/chats/$TCHAT -d '{"title":"My own name"}' > /dev/null
check "rename sticks" "$(api $B/api/chats/$TCHAT | jqn .chat.title)" 'My own name'
TJOB2=$(api -X POST $B/api/chats/$TCHAT/messages -d '{"content":"more please","webSearch":false}' | jqn .jobId)
curl -sN --max-time 40 $B/api/jobs/$TJOB2/stream > /dev/null
sleep 1
check "the titler leaves a user's name alone" "$(api $B/api/chats/$TCHAT | jqn .chat.title)" 'My own name'

# Archive hides a chat from the list without losing anything.
api -X PATCH $B/api/chats/$TCHAT -d '{"archived":true}' > /dev/null
check "archived chat leaves the list" "$(api $B/api/chats | grep -c $TCHAT)" "0"
check "archived chat is in the archive" "$(api "$B/api/chats?archived=1" | grep -c $TCHAT)" "1"
check "archived chat still opens" "$(api $B/api/chats/$TCHAT | jqn '.messages.length > 0')" 'true'
api -X PATCH $B/api/chats/$TCHAT -d '{"archived":false}' > /dev/null
check "unarchive restores it" "$(api $B/api/chats | grep -c $TCHAT)" "1"

# Reading a supplied URL rather than searching for it. Exercised in both chat
# and a coding session, since the whole point is that the tool is offered to
# both — and with the web-search toggle off, to prove it is independent of it.
PAGE="http://127.0.0.1:$MOCK_PORT/page/one"
UCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
UJOB=$(api -X POST $B/api/chats/$UCHAT/messages -d "{\"content\":\"READ-THIS $PAGE\",\"webSearch\":false}" | jqn .jobId)
USTREAM=$(curl -sN --max-time 40 $B/api/jobs/$UJOB/stream)
check "chat can read a url" "$USTREAM" '"name":"fetch_url","status":"ok"'
check "chat reads it without web search on" "$USTREAM" 'Contains FACT-42: true'

# The GitHub rewrite (repo URL → README, blob URL → raw file) is asserted in
# fetch-url.test.ts against a stubbed fetch. It is deliberately not exercised
# here: this suite is the promotion gate and must not depend on api.github.com
# being reachable, or on its unauthenticated rate limit.

# A turn that cannot reach its provider must say so in the Observatory, in a
# hidden chat as much as a visible one — that record is the only way to find out
# why a run produced nothing. For the hidden one it carries a reason and no id.
for VIS in visible hidden; do
  [ "$VIS" = hidden ] && HFLAG='{"hidden":true}' || HFLAG='{}'
  FCHAT=$(api -X POST $B/api/chats -d "$HFLAG" | jqn .id)
  FJOB=$(api -X POST $B/api/chats/$FCHAT/messages -d '{"content":"DEAD-PROVIDER","webSearch":false}' | jqn .jobId)
  FSTREAM=$(curl -sN --max-time 40 $B/api/jobs/$FJOB/stream)
  check "$VIS failed turn reports an error" "$FSTREAM" '"type":"error"'
  FEV=$(node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database('$DATA/galaxy.db');
const r = db.prepare(\"SELECT chat_id, detail FROM events WHERE name='chat.turn' AND status='error' ORDER BY ts DESC LIMIT 1\").get();
console.log(JSON.stringify(r ?? {}));")
  check "$VIS failed turn is in the Observatory" "$FEV" 'reason'
  if [ "$VIS" = hidden ]; then
    check "hidden failure names no chat" "$(echo "$FEV" | grep -c "$FCHAT")" "0"
  fi
done

# ...and the next turn in that same conversation must be told about it. Without
# this the failure is invisible: the user's message sits there with no reply and
# no reason, so "any update?" just re-runs the whole thing and fails identically.
PCHAT2=$(api -X POST $B/api/chats -d '{}' | jqn .id)
PJOB1=$(api -X POST $B/api/chats/$PCHAT2/messages -d '{"content":"DEAD-PROVIDER","webSearch":false}' | jqn .jobId)
curl -sN --max-time 40 $B/api/jobs/$PJOB1/stream > /dev/null
PJOB2=$(api -X POST $B/api/chats/$PCHAT2/messages -d '{"content":"echo-prior any update?","webSearch":false}' | jqn .jobId)
PSTREAM2=$(curl -sN --max-time 40 $B/api/jobs/$PJOB2/stream)
check "next turn is told the last one failed" "$PSTREAM2" 'PRIORCHECK present=true'
check "next turn is told why" "$PSTREAM2" 'The last run failed'

# A conversation whose last turn went fine must NOT carry the note.
OKCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
OKJ1=$(api -X POST $B/api/chats/$OKCHAT/messages -d '{"content":"hello","webSearch":false}' | jqn .jobId)
curl -sN --max-time 40 $B/api/jobs/$OKJ1/stream > /dev/null
OKJ2=$(api -X POST $B/api/chats/$OKCHAT/messages -d '{"content":"echo-prior and again","webSearch":false}' | jqn .jobId)
check "a healthy conversation carries no note" "$(curl -sN --max-time 40 $B/api/jobs/$OKJ2/stream)" 'PRIORCHECK present=false'

# deep research pipeline
RCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
RJOB=$(api -X POST $B/api/chats/$RCHAT/messages -d '{"content":"How do nebulae form?","deepResearch":true}' | jqn .jobId)
RSTREAM=$(curl -sN --max-time 60 $B/api/jobs/$RJOB/stream)
check "research stages" "$RSTREAM" '"type":"stage","name":"synthesising"'
check "research cites evidence" "$RSTREAM" 'FACT-42 confirmed'
# The loop must actually iterate: consolidate what round one read, then search
# the gap it named rather than the original breadth again.
check "research consolidates between rounds" "$RSTREAM" '"name":"consolidating"'
check "research runs a second, narrowed round" "$RSTREAM" '"name":"searching","detail":"round 2/'
check "research stops early once evidence suffices" "$RSTREAM" 'Evidence judged sufficient after 2 of 3 rounds'
check "research reports the brief it built" "$RSTREAM" 'Brief after 2 rounds: 2 findings'
# The searches themselves are recorded in the Observatory, not on the stream.
# This is the assertion the whole change exists for: round two searched the gap
# consolidation named, not the question's original breadth again.
REVENTS=$(api "$B/api/events?chatId=$RCHAT&limit=200")
check "narrowed round searches the gap that was named" "$REVENTS" 'nebula helium fraction'
check "the run records what its rounds cost" "$REVENTS" '"stopCause":"sufficient"'
# Reading is triaged rather than taken in raw search rank order.
check "reading is triaged before anything is fetched" "$REVENTS" '"name":"research.triage"'
# The first message of a chat is already standalone, so framing is skipped.
check "a first message is not framed" "$RSTREAM" '"name":"planning"'
FIRSTFRAME=$(printf '%s' "$RSTREAM" | grep -c '"name":"framing"' || true)
check "no framing stage on a standalone question" "$FIRSTFRAME" '0'

# A follow-up must be researched against the conversation, not as a literal
# sentence. This is the defect where "do another round, focus on X" was sent to
# the planner verbatim with no idea what "another round" referred to.
FJOB=$(api -X POST $B/api/chats/$RCHAT/messages -d '{"content":"do another round on that, but focus on the helium","deepResearch":true}' | jqn .jobId)
FSTREAM=$(curl -sN --max-time 60 $B/api/jobs/$FJOB/stream)
check "a follow-up is framed against the conversation" "$FSTREAM" '"name":"framing"'
check "and the resolved question is shown" "$FSTREAM" 'Researching: How do nebulae form'

# The awkward pages the follow-up query returns. A UTF-16 page used to decode to
# NULs and be rejected as binary; a page whose prose is only in JSON-LD used to
# extract to nothing; a 403 used to read the same as every other failure.
FEVENTS=$(api "$B/api/events?chatId=$RCHAT&limit=300")
check "a UTF-16 page is read rather than called binary" "$FEVENTS" 'utf16-page'
check "a refusal is recorded with its reason" "$FEVENTS" '"reason":"blocked"'
check "and with its status" "$FEVENTS" '"status":403'
FANSWER=$(api $B/api/chats/$RCHAT | jqn '.messages.at(-1).content')
check "the answer says why a source was not read" "$FANSWER" 'the site refused the request'

# Effort scales the round budget within the admin ceiling: quick gets fewer
# rounds than the balanced default above, off the same settings.
QCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
QJOB=$(api -X POST $B/api/chats/$QCHAT/messages -d '{"content":"How do nebulae form?","deepResearch":true,"effort":"quick"}' | jqn .jobId)
QSTREAM=$(curl -sN --max-time 60 $B/api/jobs/$QJOB/stream)
check "quick effort is announced" "$QSTREAM" '"name":"planning","detail":"quick · up to 2 rounds'
check "quick effort caps the rounds" "$QSTREAM" '"detail":"round 1/2'

# Deep research against a reasoning model, which spends its token budget
# thinking and returns nothing on the first attempt. It used to plan one query
# (the raw question), retrieve nothing, and save an empty reply as a success.
REASON_ID=$(api $B/api/admin/models | node -pe "JSON.parse(require('fs').readFileSync(0)).find(m=>m.modelKey.includes('ponder')).id")
api -X PATCH $B/api/admin/models/$REASON_ID -d '{"enabled":true}' > /dev/null
api -X PUT $B/api/admin/task-configs -d "{\"task\":\"deep-research\",\"primaryModelId\":\"$REASON_ID\"}" > /dev/null
PCHAT=$(api -X POST $B/api/chats -d '{}' | jqn .id)
PJOB=$(api -X POST $B/api/chats/$PCHAT/messages -d '{"content":"How do nebulae form?","deepResearch":true}' | jqn .jobId)
PSTREAM=$(curl -sN --max-time 90 $B/api/jobs/$PJOB/stream)
check "reasoning model still gets a real plan" "$PSTREAM" '"name":"searching","detail":"round 1/3 · 2 queries"'
check "reasoning model retries synthesis" "$PSTREAM" 'retrying with more room'
check "reasoning model produces an answer" "$PSTREAM" 'Thought it through first'
check "reasoning research is not left empty" "$(api $B/api/chats/$PCHAT | jqn '.messages.at(-1).content')" 'Nebulae form'
api -X PUT $B/api/admin/task-configs -d "{\"task\":\"deep-research\",\"primaryModelId\":\"$MODEL_ID\"}" > /dev/null

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

# The coding agent gets fetch_url too, and keeps it with web search off — a
# linked spec or upstream README is exactly what you want it reading in plan
# mode, and it changes nothing in the workspace.
UCJOB=$(api -X POST $B/api/code/sessions/$SID/messages -d "{\"content\":\"READ-THIS $PAGE\",\"webSearch\":false}" | jqn .jobId)
UCSTREAM=$(curl -sN --max-time 60 $B/api/jobs/$UCJOB/stream)
check "coding can read a url" "$UCSTREAM" '"name":"fetch_url","status":"ok"'
check "coding reads it without web search on" "$UCSTREAM" 'Contains FACT-42: true'

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

# ---------------------------------------------------------------------------
# UX audit → backlog. The interesting parts are that the agent is handed live
# telemetry and the real interface source (which is NOT on disk in the built
# image — it is inlined at build time), and that an idea already decided is
# never proposed again.
# ---------------------------------------------------------------------------
api -X PUT $B/api/admin/task-configs -d "{\"task\":\"ux-audit\",\"primaryModelId\":\"$MODEL_ID\"}" > /dev/null
UX=$(api -X POST $B/api/admin/ux/run)
check "ux audit runs" "$UX" '"ran":true'
check "ux audit files ideas" "$UX" '"ideas":2'
BACKLOG=$(api $B/api/admin/ux)
check "backlog lists the idea" "$BACKLOG" 'Explain why a run stopped'
check "backlog ideas start open" "$BACKLOG" '"status":"open"'
# The mock echoes what it could see, so this proves both inputs really arrived.
check "audit saw live telemetry" "$BACKLOG" 'telemetry:true'
check "audit saw the interface source" "$BACKLOG" 'composer-source:true'
# ...and never conversation content: LANTERN-9 is in the Library and the smoke
# chats above are full of text, none of which may reach a platform-wide surface.
check "audit carries no chat content" "$(echo "$BACKLOG" | grep -c 'galaxy news')" "0"

UX_A=$(echo "$BACKLOG" | jqn '.ideas[0].id')
UX_B=$(echo "$BACKLOG" | jqn '.ideas[1].id')
api -X PATCH $B/api/admin/ux/ideas/$UX_A -d '{"action":"actioned"}' > /dev/null
api -X PATCH $B/api/admin/ux/ideas/$UX_B -d '{"action":"discard"}' > /dev/null
DECIDED=$(api $B/api/admin/ux)
check "actioned idea leaves the open list" "$DECIDED" '"status":"actioned"'
check "discarded idea leaves the open list" "$DECIDED" '"status":"discarded"'
check "no ideas left open" "$(echo "$DECIDED" | grep -c '"status":"open"')" "0"
check "deciding twice 404s" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d '{"action":"discard"}' $B/api/admin/ux/ideas/$UX_A)" \
  "404"

# The whole point of keeping decided rows: the same proposals must not return.
UX2=$(api -X POST $B/api/admin/ux/run)
check "audit does not re-propose decided ideas" "$UX2" '"ideas":0'
check "audit recognises them as already proposed" "$UX2" '"duplicates":2'

# The backlog names its instance, because dev and prod each keep their own and
# a decision made on one is invisible to the other.
check "backlog names its environment" "$BACKLOG" '"environment":"dev"'
check "dev backlog advertises a prune window" "$BACKLOG" '"pruneDays":14'

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
MU_PORT=18902
AUTH_MODE=authelia TRUSTED_PROXY_IPS=127.0.0.1 ADMIN_GROUP=galaxy-admins \
  DATA_DIR=$DATA PORT=$MU_PORT CODING_EXECUTOR=local ALLOW_PRIVATE_RESEARCH_FETCH=1 node build &
MU_PID=$!
trap 'kill $MOCK_PID $APP_PID $MU_PID 2>/dev/null; rm -rf $DATA' EXIT
wait_for "the multi-user instance" "http://127.0.0.1:$MU_PORT/healthz"
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

# ---------------------------------------------------------------------------
# Library visibility. The library had no owner column at all before this, so
# every doc reached every user's list AND their agents' system prompt. These
# checks are the ones that stop one person's notes feeding another's model.
# ---------------------------------------------------------------------------
as alice -X POST $M/api/library -d '{"title":"Alice Private","content":"marker PRIVATE-A"}' > /dev/null
as alice -X POST $M/api/library -d '{"title":"Team Notes","content":"marker SHARED-A","visibility":"shared"}' > /dev/null

check "alice sees her personal doc" "$(as alice $M/api/library)" 'Alice Private'
check "bob cannot see it" "$(as bob $M/api/library | grep -c 'Alice Private')" "0"
check "bob sees the shared one" "$(as bob $M/api/library)" 'Team Notes'
check "search does not leak it" "$(as bob "$M/api/library?q=PRIVATE-A" | grep -c 'Alice Private')" "0"

APRIV=$(as alice $M/api/library | node -pe "JSON.parse(require('fs').readFileSync(0)).find(d=>d.title==='Alice Private').id")
check "bob gets 404 fetching it directly" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Remote-User: bob' $M/api/library/$APRIV)" "404"

# The digest goes straight into the system prompt, so this is the real test.
BSYS=$(as bob -X POST $M/api/chats -d '{}' | jqn .id)
BJOB=$(as bob -X POST $M/api/chats/$BSYS/messages -d '{"content":"echo-lib","webSearch":false}' | jqn .jobId)
BOUT=$(curl -sN --max-time 20 -H 'Remote-User: bob' $M/api/jobs/$BJOB/stream | grep -o 'LIBCHECK[^"]*' | head -1)
check "alice's personal doc is absent from bob's prompt" "$BOUT" 'private=false'
check "the shared doc is present in bob's prompt" "$BOUT" 'shared=true'

# Bob may read a shared doc but not change or delete someone else's.
ASHARED=$(as bob $M/api/library | node -pe "JSON.parse(require('fs').readFileSync(0)).find(d=>d.title==='Team Notes').id")
check "bob cannot delete alice's shared doc" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H 'Remote-User: bob' $M/api/library/$ASHARED)" "403"

# ---------------------------------------------------------------------------
# Coding is a per-user grant, because it pushes with one shared GitHub token.
# ---------------------------------------------------------------------------
check "a new user has no coding access" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: alice' -H 'content-type: application/json' -d '{}' $M/api/code/sessions)" "403"
check "nor can they list repos" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Remote-User: alice' $M/api/github/repos)" "403"

ALICE_ID=$(asadmin $M/api/admin/users | node -pe "JSON.parse(require('fs').readFileSync(0)).find(u=>u.username==='alice').id")
check "admin sees the accounts" "$(asadmin $M/api/admin/users)" '"username":"alice"'
asadmin -X PATCH $M/api/admin/users -d "{\"id\":\"$ALICE_ID\",\"canCode\":true}" > /dev/null
check "granting access opens the door" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Remote-User: alice' $M/api/github/repos)" "200"
check "a non-admin cannot reach the user list" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Remote-User: bob' $M/api/admin/users)" "403"

# ---------------------------------------------------------------------------
# Boards. Membership is the whole access model — a board's owner gets a member
# row at creation — so these checks are what prove there is no second path in.
# ---------------------------------------------------------------------------
BOARD=$(as alice -X POST $M/api/boards -d '{"name":"Household"}' | jqn .id)
BLANE=$(as alice $M/api/boards/$BOARD | jqn '.lanes[0].id')

check "a new board arrives with lanes" "$(as alice $M/api/boards/$BOARD | jqn '.lanes.length > 0')" 'true'
check "and with statuses" "$(as alice $M/api/boards/$BOARD | jqn '.statuses.length > 0')" 'true'
check "exactly one status finishes a card" \
  "$(as alice $M/api/boards/$BOARD | jqn '.statuses.filter(s=>s.isDone).length')" "1"
check "bob cannot see alice's board" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Remote-User: bob' $M/api/boards/$BOARD)" "404"
check "nor add a card to it" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: bob' -H 'content-type: application/json' -d '{"title":"sneaky"}' $M/api/boards/$BOARD/cards)" "404"
check "it is absent from his list" "$(as bob $M/api/boards | grep -c Household)" "0"

# Inviting by username is the whole sharing flow — there is no email step.
as alice -X POST $M/api/boards/$BOARD/members -d '{"username":"bob"}' > /dev/null
check "an invite puts the board in bob's list" "$(as bob $M/api/boards)" 'Household'
check "and lets him add a card" \
  "$(as bob -X POST $M/api/boards/$BOARD/cards -d '{"title":"Bins"}' | jqn .title)" 'Bins'
check "inviting someone who has never signed in 404s" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: alice' -H 'content-type: application/json' -d '{"username":"nobody"}' $M/api/boards/$BOARD/members)" "404"
# A collaborator works on cards; the board itself stays with its owner.
check "a collaborator cannot rename the board" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H 'Remote-User: bob' -H 'content-type: application/json' -d '{"name":"Bobs"}' $M/api/boards/$BOARD)" "403"
check "nor delete it" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H 'Remote-User: bob' $M/api/boards/$BOARD)" "403"

# Finishing a card is what archives it — there is no second "archive" action.
CARD=$(as alice -X POST $M/api/boards/$BOARD/cards -d '{"title":"Renew passport"}' | jqn .id)
DONE=$(as alice $M/api/boards/$BOARD | jqn '.statuses.find(s=>s.isDone).id')
check "a new card is not already finished" "$(as alice $M/api/cards/$CARD | jqn '.card.archivedAt')" 'null'
as alice -X PATCH $M/api/cards/$CARD -d "{\"statusId\":\"$DONE\"}" > /dev/null
check "a finished card leaves the board" "$(as alice $M/api/boards/$BOARD | jqn '.cards.filter(c=>c.title==="Renew passport").length')" "0"
check "and lands in the archive" "$(as alice "$M/api/boards/$BOARD?archived=1" | jqn '.archived.filter(c=>c.title==="Renew passport").length')" "1"
check "the log records who did what" "$(as alice $M/api/cards/$CARD | jqn '.log.map(l=>l.event).join(",")')" 'created,status,archived'

# Removing a column must not remove the work in it.
KEEP=$(as alice -X POST $M/api/boards/$BOARD/cards -d "{\"title\":\"Keep me\",\"laneId\":\"$BLANE\"}" | jqn .id)
as alice -X DELETE $M/api/boards/$BOARD/lanes/$BLANE > /dev/null
check "a deleted lane moves its cards rather than dropping them" \
  "$(as alice $M/api/cards/$KEEP | jqn '.card.title')" 'Keep me'

# Lanes are columns on a screen, so the ceiling is what fits.
while [ "$(as alice $M/api/boards/$BOARD | jqn '.lanes.length')" -lt 5 ]; do
  as alice -X POST $M/api/boards/$BOARD/lanes -d '{"name":"More"}' > /dev/null
done
check "a sixth lane is refused" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: alice' -H 'content-type: application/json' -d '{"name":"Too many"}' $M/api/boards/$BOARD/lanes)" "409"

check "admin sees every board" "$(asadmin $M/api/admin/boards)" '"name":"Household"'
check "a non-admin cannot" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Remote-User: bob' $M/api/admin/boards)" "403"

# ---------------------------------------------------------------------------
# Agents on the board. The digest is what actually reaches a model, so that is
# what these check — not what the API happens to return.
# ---------------------------------------------------------------------------
as bob -X POST $M/api/boards -d '{"name":"Bob only"}' > /dev/null
BCHAT=$(as alice -X POST $M/api/chats -d '{}' | jqn .id)
BBJOB=$(as alice -X POST $M/api/chats/$BCHAT/messages -d '{"content":"echo-board","webSearch":false}' | jqn .jobId)
BBOUT=$(curl -sN --max-time 20 -H 'Remote-User: alice' $M/api/jobs/$BBJOB/stream | grep -o 'BOARDCHECK[^"]*' | head -1)
check "alice's board reaches her agent" "$BBOUT" 'mine=true'
check "bob's board does not" "$BBOUT" 'theirs=false'

# ask_user: the run parks on the tool call until the browser answers.
AKCHAT=$(as alice -X POST $M/api/chats -d '{}' | jqn .id)
AKJOB=$(as alice -X POST $M/api/chats/$AKCHAT/messages -d '{"content":"ask-me","webSearch":false}' | jqn .jobId)
curl -sN --max-time 30 -H 'Remote-User: alice' $M/api/jobs/$AKJOB/stream > $DATA/ask.sse &
SSE_PID=$!
# Poll for the question rather than sleeping a fixed amount: the whole point is
# that the run is still open, so there is nothing racing us to finish it.
for _ in $(seq 1 40); do grep -q '"type":"question"' $DATA/ask.sse && break; sleep 0.25; done
QID=$(grep -o '"type":"question","id":"[^"]*"' $DATA/ask.sse | head -1 | sed 's/.*"id":"//;s/"//')
check "the agent asks and the run stays open" "$(grep -c '"type":"question"' $DATA/ask.sse)" "1"
check "the question carries its options" "$(cat $DATA/ask.sse)" '"Joint"'
check "an unanswered question keeps the job running" \
  "$(as alice $M/api/chats/$AKCHAT | jqn '.runningJobId !== null')" 'true'
check "the question raises a notification" \
  "$(as alice $M/api/notifications | jqn '.notifications[0].kind')" 'question'
check "and it is marked urgent, the only kind that pushes" \
  "$(as alice $M/api/notifications | jqn '.notifications[0].urgent')" 'true'
# Bob legitimately has an unread board-share from earlier, so count the kind
# rather than the total.
check "bob is not told about alice's question" \
  "$(as bob $M/api/notifications | node -pe "JSON.parse(require('fs').readFileSync(0)).notifications.filter(n=>n.kind==='question').length")" "0"
check "another user cannot answer it" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: bob' -H 'content-type: application/json' -d "{\"questionId\":\"$QID\",\"answer\":\"x\"}" $M/api/jobs/$AKJOB/answer)" "404"
check "answering resolves it" \
  "$(as alice -X POST $M/api/jobs/$AKJOB/answer -d "{\"questionId\":\"$QID\",\"answer\":\"The joint one\"}")" '"answered":true'
wait $SSE_PID 2>/dev/null || true
check "the answer reaches the model as the tool result" "$(cat $DATA/ask.sse)" 'ANSWERED:The joint one'
check "the question is closed on the stream" "$(cat $DATA/ask.sse)" '"type":"answer"'
check "answering twice is a no-op, not an error" \
  "$(as alice -X POST $M/api/jobs/$AKJOB/answer -d "{\"questionId\":\"$QID\",\"answer\":\"again\"}")" '"answered":false'
# A bell still demanding an answer already given teaches people to ignore it.
check "answering clears the notification" \
  "$(as alice $M/api/notifications | node -pe "JSON.parse(require('fs').readFileSync(0)).notifications.filter(n=>n.kind==='question'&&!n.readAt).length")" "0"

# Card → AI: the board starts an ordinary chat and the agent works the card.
HCARD=$(as alice -X POST $M/api/boards/$BOARD/cards -d '{"title":"Book plumber","description":"Kitchen tap drips"}' | jqn .id)
HAND=$(as alice -X POST $M/api/cards/$HCARD/agent)
HCHAT=$(echo "$HAND" | jqn .chatId)
HJOB=$(echo "$HAND" | jqn .jobId)
HOUT=$(curl -sN --max-time 40 -H 'Remote-User: alice' $M/api/jobs/$HJOB/stream)
check "the agent reads the card it was given" "$HOUT" '"name":"card_read","status":"ok"'
check "and writes what it did to the log" "$HOUT" '"name":"card_comment","status":"ok"'
check "the hand-off finishes" "$HOUT" 'CARD HANDLED'
check "the chat is named after the card" "$(as alice $M/api/chats/$HCHAT | jqn .chat.title)" 'Card: Book plumber'
HLOG=$(as alice $M/api/cards/$HCARD)
check "the card records the hand-off" "$HLOG" 'handed to agent'
check "the agent's note is on the card" "$HLOG" 'waiting on a callback'
check "and is attributed to the agent" "$HLOG" '"actor":"agent"'
# Bob is a collaborator on Household, so that card is legitimately his to hand
# over too. The check that matters is a board he is not on at all.
BOBBOARD=$(as bob $M/api/boards | node -pe "JSON.parse(require('fs').readFileSync(0)).find(b=>b.name==='Bob only').id")
BOBCARD=$(as bob -X POST $M/api/boards/$BOBBOARD/cards -d '{"title":"Bob private task"}' | jqn .id)
check "alice cannot hand bob's card to an agent" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: alice' $M/api/cards/$BOBCARD/agent)" "404"
check "nor run a board action on his board" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: alice' -H 'content-type: application/json' -d '{"action":"prioritise"}' $M/api/boards/$BOBBOARD/agent)" "404"

# Projects: a way of grouping and filtering cards, never of removing them.
PROJ=$(as alice -X POST $M/api/boards/$BOARD/projects -d '{"name":"Kitchen"}' | jqn .id)
check "a new project gets a colour without anyone picking one" \
  "$(as alice $M/api/boards/$BOARD | node -pe "JSON.parse(require('fs').readFileSync(0)).projects[0].colour.length > 0")" 'true'
PCARD=$(as alice -X POST $M/api/boards/$BOARD/cards -d "{\"title\":\"Order tiles\",\"projectId\":\"$PROJ\"}" | jqn .id)
check "a card can be filed against a project" "$(as alice $M/api/cards/$PCARD | jqn .card.projectId)" "$PROJ"
# Moving a card off a project is a change worth recording, like every other field.
as alice -X PATCH $M/api/cards/$PCARD -d '{"projectId":null}' > /dev/null
check "the log records a project change" "$(as alice $M/api/cards/$PCARD)" '"event":"project"'
as alice -X PATCH $M/api/cards/$PCARD -d "{\"projectId\":\"$PROJ\"}" > /dev/null
# Deleting a project must not delete the work filed under it.
as alice -X DELETE $M/api/boards/$BOARD/projects/$PROJ > /dev/null
check "deleting a project keeps its cards" "$(as alice $M/api/cards/$PCARD | jqn .card.title)" 'Order tiles'
check "and only removes the label" "$(as alice $M/api/cards/$PCARD | jqn .card.projectId)" 'null'
check "alice cannot add a project to a board she is not on" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: alice' -H 'content-type: application/json' -d '{"name":"Sneaky"}' $M/api/boards/$BOBBOARD/projects)" "404"

# ---------------------------------------------------------------------------
# Notifications. The point of these is what happens when nobody is looking, so
# what matters is that they are addressed to one person and clear themselves.
# ---------------------------------------------------------------------------
as bob -X POST $M/api/notifications > /dev/null   # clear the board-share he got earlier
ACARD=$(as alice -X POST $M/api/boards/$BOARD/cards -d '{"title":"Take the bins out"}' | jqn .id)
BOB_ID=$(asadmin $M/api/admin/users | node -pe "JSON.parse(require('fs').readFileSync(0)).find(u=>u.username==='bob').id")
as alice -X PATCH $M/api/cards/$ACARD -d "{\"assignedTo\":\"$BOB_ID\"}" > /dev/null
check "assigning a card tells the other person" "$(as bob $M/api/notifications)" 'gave you a card'
check "it points at the card" "$(as bob $M/api/notifications | jqn '.notifications[0].link')" "card=$ACARD"
check "and does not tell the person who assigned it" \
  "$(as alice $M/api/notifications | grep -c 'gave you a card')" "0"

# Assigning something to yourself is not news.
as alice -X PATCH $M/api/cards/$ACARD -d '{"assignedTo":null}' > /dev/null
ALICE_UNREAD=$(as alice $M/api/notifications | jqn .unread)
as alice -X PATCH $M/api/cards/$ACARD -d "{\"assignedTo\":\"$ALICE_ID\"}" > /dev/null
check "assigning to yourself raises nothing" "$(as alice $M/api/notifications | jqn .unread)" "$ALICE_UNREAD"

# Sharing is the only thing that tells someone a board exists — there is no invite email.
SHARED=$(as alice -X POST $M/api/boards -d '{"name":"Weekend"}' | jqn .id)
as alice -X POST $M/api/boards/$SHARED/members -d '{"username":"bob"}' > /dev/null
check "sharing a board tells the invitee" "$(as bob $M/api/notifications)" 'shared a board with you'

# Reading is per-user and does not touch anyone else's list.
BOB_BEFORE=$(as bob $M/api/notifications | jqn .unread)
as alice -X POST $M/api/notifications > /dev/null
check "clearing is per-user" "$(as bob $M/api/notifications | jqn .unread)" "$BOB_BEFORE"
check "and does clear your own" "$(as alice $M/api/notifications | jqn .unread)" "0"
check "read notifications stay in the list" \
  "$(as alice $M/api/notifications | jqn '.notifications.length > 0')" 'true'
check "one user cannot read another's notification" \
  "$(as bob $M/api/notifications | node -pe "JSON.parse(require('fs').readFileSync(0)).notifications.filter(n=>n.title.includes('bins')).length")" "0"

# Push: no keys means no subscribing, and the browser is told why.
check "push is not configured out of the box" \
  "$(as alice $M/api/push/subscriptions | jqn .publicKey)" 'null'
check "so registering a device is refused" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Remote-User: alice' -H 'content-type: application/json' -d '{"endpoint":"https://example.invalid/x","keys":{"p256dh":"a","auth":"b"}}' $M/api/push/subscriptions)" "409"
asadmin -X POST $M/api/admin/push -d '{"action":"generate","subject":"mailto:smoke@example.com"}' > /dev/null
check "an admin can generate the keys" "$(asadmin $M/api/admin/push | jqn .configured)" 'true'
check "the public key reaches the browser" \
  "$(as alice $M/api/push/subscriptions | jqn '.publicKey.length > 20')" 'true'
check "the private key never does" "$(asadmin $M/api/admin/push | grep -c privateKey)" "0"
check "a non-admin cannot touch the keys" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Remote-User: bob' $M/api/admin/push)" "403"
check "now a device can register" \
  "$(as alice -X POST $M/api/push/subscriptions -d '{"endpoint":"https://example.invalid/x","keys":{"p256dh":"a","auth":"b"}}' | jqn '.id.length > 10')" 'true'
check "and it is listed" "$(as alice $M/api/push/subscriptions | jqn '.devices.length')" "1"
check "re-registering the same browser does not duplicate it" \
  "$(as alice -X POST $M/api/push/subscriptions -d '{"endpoint":"https://example.invalid/x","keys":{"p256dh":"a","auth":"b"}}' > /dev/null; as alice $M/api/push/subscriptions | jqn '.devices.length')" "1"
check "bob sees none of alice's devices" "$(as bob $M/api/push/subscriptions | jqn '.devices.length')" "0"

# ---------------------------------------------------------------------------
# A coding turn that runs out of steps must not just stop mid-task. Needs a
# tiny step budget, which is process-wide, so this runs as its own instance on
# its own data dir rather than disturbing the one above.
# ---------------------------------------------------------------------------
LEG_PORT=18903
LEG_DATA=$(mktemp -d)
AUTH_MODE=dev DEV_USER=smoke DATA_DIR=$LEG_DATA PORT=$LEG_PORT CODING_EXECUTOR=local CODING_MAX_STEPS=3 node build &
LEG_PID=$!
trap 'kill $MOCK_PID $APP_PID $MU_PID $LEG_PID 2>/dev/null; rm -rf $DATA $LEG_DATA' EXIT
wait_for "the step-limit instance" "http://127.0.0.1:$LEG_PORT/healthz"
L=http://127.0.0.1:$LEG_PORT

LPROV=$(api -X POST $L/api/admin/providers -d "{\"kind\":\"openai-compatible\",\"name\":\"mock\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/v1\"}" | jqn .id)
api -X POST $L/api/admin/providers/$LPROV/sync > /dev/null
LMODEL=$(api $L/api/admin/models | jqn '[0].id')
api -X PATCH $L/api/admin/models/$LMODEL -d '{"enabled":true}' > /dev/null
api -X PUT $L/api/admin/task-configs -d "{\"task\":\"coding\",\"primaryModelId\":\"$LMODEL\"}" > /dev/null

ORIGIN2=$LEG_DATA/origin2
git init -q -b main "$ORIGIN2" && echo "# origin2" > "$ORIGIN2/README.md"
git -C "$ORIGIN2" add -A && git -C "$ORIGIN2" -c user.email=t@t -c user.name=t commit -qm init
git clone -q --bare "$ORIGIN2" "$ORIGIN2.git"
SID2=$(api -X POST $L/api/code/sessions -d "{\"repoUrl\":\"$ORIGIN2.git\",\"repoName\":\"local/origin2\",\"mode\":\"implement\"}" | jqn .chatId)
LJOB=$(api -X POST $L/api/code/sessions/$SID2/messages -d '{"content":"Update the README","webSearch":false}' | jqn .jobId)
LSTREAM=$(curl -sN --max-time 90 $L/api/jobs/$LJOB/stream)
check "step limit checkpoints the work" "$LSTREAM" 'Checkpointed uncommitted work'
check "step limit continues automatically" "$LSTREAM" 'continuing automatically (leg 2'
check "continuation finishes the job" "$LSTREAM" 'picked up after the step limit'
check "checkpointed work reaches the remote" "$(git -C $ORIGIN2.git log --all --oneline)" 'WIP checkpoint'
# The second leg is told to carry on from state rather than start over.
check "continuation is visible in the transcript" "$(api $L/api/chats/$SID2)" 'Continue from where you left off'

if [ "$FAIL" -ne 0 ]; then echo "SMOKE FAILED"; exit 1; fi
echo "SMOKE PASSED"
