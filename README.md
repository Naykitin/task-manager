# Task Manager

A private, single-user **Kanban board with a built-in time tracker and
timesheet/reporting**, built to run entirely on **Cloudflare's free tier**.
Optionally, tasks can also be created by dictating or typing a free-form note
that Claude turns into structured, reviewable tasks (**Voice Inbox**).

- **Frontend:** React 18 + Vite + TypeScript, drag & drop via `@dnd-kit`.
- **Backend:** a single **Cloudflare Worker** (TypeScript) that serves the built
  React app as static assets and handles all `/api/*` routes itself
  (Workers + static assets — no Cloudflare Pages).
- **Database:** **Cloudflare D1** (SQLite) via a Worker binding.
- **Auth:** email + password (PBKDF2 via Web Crypto), signed JWT (`jose`) in an
  HttpOnly, Secure cookie. Registration is gated by an invite code.
- **Voice Inbox (optional):** dictate (Web Speech API) or type a note →
  Claude API extracts concrete tasks + relations to existing tasks → you
  review/edit every suggestion → apply writes tasks + links atomically.
  Entirely optional — the rest of the app works without it, see below.

Everything is persisted in D1 — nothing is stored only in the browser.

---

## Project layout

```
task-manager/
├── worker/               # Cloudflare Worker (API + static-asset host)
│   ├── index.ts          # Router + auth middleware + error handling
│   ├── auth.ts           # PBKDF2 hashing, JWT, session cookies
│   ├── db.ts             # Ownership guards (every query scoped to the user)
│   ├── env.ts            # Env/bindings type
│   ├── util.ts           # HTTP helpers
│   ├── lib/structuring.ts # Claude API call + prompt for Voice Inbox
│   └── routes/           # auth, boards, tasks, timer, timesheet, voice
├── src/                  # React app
│   ├── components/        # BoardView, ColumnView, TaskCard, Timesheet,
│   │                       # VoiceInbox, Modal/ConfirmModal/TaskModal…
│   ├── api.ts             # Typed fetch client
│   ├── auth.tsx           # Auth context
│   └── format.ts          # Duration / date helpers
├── shared/types.ts       # Types shared by Worker + client
├── schema.sql            # Full D1 schema for a fresh database (see below)
├── migrations/           # D1 migrations (0001_init, 0002_voice_and_links)
├── wrangler.jsonc        # Worker + D1 + static-assets config
└── vite.config.ts        # Vite + @cloudflare/vite-plugin
```

## API

All routes are under `/api/*`. Everything except register/login/logout requires
the session cookie and is scoped to the logged-in user.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ email, password, inviteCode }` |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/logout` | clears cookie |
| GET  | `/api/auth/me` | current user |
| GET  | `/api/boards` | list boards |
| POST | `/api/boards` | `{ name }` (seeds To Do / In Progress / Done) |
| GET  | `/api/boards/:id` | board with columns + tasks (incl. `links`) + time totals |
| PATCH | `/api/boards/:id` | `{ name }` — rename the board |
| DELETE | `/api/boards/:id` | delete board + everything under it |
| POST | `/api/columns` | `{ board_id, name }` |
| PATCH / DELETE | `/api/columns/:id` | rename / delete |
| POST | `/api/tasks` | `{ column_id, title, description? }` |
| PATCH / DELETE | `/api/tasks/:id` | edit / delete |
| PATCH | `/api/tasks/:id/move` | `{ column_id, position }` |
| POST | `/api/tasks/:id/timer/start` | stops any running timer first |
| POST | `/api/tasks/:id/timer/stop` | computes `duration_seconds` |
| GET  | `/api/tasks/:id/time-entries` | history for a task |
| POST | `/api/tasks/:id/time-entries` | `{ started_at, ended_at }` — add a manual entry |
| PATCH / DELETE | `/api/time-entries/:id` | edit / delete a time entry directly |
| GET  | `/api/timesheet?start=&end=&tzOffset=` | grouped by day/task/board + total |
| GET  | `/api/timesheet/export?start=&end=&tzOffset=` | CSV download |
| GET  | `/api/voice-notes/availability` | `{ available }` — is `ANTHROPIC_API_KEY` configured |
| GET  | `/api/voice-notes` | list your voice notes, `?status=pending\|reviewed\|discarded` |
| POST | `/api/voice-notes` | `{ transcript }` — store a raw note, status `pending` |
| POST | `/api/voice-notes/:id/structure` | `{ board_id }` — Claude proposes tasks/links for that one board |
| POST | `/api/voice-notes/:id/apply` | `{ new_tasks }` — writes the (edited) suggestions atomically |
| POST | `/api/voice-notes/:id/discard` | mark a note `discarded` without creating tasks |
| GET  | `/api/tasks/search?q=&board_id=&limit=` | text search over task titles/descriptions |
| GET / POST | `/api/api-keys` | list / create MCP API keys `{ name, scopes? }` (session cookie only; plaintext key returned once) |
| DELETE | `/api/api-keys/:id` | revoke a key |
| POST | `/mcp` | **MCP server** (Streamable HTTP, API-key auth) — see below |

