# syntax=docker/dockerfile:1

# ---------- Stage 1: build the frontend (Vite) ----------
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: build the Rust binaries (static musl) ----------
# rust:*-alpine is a musl-native toolchain, so the default target is
# x86_64-unknown-linux-musl and `cargo build` produces statically linked
# binaries that run on a bare Alpine (or scratch) image.
FROM rust:1.95-alpine AS backend
# musl-dev + gcc are needed to compile the bundled SQLite C sources.
RUN apk add --no-cache musl-dev gcc
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY backend/ backend/
# Migrations are embedded at compile time (sqlx::migrate!), so the runtime
# image does not need the migrations directory.
RUN cargo build --release --bin schedule --bin adduser

# ---------- Stage 3: runtime ----------
FROM alpine:3.21 AS runtime

# Non-root runtime user (created with BusyBox adduser BEFORE our own `adduser`
# binary is copied, so the name doesn't shadow it). /data is the mount point for
# the SQLite database; it is owned by this user so a named volume inherits
# writable permissions.
RUN addgroup -S app \
    && adduser -S -D -G app -h /home/app app \
    && mkdir -p /data \
    && chown app:app /data

COPY --from=backend /app/target/release/schedule /usr/local/bin/schedule
COPY --from=backend /app/target/release/adduser  /usr/local/bin/adduser
COPY --from=frontend /app/frontend/dist /app/frontend

ENV FRONTEND_DIR=/app/frontend \
    DATABASE_URL="sqlite:///data/schedule.db?mode=rwc" \
    BIND_ADDR=0.0.0.0:3000

USER app
EXPOSE 3000
# The SQLite database lives here and is expected to be mounted in.
VOLUME ["/data"]

CMD ["schedule"]
