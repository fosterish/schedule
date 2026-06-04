-- Templates rework: date overrides become the day's "daily schedule"; weekday
-- templates are dropped in favour of standalone, day-agnostic schedule templates.

-- Rename in place so existing per-date bindings (and their rows) are preserved.
ALTER TABLE calendar_date_overrides RENAME TO daily_schedules;

-- Reusable schedule templates, not bound to any day; forked into daily schedules.
CREATE TABLE schedule_templates (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id  INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, schedule_id)
);

-- Carry existing weekday-template schedules over as standalone templates so no
-- user-authored schedule is lost; a schedule bound to several weekdays collapses to one.
INSERT OR IGNORE INTO schedule_templates (user_id, schedule_id)
SELECT user_id, schedule_id
  FROM calendar_weekday_bindings
 WHERE schedule_id IS NOT NULL;

DROP TABLE calendar_weekday_bindings;
