package store

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/gucc/stockwatch/internal/provider"
)

// StockRow is the persisted current state of one availability slot.
type StockRow struct {
	provider.Availability
	ChangedAt time.Time `json:"changedAt"`
}

// Event is a recorded status transition.
type Event struct {
	ID          int64                `json:"id"`
	Key         string               `json:"key"`
	Provider    string               `json:"provider"`
	Region      string               `json:"region"`
	ProductCode string               `json:"productCode"`
	Config      string               `json:"config"`
	Location    string               `json:"location"`
	From        provider.StockStatus `json:"from"`
	To          provider.StockStatus `json:"to"`
	RawState    string               `json:"rawState"`
	At          time.Time            `json:"at"`
}

func (s *Store) LoadStockState(ctx context.Context) ([]StockRow, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT provider, region, product_code, config, location, status, raw_state, extra, changed_at FROM stock_state")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StockRow
	for rows.Next() {
		var r StockRow
		var extra string
		var changed int64
		if err := rows.Scan(&r.Provider, &r.Region, &r.ProductCode, &r.Config, &r.Location, &r.Status, &r.RawState, &extra, &changed); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(extra), &r.Extra)
		r.ChangedAt = time.Unix(changed, 0)
		out = append(out, r)
	}
	return out, rows.Err()
}

// ApplyChanges upserts changed slots, deletes vanished ones and records transition events
// in a single transaction. It fills in the IDs of the inserted events.
func (s *Store) ApplyChanges(ctx context.Context, upserts []StockRow, deletes []string, events []*Event) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	up, err := tx.PrepareContext(ctx, `INSERT INTO stock_state(key, provider, region, product_code, config, location, status, raw_state, extra, changed_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET status = excluded.status, raw_state = excluded.raw_state, extra = excluded.extra, changed_at = excluded.changed_at`)
	if err != nil {
		return err
	}
	defer up.Close()
	for _, r := range upserts {
		extra, _ := json.Marshal(r.Extra)
		if _, err := up.ExecContext(ctx, r.Key(), r.Provider, r.Region, r.ProductCode, r.Config, r.Location, r.Status, r.RawState, string(extra), r.ChangedAt.Unix()); err != nil {
			return err
		}
	}
	for _, k := range deletes {
		if _, err := tx.ExecContext(ctx, "DELETE FROM stock_state WHERE key = ?", k); err != nil {
			return err
		}
	}
	ev, err := tx.PrepareContext(ctx, `INSERT INTO stock_events(key, provider, region, product_code, config, location, from_status, to_status, raw_state, at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer ev.Close()
	for _, e := range events {
		res, err := ev.ExecContext(ctx, e.Key, e.Provider, e.Region, e.ProductCode, e.Config, e.Location, e.From, e.To, e.RawState, e.At.Unix())
		if err != nil {
			return err
		}
		e.ID, _ = res.LastInsertId()
	}
	return tx.Commit()
}

type EventFilter struct {
	Provider    string
	Region      string
	ProductCode string
	Key         string
	OnlyRestock bool
	Since       time.Time
	Limit       int
	BeforeID    int64
}

func (s *Store) ListEvents(ctx context.Context, f EventFilter) ([]Event, error) {
	var where []string
	var args []any
	add := func(cond string, v any) { where = append(where, cond); args = append(args, v) }
	if f.Provider != "" {
		add("provider = ?", f.Provider)
	}
	if f.Region != "" {
		add("region = ?", f.Region)
	}
	if f.ProductCode != "" {
		add("product_code = ?", f.ProductCode)
	}
	if f.Key != "" {
		add("key = ?", f.Key)
	}
	if f.OnlyRestock {
		where = append(where, "to_status IN ('available','low') AND from_status NOT IN ('available','low')")
	}
	if !f.Since.IsZero() {
		add("at >= ?", f.Since.Unix())
	}
	if f.BeforeID > 0 {
		add("id < ?", f.BeforeID)
	}
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 100
	}
	q := "SELECT id, key, provider, region, product_code, config, location, from_status, to_status, raw_state, at FROM stock_events"
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY id DESC LIMIT ?"
	args = append(args, f.Limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var at int64
		if err := rows.Scan(&e.ID, &e.Key, &e.Provider, &e.Region, &e.ProductCode, &e.Config, &e.Location, &e.From, &e.To, &e.RawState, &at); err != nil {
			return nil, err
		}
		e.At = time.Unix(at, 0)
		out = append(out, e)
	}
	return out, rows.Err()
}

// PruneEvents removes events older than the cutoff so the database stays bounded.
func (s *Store) PruneEvents(ctx context.Context, before time.Time) error {
	if _, err := s.db.ExecContext(ctx, "DELETE FROM stock_events WHERE at < ?", before.Unix()); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM notifications WHERE at < ?", before.Unix())
	return err
}
