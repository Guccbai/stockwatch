package monitor

import (
	"time"

	"github.com/Guccbai/stockwatch/internal/provider"
	"github.com/Guccbai/stockwatch/internal/store"
)

// Kind classifies a transition for notification purposes.
type Kind int

const (
	KindNone    Kind = iota // recorded but never notified (e.g. available ↔ low, unknown ↔ unavailable)
	KindRestock             // not orderable → orderable
	KindSoldOut             // orderable → not orderable
)

func Classify(from, to provider.StockStatus) Kind {
	switch {
	case !from.InStock() && to.InStock():
		return KindRestock
	case from.InStock() && !to.InStock():
		return KindSoldOut
	}
	return KindNone
}

type diffResult struct {
	upserts []store.StockRow
	deletes []string
	events  []*store.Event
}

// diff compares a fresh fetch for one target with the previous state of that target.
// Slots seen for the first time are stored without an event so a fresh install doesn't flood alerts.
func diff(prev map[string]store.StockRow, fresh []provider.Availability, now time.Time) diffResult {
	var r diffResult
	seen := make(map[string]struct{}, len(fresh))
	for _, a := range fresh {
		k := a.Key()
		if _, dup := seen[k]; dup {
			continue
		}
		seen[k] = struct{}{}
		old, ok := prev[k]
		switch {
		case !ok:
			r.upserts = append(r.upserts, store.StockRow{Availability: a, ChangedAt: now})
		case old.Status != a.Status:
			r.upserts = append(r.upserts, store.StockRow{Availability: a, ChangedAt: now})
			r.events = append(r.events, &store.Event{
				Key: k, Provider: a.Provider, Region: a.Region, ProductCode: a.ProductCode,
				Config: a.Config, Location: a.Location, From: old.Status, To: a.Status, RawState: a.RawState, At: now,
			})
		case old.RawState != a.RawState:
			// Same normalized status but different delivery estimate: keep the state fresh, no event.
			r.upserts = append(r.upserts, store.StockRow{Availability: a, ChangedAt: old.ChangedAt})
		}
	}
	for k := range prev {
		if _, ok := seen[k]; !ok {
			r.deletes = append(r.deletes, k)
		}
	}
	return r
}
