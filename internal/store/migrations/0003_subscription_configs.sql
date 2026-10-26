ALTER TABLE subscriptions ADD COLUMN configs TEXT NOT NULL DEFAULT '[]'; -- JSON array of exact configuration ids; empty = any
