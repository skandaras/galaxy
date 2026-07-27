# MCP servers

Galaxy can pull tools from external **MCP** (Model Context Protocol) servers.
Register one in **Admin → Tools → MCP servers**, press **Sync**, and its tools
join the catalogue above alongside the built-ins — available to the chat and
coding agents, and switchable individually like any other tool.

## How it works

Tools are **discovered on Sync and cached** in the database, so assembling a turn
never waits on a network round trip. If you change a server's tools, press Sync
again; tools it no longer advertises are dropped.

Names are prefixed to avoid collisions: a `create_issue` tool on a server with
prefix `linear` is offered to the model as `linear__create_issue`.

A server that has gone away is still offered to the model. The call fails, the
model is told, and the error is recorded on the server row — that beats silently
losing a capability, and you see the reason in Admin.

### Two transports

| | `http` | `stdio` |
|---|---|---|
| What it is | Streamable HTTP to a hosted URL | Galaxy spawns a command and talks over its stdin/stdout |
| Credentials | Headers field | *Not yet supported* — see [limitations](#limitations) |
| Reachable | Anything Galaxy can reach over the network | The command must exist **inside the Galaxy container** |

`stdio` is worth understanding: the command runs in Galaxy's container, not on
your laptop. `npx …` only works if the container has outbound network access, and
anything you rely on is better baked into the image — `runner/Dockerfile` sets the
precedent for extending an image with extra toolchains.

This also rules out MCP servers that expose themselves on **localhost of your own
machine** (several design and browser tools do). `127.0.0.1` inside the container
is the container, not your desktop.

## Servers that work today

These accept a static token, so they work with nothing more than the headers
field. Paste one `Name: value` pair per line.

| Server | URL | Header |
|---|---|---|
| GitHub | `https://api.githubcopilot.com/mcp/` | `Authorization: Bearer <PAT>` |
| Linear | `https://mcp.linear.app/mcp` | `Authorization: Bearer <API key>` |
| Cloudflare | `https://mcp.cloudflare.com/mcp` | `Authorization: Bearer <API token>` |
| Sentry | `https://mcp.sentry.dev/mcp` | `Authorization: Sentry-Bearer <token>` |
| Atlassian | `https://mcp.atlassian.com/v1/mcp` | `Authorization: Basic base64(email:api_token)` |

Two gotchas worth flagging, because both look like a broken server:

- **Sentry uses `Sentry-Bearer`, not `Bearer`.** Plain `Bearer` is reserved for
  MCP's own OAuth tokens and will be rejected.
- **Cloudflare account tokens need *Account Resources: Read***, and IP-filtered
  tokens don't work.

Headers are encrypted at rest with the same key that protects provider API keys,
and are never sent back to the browser once saved. Leave the field blank when
editing a server to keep what's stored.

## Servers that need OAuth — not supported

Galaxy only sends static credentials. A server that requires an interactive
OAuth sign-in cannot be connected, and Sync will tell you so rather than showing
a raw transport error.

| Server | Workaround |
|---|---|
| Notion (hosted, `mcp.notion.com`) | Self-host `@notionhq/notion-mcp-server` over `stdio` with `NOTION_TOKEN` |
| Figma (hosted, `mcp.figma.com`) | None — see below |

## Figma

Short version: **you can't connect Galaxy to Figma today.** Not for lack of a
feature on our side — Figma's policy blocks it. Recorded here so nobody spends
another afternoon on it.

**The hosted server (`https://mcp.figma.com/mcp`) is OAuth-only.** Figma staff
have confirmed on their forum that personal access tokens and plan access tokens
are rejected, so no header you can type will work. You'll get
`Error POSTing to endpoint: Unauthorized`.

**Adding OAuth support to Galaxy would not fix it either**, which is why we
haven't:

- `POST https://api.figma.com/v1/oauth/mcp/register` returns **403 Forbidden**
  for any client not on Figma's approved list, so dynamic client registration —
  the mechanism a generic MCP client would use — is closed.
- The `mcp:connect` scope is restricted to clients in Figma's **MCP Catalog**
  (VS Code, Cursor, Claude Code, Codex, Gemini CLI). Custom apps can't request
  it; new clients go through a waitlist.
- Consequently the usual `npx mcp-remote https://mcp.figma.com/mcp` bridge fails
  too.

**Figma's desktop Dev Mode server** (`http://127.0.0.1:3845/mcp`, no auth) is not
an option for a server deployment: that loopback address is Galaxy's own
container. It's designed for an editor running on the same machine as the Figma
desktop app.

### The community route, for when we pick this up

A community MCP server can talk to Figma's **REST API** with a personal access
token, which needs no OAuth. The leading one is
[`figma-developer-mcp`](https://www.npmjs.com/package/figma-developer-mcp)
(Framelink) — MIT, actively maintained, `node >= 20.20.0`.

```
transport: stdio
command:   npx
args:      -y figma-developer-mcp@0.13.2 --stdio
env:       FIGMA_API_KEY=figd_…
```

The token comes from Figma → **Settings → Security → Personal access tokens**,
with the **`file_content:read`** scope.

**This does not work yet**, for one specific reason: Galaxy has no way to pass a
secret to a `stdio` server (see [limitations](#limitations)). The only way to
supply the key today would be `--figma-api-key=…` in the args, which leaks the
token to anything that can read the process list and stores it unencrypted.
Adding an encrypted env field is the unlock.

Worth knowing before anyone invests in this, because it is a real step down from
the official server:

- It exposes **two** tools — `get_figma_data` and `download_figma_images` —
  against the official server's ~40. No Code Connect, no live selection context,
  no design-system variables by name, no write path, no screenshots. It is "read
  a file's node tree and pull its assets", not a design-system integration.
- `--stdio` is **required**. Without it the process starts an HTTP server on
  `127.0.0.1:3333` and never speaks stdio, which presents as a hang.
- Always pass a `nodeId`; a whole-file read can return a payload large enough to
  blow the context window. Note the URL's `1234-5678` must become `1234:5678`.
- Set `SKIP_IMAGE_DOWNLOADS=1`, or point `IMAGE_DIR` under `/data` — the default
  is the working directory, which is inside the image and therefore ephemeral.
- `FRAMELINK_TELEMETRY=0` stops it phoning home.
- **Pin the version.** v0.8.0–0.11.0 emitted progress notifications after the
  tool response, which crashes strict MCP clients — and Galaxy is one.
- Prefer `RUN npm i -g figma-developer-mcp@<version>` in the runtime stage over
  `npx`: there's no build toolchain at runtime, it needs the native `sharp`
  module, and nothing persists the npm cache, so cold starts re-download.

## Limitations

- **No OAuth.** Static credentials only.
- **`stdio` servers can't be given secrets.** There is no env field, and the SDK
  only passes through `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER` — so
  setting a variable on the Galaxy container does *not* reach the child process.
  This blocks most community stdio servers, which expect their token in an env
  var.
- **No sampling or elicitation.** Galaxy connects with no client capabilities, so
  servers that ask the client to run a model call won't work.
- Resources and prompts are not surfaced — tools only.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `The server rejected Galaxy's credentials` | Missing or wrong header, or a server that requires OAuth (unsupported) |
| `Connection closed` on a stdio server | The command failed to start. The reason is appended from the child's stderr — usually the command isn't installed in the container |
| `fetch failed` | URL wrong, or the container can't reach that host |
| Sync succeeds with 0 tools | The server advertises none, or requires auth it accepted silently — check its own docs |
| Tools discovered but never called | Disabled in the catalogue, or scoped away from the task you're using — check the tool's row in Admin → Tools |
