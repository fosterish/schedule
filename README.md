# schedule

A personal scheduling and task-prioritization app. Multi-user, served from a
single Rust binary with a Mithril SPA frontend.

- **Backend**: Rust, [`axum`](https://crates.io/crates/axum) 0.8,
  [`sqlx`](https://crates.io/crates/sqlx) 0.9 (SQLite). Serves the API under
  `/api` and the built frontend at `/` with SPA fallback.
- **Frontend**: [Mithril](https://mithril.js.org/) 2.3, bundled with
  [Vite](https://vite.dev/).
- **Auth**: stateless signed cookies (`axum-extra`), Argon2 password hashes.

```
backend/             Rust crate (lib + binaries: schedule, adduser).
backend/migrations/  SQLx migrations (embedded into the binary at build time).
frontend/            Vite app: index.html, src/, public/ (style.css, icons/).
frontend/test/       Node test runner for the layout/ordering ports.
Dockerfile           Multi-stage build (frontend -> musl backend -> Alpine runtime).
```

## Setup

Install [Rust](https://rustup.rs/) (1.95+) and [Node](https://nodejs.org/) (20.19+ / 22.12+), then:

```bash
# Build the backend.
cargo build --release

# Install frontend dependencies.
cd frontend && npm install
```

Create a user (the CLI prompts for a password, or reads it from stdin if piped):

```bash
DATABASE_URL="sqlite:./schedule.db?mode=rwc" cargo run --bin adduser -- alice
```

## Development

Run the backend and the Vite dev server in two terminals. Vite proxies `/api`
to the backend, so cookies and requests behave as in production.

```bash
# Terminal 1 — backend on :3000
DATABASE_URL="sqlite:./schedule.db?mode=rwc" \
APP_SECRET="$(openssl rand -hex 32)" \
cargo run --bin schedule

# Terminal 2 — frontend on :5173 (open this URL in the browser)
cd frontend && npm run dev
```

For a production-style run from a single process, build the frontend and point
the backend at the output:

```bash
cd frontend && npm run build && cd ..
DATABASE_URL="sqlite:./schedule.db?mode=rwc" \
APP_SECRET="$(openssl rand -hex 32)" \
FRONTEND_DIR="frontend/dist" \
cargo run --release --bin schedule
# then open http://127.0.0.1:3000/login
```

### Tests

```bash
cargo test                 # Rust unit tests + layout golden corpus
cd frontend && npm test    # JS ports (layout, ordering, parsing, ...)
```

### Environment variables

Both binaries load a `.env` file from the working directory (or any parent) on
startup; real environment variables take precedence. Paths default to running
from the repo root (e.g. `cargo run --bin schedule`).

| Variable       | Default                           | Notes                                                  |
| -------------- | --------------------------------- | ------------------------------------------------------ |
| `DATABASE_URL` | `sqlite://schedule.db?mode=rwc`   | SQLx connection string. Migrations run on startup.     |
| `APP_SECRET`   | random (ephemeral if unset)       | 64+ hex chars; signs session cookies. Set in prod.     |
| `FRONTEND_DIR` | `frontend`                        | Directory served at `/` (use `frontend/dist` in prod). |
| `BIND_ADDR`    | `127.0.0.1:3000`                  | Listen address.                                        |
| `RUST_LOG`     | `schedule=debug,tower_http=info`  | Tracing filter.                                        |
| `VAPID_PUBLIC_KEY`  | unset                        | Web Push key. All three VAPID vars required, else push off. |
| `VAPID_PRIVATE_KEY` | unset                        | Web Push key. `npx web-push generate-vapid-keys`.      |
| `VAPID_SUBJECT`     | unset                        | Contact URI for push services (`mailto:` or `https:`). |

## Docker

The image bundles the built frontend and both binaries (`schedule`, `adduser`).
The SQLite database is **not** baked in — mount it at `/data`.

```bash
# Build.
docker build -t schedule:latest .

# Create the database / a user (interactive password prompt).
docker run --rm -it -v schedule-data:/data schedule:latest adduser alice

# Run the server.
docker run -d --name schedule \
  -p 3000:3000 \
  -v schedule-data:/data \
  -e APP_SECRET="$(openssl rand -hex 32)" \
  schedule:latest
# open http://127.0.0.1:3000/login
```

Inside the image `DATABASE_URL` defaults to `sqlite:///data/schedule.db?mode=rwc`
and `BIND_ADDR` to `0.0.0.0:3000`. Use a named volume (as above) or a bind mount
(`-v /host/path:/data`) to persist data. Set `APP_SECRET` so sessions survive
restarts.

## License

Copyright (C) 2026.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [`LICENSE`](LICENSE) for the full text.

Because it is an AGPL network service, users interacting with a running instance
are entitled to its source — see section 13 of the license.
