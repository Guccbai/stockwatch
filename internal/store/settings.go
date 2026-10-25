package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

func (s *Store) GetSetting(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = ?", key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return v, err
}

func (s *Store) AllSettings(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (s *Store) SetSettings(ctx context.Context, kv map[string]string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for k, v := range kv {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, v); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func (s *Store) CreateSession(ctx context.Context, token string, expires time.Time) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO sessions(token_hash, expires_at) VALUES(?, ?)", hashToken(token), expires.Unix())
	return err
}

func (s *Store) ValidSession(ctx context.Context, token string) (bool, error) {
	var exp int64
	err := s.db.QueryRowContext(ctx, "SELECT expires_at FROM sessions WHERE token_hash = ?", hashToken(token)).Scan(&exp)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return time.Now().Unix() < exp, nil
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE token_hash = ?", hashToken(token))
	return err
}

func (s *Store) DeleteAllSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions")
	return err
}

func (s *Store) PurgeExpiredSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at < ?", time.Now().Unix())
	return err
}
