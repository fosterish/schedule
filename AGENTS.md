# AGENTS.md

Personal scheduling / task-prioritization app. Multi-user, served from a single
Rust binary with a Mithril SPA frontend.

## Stack

- Backend: Rust (edition 2021, toolchain 1.95), `axum` 0.8, `sqlx` 0.9 (SQLite).
  Serves the API under `/api` and the built frontend at `/` with SPA fallback.
- Frontend: Mithril 2.3, bundled with Vite. Plain JS, no framework beyond Mithril.
- Auth: stateless signed cookies (`axum-extra`), Argon2 password hashes.

## Layout

```
backend/             Rust crate; lib + binaries `schedule` (server) and `adduser`.
backend/src/routes/  One module per API area; mounted in main.rs.
backend/src/models/  DB row types and queries.
backend/migrations/  SQLx migrations, embedded at build time (sqlx::migrate!).
frontend/src/        SPA: main.js (router), views/, components/ (pure logic), api.js.
frontend/test/       node --test suites for the layout/ordering ports.
Dockerfile           Multi-stage: frontend -> musl backend -> Alpine runtime.
```

## Commands

```bash
cargo build --release                 # build backend
cargo test                            # Rust tests + layout golden corpus
cargo fmt && cargo clippy             # format + lint before committing
cd frontend && npm install            # install frontend deps
cd frontend && npm run dev            # Vite dev server :5173 (proxies /api -> :3000)
cd frontend && npm run build          # emit frontend/dist
cd frontend && npm test               # JS port tests (node --test)
```

Dev: run the backend (`cargo run --bin schedule`) and `npm run dev` in two
terminals. Vite proxies `/api` to `:3000` so cookies behave as in production.
Required env when running the server: `DATABASE_URL`, `APP_SECRET` (64+ hex
chars; ephemeral if unset). See `README.md` for the full env-var table.

## Conventions

- Keep the codebase lean. Prefer deleting over adding. When a change makes code
  obsolete (dead functions, replaced wrappers, stale branches), remove it.
- Comments are sparse: only annotate genuinely tricky logic, not obvious code.
- Comments are concise: 20 words max. No change-explaining or narration comments.
- Don't leave commented-out code or TODOs behind a change.

## Gotchas

- Several `frontend/src/components/*` modules (layout, ordering, fractional
  indexing) are ports of backend logic. Changing the rule on one side means
  updating the other and its tests, or the golden corpus diverges.
- Migrations are embedded at compile time; rebuild after editing
  `backend/migrations/`.
- API wrappers live in `frontend/src/api.js`; add new endpoints there, not inline.
