-- All ids are client-minted UUIDv7s stored as TEXT. Every syncable table carries
-- `updated_rev` (the per-user logical Revision counter, the LWW key) and a nullable
-- `deleted_rev` tombstone; `users.rev` is the monotonic source bumped on each write.
-- Order keys (`tasks.list_order`, `schedule_items.position`) are lexicographic TEXT.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rev           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  value        REAL NOT NULL,
  -- Backs the Rust `Project.time` field (`time` is reserved in SQL).
  time_cost    REAL NOT NULL CHECK (time_cost > 0),
  -- Palette key; enum in frontend/src/palette.js mirrors this CHECK and `types::common::Color`.
  color        TEXT NOT NULL DEFAULT 'orange'
    CHECK (color IN ('blue','sky','violet','seafoam','orange','yellow','magenta','lime')),
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_rev  INTEGER NOT NULL,
  deleted_rev  INTEGER
);
CREATE INDEX projects_by_rev ON projects(user_id, updated_rev);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  list_order   TEXT NOT NULL,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_rev  INTEGER NOT NULL,
  deleted_rev  INTEGER
);
CREATE INDEX tasks_by_project ON tasks(project_id, list_order);
CREATE INDEX tasks_by_rev ON tasks(updated_rev);

-- intra-project dependencies (blocked_id is blocked by blocker_id)
CREATE TABLE task_dependencies (
  blocked_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocker_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  updated_rev  INTEGER NOT NULL,
  deleted_rev  INTEGER,
  PRIMARY KEY (blocked_id, blocker_id),
  CHECK (blocked_id <> blocker_id)
);
-- App-layer enforces both tasks share project_id.
CREATE INDEX task_dependencies_by_rev ON task_dependencies(updated_rev);

-- Hard schedule bounds: start_minute in [0,1439]; end_minute may cross midnight
-- up to start+1440 (so the two-day 0..2879 frame can hold an overnight tail).
CREATE TABLE schedules (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   INTEGER NOT NULL CHECK (end_minute > start_minute AND end_minute <= start_minute + 1440),
  updated_rev  INTEGER NOT NULL,
  deleted_rev  INTEGER
);
CREATE INDEX schedules_by_rev ON schedules(user_id, updated_rev);

CREATE TABLE schedule_items (
  id                 TEXT PRIMARY KEY,
  schedule_id        TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  position           TEXT NOT NULL,
  -- Two-day frame (today + overflow): 0..2879. start/end fixed when present.
  start_minute       INTEGER CHECK (start_minute BETWEEN 0 AND 2879),
  end_minute         INTEGER CHECK (end_minute BETWEEN 0 AND 2879),
  fixed_duration     INTEGER CHECK (fixed_duration > 0),
  duration_target    INTEGER NOT NULL CHECK (duration_target > 0),
  -- use_inline=1: Task (inline_* authoritative); use_inline=0: Project (project_id/task_id authoritative). Off-mode columns kept for toggling back.
  use_inline         INTEGER NOT NULL DEFAULT 1 CHECK (use_inline IN (0, 1)),
  inline_label       TEXT,
  inline_description TEXT,
  -- Palette key used when use_inline=1; ignored when 0 but kept for toggling back.
  inline_color       TEXT NOT NULL DEFAULT 'blue'
    CHECK (inline_color IN ('blue','sky','violet','seafoam','orange','yellow','magenta','lime')),
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  project_rank       INTEGER NOT NULL DEFAULT 1 CHECK (project_rank > 0),
  task_id            TEXT REFERENCES tasks(id)    ON DELETE SET NULL,
  task_rank          INTEGER NOT NULL DEFAULT 1 CHECK (task_rank > 0),
  updated_rev        INTEGER NOT NULL,
  deleted_rev        INTEGER,
  CHECK (start_minute IS NULL OR end_minute IS NULL OR end_minute > start_minute)
);
CREATE INDEX schedule_items_by_schedule ON schedule_items(schedule_id, position);
CREATE INDEX schedule_items_by_rev ON schedule_items(updated_rev);

-- Per-date schedule assignment.
CREATE TABLE schedule_bindings (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  schedule_id  TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  updated_rev  INTEGER NOT NULL,
  deleted_rev  INTEGER,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX schedule_bindings_by_rev ON schedule_bindings(user_id, updated_rev);

-- Marks a schedule as a reusable template.
CREATE TABLE templates (
  schedule_id  TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_rev  INTEGER NOT NULL,
  deleted_rev  INTEGER
);
CREATE INDEX templates_by_rev ON templates(user_id, updated_rev);
