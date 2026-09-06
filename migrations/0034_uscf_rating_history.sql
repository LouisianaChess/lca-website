-- migrations/0034_uscf_rating_history.sql
--
-- Point-in-time US Chess ratings, so a rating can be charted over time.
--
-- This table exists because the history cannot be fetched. The ratings API
-- (ratings-api.uschess.org) returns only the current rating — /members/{id}
-- has no history, and /members/{id}/tournaments and /history both 404. The
-- MSA pages that do carry event history sit behind a bot challenge. So the
-- only way to have a rating curve is to record one reading at a time from
-- today forward, and every day this does not run is a point that cannot be
-- recovered afterwards.
--
-- One row per member per rating system per day a value CHANGED, not per day
-- swept. A member's rating moves a handful of times a year, so storing an
-- identical reading every night would be ~200x the rows for no extra
-- information, and a chart would have to de-duplicate them anyway.

CREATE TABLE IF NOT EXISTS uscf_rating_history (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),

  -- 'R' regular, 'Q' quick, 'B' blitz, and the 'O'-prefixed online variants,
  -- exactly as the API names them. Stored rather than mapped so a system we
  -- do not chart yet is still captured from today.
  rating_system TEXT NOT NULL,

  rating INTEGER NOT NULL,
  is_provisional INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER,
  rating_floor INTEGER,

  -- The date US Chess says the rating last moved, which is the date the
  -- reading actually belongs to. recorded_at is merely when we noticed.
  effective_date TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The read path: one member's curve for one system, oldest first.
CREATE INDEX IF NOT EXISTS idx_rating_history_member
  ON uscf_rating_history(member_id, rating_system, recorded_at);

-- The write path checks "is this different from the last reading?" on every
-- member every night, so it wants the newest row per member/system cheaply.
CREATE INDEX IF NOT EXISTS idx_rating_history_latest
  ON uscf_rating_history(member_id, rating_system, recorded_at DESC);