`tzOffset` is minutes east of UTC (`-new Date().getTimezoneOffset()`); the client
sends it automatically so day boundaries match your local day.

---

## MCP server (for Claude, Gemini CLI, Cursor, local agents, …)

The Worker exposes a stateless **MCP server over Streamable HTTP** at
`POST /mcp`, so any MCP-capable client or LLM provider can read and manage your
boards, tasks and timers.

1. Apply migrations:
   ```bash
   wrangler d1 execute task-manager-db --remote --file=migrations/0003_api_keys.sql
   wrangler d1 execute task-manager-db --remote --file=migrations/0004_oauth.sql
   wrangler d1 execute task-manager-db --remote --file=migrations/0005_mcp_audit.sql
   wrangler d1 execute task-manager-db --remote --file=migrations/0006_perf_and_security.sql
   ```
   (For local dev: pass `--local` instead of `--remote`).
2. Manage keys in the UI:
   Sign into the web app and click the **Integrations** tab in the top navigation.
   You can create API keys with custom scopes (`read`, `write`, `delete`), copy the plaintext key, revoke keys, manage connected OAuth applications, and inspect the real-time MCP tool activity audit log.
   (Alternatively, create via curl: `POST /api/api-keys`).
3. Point your client at `https://<your-worker>/mcp` with header
   `Authorization: Bearer tm_…` (or `X-API-Key: tm_…`).

### Stdio-only clients (Claude Desktop, local agents)

If your client only supports local `stdio` subprocesses instead of HTTP:
```json
{
  "mcpServers": {
    "task-manager": {
      "command": "node",
      "args": ["scripts/mcp-stdio-bridge.mjs"],
      "env": {
        "TASK_MANAGER_MCP_URL": "https://<your-worker>/mcp",
        "TASK_MANAGER_API_KEY": "tm_..."
      }
    }
  }
}
```
Or run `npm run mcp:bridge`.

Tools: `list_boards`, `get_board`, `search_tasks`, `get_task`, `get_active_timer`,
`get_timesheet` (read); `create_board`, `create_column`, `create_task`,
`bulk_create_tasks`, `update_task`, `move_task`, `link_tasks`, `start_timer`,
`stop_timer` (write); `delete_task`, `delete_column`, `delete_board` (delete).
Also resources (`taskmanager://boards`, `taskmanager://active-timer`) and prompts
(`daily_standup`, `break_down_goal`). Browser callers must be listed in the
optional `MCP_ALLOWED_ORIGINS` var; non-browser clients send no Origin and are
unaffected.

### OAuth (Claude.ai, ChatGPT and other web connectors)

