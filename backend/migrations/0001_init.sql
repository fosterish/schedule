CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE projects (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  value        REAL NOT NULL,
  time_cost    REAL NOT NULL,
  -- Palette key (not a hex) so colors can be retuned on the frontend; enum in frontend/src/palette.js. See CHECK below.
  color        TEXT NOT NULL DEFAULT 'orange'
    CHECK (color IN ('blue','sky','violet','seafoam','orange','yellow','magenta','lime')),
  archived_at  TIMESTAMP,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (time_cost > 0)
);
CREATE INDEX projects_by_user ON projects(user_id);

CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  list_order   REAL NOT NULL,
  completed_at TIMESTAMP,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX tasks_by_project ON tasks(project_id, list_order);

-- intra-project dependencies (blocked_id is blocked by blocker_id)
CREATE TABLE task_dependencies (
  blocked_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocker_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (blocked_id, blocker_id),
  CHECK (blocked_id <> blocker_id)
);
-- App-layer enforces both tasks share project_id.

CREATE TABLE schedules (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  start_min     INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min       INTEGER NOT NULL CHECK (end_min > start_min AND end_min <= start_min + 1440)
);
CREATE INDEX schedules_by_user ON schedules(user_id);

CREATE TABLE schedule_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id        INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  position           REAL NOT NULL,
  start_min          INTEGER,
  end_min            INTEGER,
  duration_target    INTEGER NOT NULL CHECK (duration_target > 0),
  -- use_inline=1: Task (inline_* authoritative); use_inline=0: Project (project_id/task_id authoritative). Off-mode columns kept for toggling back.
  use_inline         INTEGER NOT NULL DEFAULT 1 CHECK (use_inline IN (0, 1)),
  inline_label       TEXT,
  inline_description TEXT,
  -- Palette key used when use_inline=1; ignored when 0 but kept for toggling back. Same enum as projects.color.
  color              TEXT NOT NULL DEFAULT 'blue'
    CHECK (color IN ('blue','sky','violet','seafoam','orange','yellow','magenta','lime')),
  project_id         INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  project_rank       INTEGER NOT NULL DEFAULT 1 CHECK (project_rank > 0),
  task_id            INTEGER REFERENCES tasks(id)    ON DELETE SET NULL,
  task_rank          INTEGER NOT NULL DEFAULT 1 CHECK (task_rank > 0),
  CHECK (start_min IS NULL OR end_min IS NULL OR end_min > start_min)
);
CREATE INDEX schedule_items_by_schedule ON schedule_items(schedule_id, position);

CREATE TABLE calendar_weekday_bindings (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  schedule_id  INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, weekday)
);

CREATE TABLE calendar_date_overrides (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  schedule_id  INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, date)
);

-- `context` partitions history into independent per-tab undo/redo stacks; the cap below is global across all contexts.
CREATE TABLE history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  context     TEXT NOT NULL
    CHECK (context IN ('schedule', 'project', 'calendar')),
  op          TEXT NOT NULL,
  forward     TEXT NOT NULL,
  backward    TEXT NOT NULL,
  undone      INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1))
);
CREATE INDEX history_by_user ON history(user_id, id);
CREATE INDEX history_by_user_context ON history(user_id, context, id);
