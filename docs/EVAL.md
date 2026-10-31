# Evaluating chat replies

A small harness for answering one question with evidence: does a change make everyday
replies better, on your own conversations, for an acceptable cost? It replays cases through
the same assembly a real chat turn uses (`prepareChatTurn` in `engine.ts`), changes one
thing at a time, and writes the replies out so you can score them blind.

It measures, it does not decide. Fewer banned phrases or a passing test is not a better
reply; your scores are the result. Nothing here changes a default: if a variant wins, making
it the default is a separate change.

## 1. Make a scratch copy

Every case writes chats into the database it runs against, so never point it at a live
instance. On the server, with the instance running:

```sh
mkdir -p /tmp/galaxy-eval
sqlite3 /data/galaxy.db ".backup /tmp/galaxy-eval/galaxy.db"
cp /data/galaxy.key /tmp/galaxy-eval/          # or export SECRET_KEY as the instance does
cp -r /data/skills /data/library /tmp/galaxy-eval/
```

`.backup` gives a consistent copy while the app is writing; copying the file does not. The
key is what decrypts the provider API keys stored in the copy. Attachments are not copied:
a case that needs one should carry the text in its history instead.

## 2. Write cases

One JSON object per line. `src/lib/server/eval/cases.sample.jsonl` has six synthetic ones
(a simple answer, an ambiguous question, a disagreement, a writing task, a correction, a
follow-up about a source); they exercise the mechanics and say nothing about your
conversations.

```json
{"id":"steak","prompt":"How long should I rest a steak?","expect":"A direct answer with the reason"}
```

- `history`: earlier turns, `{ "role": "user" | "assistant", "content": "…" }`. An assistant
  turn may carry `evidence`, what its tools read, to test follow-ups about a source.
- `fromChat`: a chat id in the copy instead of `history`. With no `prompt`, its last question
  is replayed against everything said before it.
- `expect`: what a good reply does, for you when you score. The model never sees it.
- `toolFixtures`: fixed tool results, `{ "web_search": "…" }` or
  `{ "fetch_url": [{ "match": { "url": "…" }, "output": "…" }] }`. Tools answer from these by
  default, so two variants are compared on the same material; a call with no fixture fails
  and says which. `--live-tools` lets them run for real.
- `webSearch`: offer the search tool, as the composer toggle does. Off by default.

Keep the private ones out of this repository. `--list-feedback down` lists the replies people
rated down, which is a good place to find the first few.

## 3. Run

```sh
npm run eval -- --data-dir /tmp/galaxy-eval --cases my-cases.jsonl \
  --variants baseline,short-language --max-usd 0.50
```

Variants, each changing one thing against the instance's own configuration:

| Variant | What changes |
|---|---|
| `baseline` | nothing |
| `short-language` | a shorter Language text with three examples, in place of yours (`eval/language-short.ts`) |
| `effort:low`, `effort:medium`, `effort:high` | the reasoning effort chat asks for (it sends `low`) |
| `lean` | the Library index and boards digest leave the system prompt; the tools stay |
| `no-evidence` | the last replies' tool material is withheld |
| `pinned:<slug>` | OpenRouter routes only to that provider, with `require_parameters` on |
| `model:<id>` | another model row, such as a frontier model as a reference in the same path |

Other flags: `--model <id>` runs every variant on one model, `--repeat <k>` runs each case k
times to see whether a difference holds, `--user <id>` picks whose profile and skills apply,
`--out <dir>` sets where results go (default `eval-out/<timestamp>`, ignored by git), and
`--dump-request` prints the request body each case would send (images replaced by their
size) without calling anything.

`--max-usd` is checked before every model call, so a call already running can take the total
past it; the summary says what was spent, and how many calls had no price. Spend is logged
under the task `eval`, so it shows apart from chat in Admin → Spend and counts against the
budget cap of the copy.

## 4. Score

The run directory holds:

- `<case>/<variant>.md`: the prompt, what a good reply does, the reply, and its numbers;
- `results.csv`: time to first text and in total, model calls, prompt, completion and
  reasoning tokens, cost, the effort actually sent, failover, a banned-phrase count from your
  Language text, and empty columns for usefulness, judgement, style, adherence, continuity and
  completion;
- `blind.md`: each case's replies shuffled under letters; `blind-key.json` says which is which.

Score `blind.md` before opening the key. Compare cost per reply you were satisfied with, not
token price. A difference worth acting on survives `--repeat`.
