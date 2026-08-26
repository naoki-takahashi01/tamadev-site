CREATE TABLE IF NOT EXISTS usage_counters (
  scope TEXT NOT NULL,
  counter_key TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, counter_key, period)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_updated_at
  ON usage_counters (updated_at);
