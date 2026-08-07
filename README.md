# Task Manager

A private, single-user **Kanban board with a built-in time tracker and
timesheet/reporting**, built to run entirely on **Cloudflare's free tier**.

- **Frontend:** React 18 + Vite + TypeScript, drag & drop via `@dnd-kit`.
- **Backend:** a single **Cloudflare Worker** (TypeScript) that serves the built
  React app as static assets and handles all `/api/*` routes itself
  (Workers + static assets — no Cloudflare Pages).
- **Database:** **Cloudflare D1** (SQLite) via a Worker binding.
- **Auth:** email + password (PBKDF2 via Web Crypto), signed JWT (`jose`) in an
  HttpOnly, Secure cookie. Registration is gated by an invite code.

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
│   └── routes/           # auth, boards, tasks, timer, timesheet
├── src/                  # React app
│   ├── components/        # BoardView, ColumnView, TaskCard, Timesheet, modals…
│   ├── api.ts             # Typed fetch client
│   ├── auth.tsx           # Auth context
│   └── format.ts          # Duration / date helpers
├── shared/types.ts       # Types shared by Worker + client
├── schema.sql            # D1 schema (also copied to migrations/0001_init.sql)
├── migrations/           # D1 migrations
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
| GET  | `/api/boards/:id` | board with columns + tasks + time totals |
| POST | `/api/columns` | `{ board_id, name }` |
| PATCH / DELETE | `/api/columns/:id` | rename / delete |
| POST | `/api/tasks` | `{ column_id, title, description? }` |
| PATCH / DELETE | `/api/tasks/:id` | edit / delete |
| PATCH | `/api/tasks/:id/move` | `{ column_id, position }` |
| POST | `/api/tasks/:id/timer/start` | stops any running timer first |
| POST | `/api/tasks/:id/timer/stop` | computes `duration_seconds` |
| GET  | `/api/tasks/:id/time-entries` | history for a task |
| GET  | `/api/timesheet?start=&end=&tzOffset=` | grouped by day/task/board + total |
| GET  | `/api/timesheet/export?start=&end=&tzOffset=` | CSV download |

`tzOffset` is minutes east of UTC (`-new Date().getTimezoneOffset()`); the client
sends it automatically so day boundaries match your local day.

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

## Notes

- **Single active timer:** starting a timer automatically stops any other
  running one (enforced server-side).
- **Timesheet totals** only count completed entries (`ended_at` set). A running
  timer is reported separately as "in progress" and never inflates the total.
- **Free tier:** Workers Free + D1 Free only. No Durable Objects, R2, KV, or
  other paid add-ons.
- **Registration** is gated by `INVITE_CODE`, so even though the Worker URL is
  public, nobody can create an account without the code.

## License

[MIT](LICENSE) — fork it, deploy your own instance, do what you want with it.
