CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

CREATE TABLE subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider      TEXT    NOT NULL,
    region        TEXT    NOT NULL,
    product_code  TEXT    NOT NULL,
    locations     TEXT    NOT NULL DEFAULT '[]', -- JSON array; empty = any location
    config_filter TEXT    NOT NULL DEFAULT '',   -- substring match on configuration id; empty = any
    notify_on     TEXT    NOT NULL DEFAULT 'restock', -- restock | all
    enabled       INTEGER NOT NULL DEFAULT 1,
    note          TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);

CREATE TABLE stock_state (
    key          TEXT PRIMARY KEY,
    provider     TEXT NOT NULL,
    region       TEXT NOT NULL,
    product_code TEXT NOT NULL,
    config       TEXT NOT NULL,
    location     TEXT NOT NULL,
    status       TEXT NOT NULL,
    raw_state    TEXT NOT NULL,
    extra        TEXT NOT NULL DEFAULT '{}',
    changed_at   INTEGER NOT NULL
);
CREATE INDEX stock_state_product ON stock_state(provider, region, product_code);

CREATE TABLE stock_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT NOT NULL,
    provider     TEXT NOT NULL,
    region       TEXT NOT NULL,
    product_code TEXT NOT NULL,
    config       TEXT NOT NULL,
    location     TEXT NOT NULL,
    from_status  TEXT NOT NULL,
    to_status    TEXT NOT NULL,
    raw_state    TEXT NOT NULL,
    at           INTEGER NOT NULL
);
CREATE INDEX stock_events_at ON stock_events(at);
CREATE INDEX stock_events_key ON stock_events(key, at);
CREATE INDEX stock_events_product ON stock_events(provider, region, product_code, at);

CREATE TABLE notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER,
    subscription_id INTEGER,
    channel         TEXT    NOT NULL,
    ok              INTEGER NOT NULL,
    error           TEXT    NOT NULL DEFAULT '',
    at              INTEGER NOT NULL
);
CREATE INDEX notifications_at ON notifications(at);

CREATE TABLE products (
    provider   TEXT NOT NULL,
    region     TEXT NOT NULL,
    code       TEXT NOT NULL,
    name       TEXT NOT NULL,
    family     TEXT NOT NULL DEFAULT '',
    specs      TEXT NOT NULL DEFAULT '{}',
    price      REAL NOT NULL DEFAULT 0,
    currency   TEXT NOT NULL DEFAULT '',
    locations  TEXT NOT NULL DEFAULT '[]',
    order_url  TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, region, code)
);