Web connectors can't send a static header, so the Worker is also an **OAuth 2.1
authorization server** (authorization code + PKCE S256, dynamic client
registration, refresh-token rotation with reuse detection). Apply
`migrations/0004_oauth.sql` (remote: `wrangler d1 execute task-manager-db --remote --file=migrations/0004_oauth.sql`)
and redeploy, then in the client add a custom connector with just the URL
`https://<your-worker>/mcp`. It discovers everything via
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`,
opens `/oauth/authorize` where you sign in with your normal account and pick the
permissions (`delete` is off by default), and receives a 1 h access token plus a
30-day rotating refresh token. OAuth tokens give the same scopes as API keys.

---

## 1. Install

```bash
npm install
```

## 2. Local development

Local secrets live in `.dev.vars` (gitignored, never committed). Copy the
example and fill in your own values:

```bash
cp .dev.vars.example .dev.vars
```

The example ships with `INVITE_CODE=letmein`; change it to whatever you like.
`ANTHROPIC_API_KEY` is optional — see [Voice Inbox](#voice-inbox-optional) below.

Create the local D1 database and apply the schema:

```bash
npm run db:local          # wrangler d1 execute task-manager-db --local --file=./schema.sql
```

Start the dev server (Vite + the Worker running in workerd):

```bash
npm run dev               # http://localhost:5173
```

Register with the invite code from `.dev.vars`, then use the board.

## 3. Deploy to Cloudflare (free tier)

You need a Cloudflare account and `wrangler login` (interactive, uses your
browser).

```bash
# a) Authenticate
npx wrangler login

# b) Create the D1 database (free tier)
npx wrangler d1 create task-manager-db
#    -> copy the printed "database_id" into wrangler.jsonc (d1_databases[0].database_id)

# c) Apply the schema to the REMOTE database
npm run db:remote         # wrangler d1 execute task-manager-db --remote --file=./schema.sql

# d) Set production secrets (do NOT commit these)
npx wrangler secret put JWT_SECRET      # paste a long random string
npx wrangler secret put INVITE_CODE     # the code you'll use to register
npx wrangler secret put ANTHROPIC_API_KEY  # optional, enables Voice Inbox — skip to leave it disabled

# e) Build + deploy
npm run deploy            # vite build && wrangler deploy
```

`wrangler deploy` prints your live URL (e.g. `https://task-manager.<subdomain>.workers.dev`).
Open it, register once with your `INVITE_CODE`, and you're in.

### Generating a strong JWT secret

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## Voice Inbox (optional)

Dictate (or type/paste) a free-form note under a board — e.g. "add a task to
redesign the checkout page, it's blocked by the payment integration task" —
and Claude extracts concrete tasks, suggests which existing tasks they relate
to (`blocks` / `related` / `duplicate`), and flags anything ambiguous as an
open question instead of guessing. Nothing is written until you review and
apply.

- **Requires `ANTHROPIC_API_KEY`.** Without it, `GET /api/voice-notes/availability`
  reports `available: false` and the UI shows a plain "this feature is
  disabled" message instead of the dictation form — the rest of the app is
  completely unaffected. This is the intended state for anyone who forks the
  repo but doesn't want to pay for Claude API usage.
- **One board = one isolated context.** Every note is structured against the
  snapshot of a single board only, and the backend rejects (400) any
  suggested link between tasks on two different boards — a note dictated
  under one board/client can never create tasks or links on another.
- **Language:** tasks are written in whatever language the note itself is
  in — no hardcoded list, Claude matches it automatically. The dictation
  language selector (for the browser's speech-to-text, a separate concern
  from the above) currently offers English, Russian, German, Spanish,
  French, and Ukrainian, remembered across sessions.

---

## Notes

- **Single active timer:** starting a timer automatically stops any other
  running one (enforced server-side).
- **Timesheet totals** only count completed entries (`ended_at` set). A running
  timer is reported separately as "in progress" and never inflates the total.
- **Free tier:** Workers Free + D1 Free only. No Durable Objects, R2, KV, or
  other paid add-ons. (Voice Inbox calls the Claude API directly over `fetch`,
  which is a paid, external API — everything else stays on the free tier.)
- **Registration** is gated by `INVITE_CODE`, so even though the Worker URL is
  public, nobody can create an account without the code.

## License

[MIT](LICENSE) — fork it, deploy your own instance, do what you want with it.
