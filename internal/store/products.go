package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Guccbai/stockwatch/internal/provider"
)

// ReplaceProducts swaps the cached catalog for one provider region.
func (s *Store) ReplaceProducts(ctx context.Context, providerID, region string, products []provider.Product) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM products WHERE provider = ? AND region = ?", providerID, region); err != nil {
		return err
	}
	st, err := tx.PrepareContext(ctx, `INSERT OR REPLACE INTO products(provider, region, code, name, family, specs, price, setup_fee, currency, locations, order_url, options, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer st.Close()
	now := time.Now().Unix()
	for _, p := range products {
		specs, _ := json.Marshal(p.Specs)
		locs, _ := json.Marshal(p.Locations)
		opts, _ := json.Marshal(p.Options)
		if _, err := st.ExecContext(ctx, providerID, region, p.Code, p.Name, p.Family, string(specs), p.Price, p.SetupFee, p.Currency, string(locs), p.OrderURL, string(opts), now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ListProducts(ctx context.Context) ([]provider.Product, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT provider, region, code, name, family, specs, price, setup_fee, currency, locations, order_url, options FROM products ORDER BY provider, region, name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []provider.Product{}
	for rows.Next() {
		var p provider.Product
		var specs, locs, opts string
		if err := rows.Scan(&p.Provider, &p.Region, &p.Code, &p.Name, &p.Family, &specs, &p.Price, &p.SetupFee, &p.Currency, &locs, &p.OrderURL, &opts); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(specs), &p.Specs)
		_ = json.Unmarshal([]byte(locs), &p.Locations)
		_ = json.Unmarshal([]byte(opts), &p.Options)
		out = append(out, p)
	}
	return out, rows.Err()
}

type Notification struct {
	ID             int64     `json:"id"`
	EventID        int64     `json:"eventId"`
	SubscriptionID int64     `json:"subscriptionId"`
	Channel        string    `json:"channel"`
	OK             bool      `json:"ok"`
	Error          string    `json:"error"`
	At             time.Time `json:"at"`
}

func (s *Store) RecordNotification(ctx context.Context, n Notification) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO notifications(event_id, subscription_id, channel, ok, error, at) VALUES(?, ?, ?, ?, ?, ?)",
		n.EventID, n.SubscriptionID, n.Channel, n.OK, n.Error, n.At.Unix())
	return err
}

func (s *Store) ListNotifications(ctx context.Context, limit int) ([]Notification, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, COALESCE(event_id, 0), COALESCE(subscription_id, 0), channel, ok, error, at FROM notifications ORDER BY id DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Notification{}
	for rows.Next() {
		var n Notification
		var at int64
		if err := rows.Scan(&n.ID, &n.EventID, &n.SubscriptionID, &n.Channel, &n.OK, &n.Error, &at); err != nil {
			return nil, err
		}
		n.At = time.Unix(at, 0)
		out = append(out, n)
	}
	return out, rows.Err()
}
