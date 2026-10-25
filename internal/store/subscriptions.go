package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/Guccbai/stockwatch/internal/provider"
)

const (
	NotifyRestock = "restock" // only when an item comes back in stock
	NotifyAll     = "all"     // restock and sold-out
)

type Subscription struct {
	ID           int64     `json:"id"`
	Provider     string    `json:"provider"`
	Region       string    `json:"region"`
	ProductCode  string    `json:"productCode"`
	Locations    []string  `json:"locations"`
	ConfigFilter string    `json:"configFilter"`
	NotifyOn     string    `json:"notifyOn"`
	Enabled      bool      `json:"enabled"`
	Note         string    `json:"note"`
	CreatedAt    time.Time `json:"createdAt"`
}

// Matches reports whether an availability slot falls under this subscription.
func (s Subscription) Matches(a provider.Availability) bool {
	if s.Provider != a.Provider || s.Region != a.Region || s.ProductCode != a.ProductCode {
		return false
	}
	if len(s.Locations) > 0 && !slices.Contains(s.Locations, a.Location) {
		return false
	}
	if s.ConfigFilter != "" && !strings.Contains(a.Config, s.ConfigFilter) {
		return false
	}
	return true
}

func (s *Subscription) Normalize() error {
	s.Provider = strings.TrimSpace(s.Provider)
	s.Region = strings.TrimSpace(s.Region)
	s.ProductCode = strings.TrimSpace(s.ProductCode)
	s.ConfigFilter = strings.TrimSpace(s.ConfigFilter)
	if s.Provider == "" || s.Region == "" || s.ProductCode == "" {
		return errors.New("provider, region and productCode are required")
	}
	if s.NotifyOn == "" {
		s.NotifyOn = NotifyRestock
	}
	if s.NotifyOn != NotifyRestock && s.NotifyOn != NotifyAll {
		return errors.New("notifyOn must be restock or all")
	}
	if s.Locations == nil {
		s.Locations = []string{}
	}
	return nil
}

const subCols = "id, provider, region, product_code, locations, config_filter, notify_on, enabled, note, created_at"

func scanSub(sc interface{ Scan(...any) error }) (Subscription, error) {
	var s Subscription
	var locs string
	var created int64
	if err := sc.Scan(&s.ID, &s.Provider, &s.Region, &s.ProductCode, &locs, &s.ConfigFilter, &s.NotifyOn, &s.Enabled, &s.Note, &created); err != nil {
		return s, err
	}
	_ = json.Unmarshal([]byte(locs), &s.Locations)
	if s.Locations == nil {
		s.Locations = []string{}
	}
	s.CreatedAt = time.Unix(created, 0)
	return s, nil
}

func (s *Store) ListSubscriptions(ctx context.Context) ([]Subscription, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+subCols+" FROM subscriptions ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Subscription{}
	for rows.Next() {
		sub, err := scanSub(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sub)
	}
	return out, rows.Err()
}

func (s *Store) GetSubscription(ctx context.Context, id int64) (Subscription, error) {
	sub, err := scanSub(s.db.QueryRowContext(ctx, "SELECT "+subCols+" FROM subscriptions WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return sub, ErrNotFound
	}
	return sub, err
}

func (s *Store) CreateSubscription(ctx context.Context, sub *Subscription) error {
	locs, _ := json.Marshal(sub.Locations)
	sub.CreatedAt = time.Now()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO subscriptions(provider, region, product_code, locations, config_filter, notify_on, enabled, note, created_at)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sub.Provider, sub.Region, sub.ProductCode, string(locs), sub.ConfigFilter, sub.NotifyOn, sub.Enabled, sub.Note, sub.CreatedAt.Unix())
	if err != nil {
		return err
	}
	sub.ID, err = res.LastInsertId()
	return err
}

func (s *Store) UpdateSubscription(ctx context.Context, sub *Subscription) error {
	locs, _ := json.Marshal(sub.Locations)
	res, err := s.db.ExecContext(ctx,
		`UPDATE subscriptions SET provider = ?, region = ?, product_code = ?, locations = ?, config_filter = ?, notify_on = ?, enabled = ?, note = ?
		 WHERE id = ?`,
		sub.Provider, sub.Region, sub.ProductCode, string(locs), sub.ConfigFilter, sub.NotifyOn, sub.Enabled, sub.Note, sub.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteSubscription(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM subscriptions WHERE id = ?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
