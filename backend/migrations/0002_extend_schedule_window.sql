-- no-transaction
--
-- Relax the schedule window from a 24h-from-start cap to an absolute two-day
-- frame: a schedule may now end as late as minute 2880 (00:00+2, 48h), and item
-- anchors may reach the same ceiling. SQLite can't ALTER a CHECK constraint, so
-- the two affected tables are rebuilt. Foreign keys are disabled for the rebuild
-- (dropping `schedules` would otherwise cascade-delete its items/bindings), which
-- requires running outside a transaction; the rebuild itself stays atomic.
PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE schedules_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   INTEGER NOT NULL CHECK (end_minute > start_minute AND end_minute <= 2880),
  updated_rev  INTEGER NOT NULL,
  deleted_rev  INTEGER
);
INSERT INTO schedules_new (id, user_id, name, start_minute, end_minute, updated_rev, deleted_rev)
  SELECT id, user_id, name, start_minute, end_minute, updated_rev, deleted_rev FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;
CREATE INDEX schedules_by_rev ON schedules(user_id, updated_rev);

CREATE TABLE schedule_items_new (
  id                 TEXT PRIMARY KEY,
  schedule_id        TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  position           TEXT NOT NULL,
  -- Two-day frame (today + overflow): 0..2880. start/end fixed when present.
  start_minute       INTEGER CHECK (start_minute BETWEEN 0 AND 2880),
  end_minute         INTEGER CHECK (end_minute BETWEEN 0 AND 2880),
  fixed_duration     INTEGER CHECK (fixed_duration > 0),
  duration_target    INTEGER NOT NULL CHECK (duration_target > 0),
  use_inline         INTEGER NOT NULL DEFAULT 1 CHECK (use_inline IN (0, 1)),
  inline_label       TEXT,
  inline_description TEXT,
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
INSERT INTO schedule_items_new (
  id, schedule_id, position, start_minute, end_minute, fixed_duration, duration_target,
  use_inline, inline_label, inline_description, inline_color, project_id, project_rank,
  task_id, task_rank, updated_rev, deleted_rev)
  SELECT
  id, schedule_id, position, start_minute, end_minute, fixed_duration, duration_target,
  use_inline, inline_label, inline_description, inline_color, project_id, project_rank,
  task_id, task_rank, updated_rev, deleted_rev FROM schedule_items;
DROP TABLE schedule_items;
ALTER TABLE schedule_items_new RENAME TO schedule_items;
CREATE INDEX schedule_items_by_schedule ON schedule_items(schedule_id, position);
CREATE INDEX schedule_items_by_rev ON schedule_items(updated_rev);

COMMIT;

PRAGMA foreign_keys = ON;
