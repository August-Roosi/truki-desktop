-- v0 -> v1: Initial Truki schema
-- transaction: on

CREATE TABLE IF NOT EXISTS chat (
    id TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    login_id TEXT NOT NULL,
    portal_id TEXT NOT NULL,
    name TEXT NOT NULL,
    topic TEXT,
    avatar_mxc TEXT,
    is_dm INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0,
    muted_until INTEGER,
    last_activity INTEGER,
    last_event_id TEXT
);

CREATE TABLE IF NOT EXISTS event (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    type TEXT NOT NULL,
    state_key TEXT,
    content TEXT NOT NULL,
    timestamp INTEGER,
    stream_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    error_code TEXT,
    redacted INTEGER NOT NULL DEFAULT 0,
    relates_to TEXT,
    rel_type TEXT
);

CREATE TABLE IF NOT EXISTS member (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
);

-- Full-text index over event bodies. External-content FTS5 table: the indexed
-- text lives in event (content->>'body'), only the index is stored here.
CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
    body,
    content='event',
    content_rowid='rowid',
    tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS event_fts_insert AFTER INSERT ON event BEGIN
    INSERT INTO event_fts (rowid, body)
    VALUES (new.rowid, json_extract(new.content, '$.body'));
END;

CREATE TRIGGER IF NOT EXISTS event_fts_delete AFTER DELETE ON event BEGIN
    INSERT INTO event_fts (event_fts, rowid, body)
    VALUES ('delete', old.rowid, json_extract(old.content, '$.body'));
END;

CREATE TRIGGER IF NOT EXISTS event_fts_update AFTER UPDATE OF content ON event BEGIN
    INSERT INTO event_fts (event_fts, rowid, body)
    VALUES ('delete', old.rowid, json_extract(old.content, '$.body'));
    INSERT INTO event_fts (rowid, body)
    VALUES (new.rowid, json_extract(new.content, '$.body'));
END;

CREATE INDEX IF NOT EXISTS event_room_stream ON event (room_id, stream_order DESC);
CREATE INDEX IF NOT EXISTS chat_last_activity ON chat (last_activity DESC);
