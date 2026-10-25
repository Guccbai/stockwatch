package monitor

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gucc/stockwatch/internal/notify"
	"github.com/gucc/stockwatch/internal/provider"
	"github.com/gucc/stockwatch/internal/settings"
	"github.com/gucc/stockwatch/internal/store"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		from, to provider.StockStatus
		want     Kind
	}{
		{provider.StatusUnavailable, provider.StatusAvailable, KindRestock},
		{provider.StatusUnknown, provider.StatusLow, KindRestock},
		{provider.StatusAvailable, provider.StatusUnavailable, KindSoldOut},
		{provider.StatusLow, provider.StatusUnknown, KindSoldOut},
		{provider.StatusAvailable, provider.StatusLow, KindNone},
		{provider.StatusUnavailable, provider.StatusUnknown, KindNone},
	}
	for _, c := range cases {
		if got := Classify(c.from, c.to); got != c.want {
			t.Errorf("Classify(%s,%s) = %v, want %v", c.from, c.to, got, c.want)
		}
	}
}

func slot(cfg, loc string, st provider.StockStatus, raw string) provider.Availability {
	return provider.Availability{Provider: "p", Region: "r", ProductCode: "prod", Config: cfg, Location: loc, Status: st, RawState: raw}
}

func TestDiff(t *testing.T) {
	now := time.Unix(1000, 0)
	a := slot("c1", "gra", provider.StatusUnavailable, "unavailable")
	b := slot("c1", "rbx", provider.StatusAvailable, "72H")
	gone := slot("c2", "gra", provider.StatusUnavailable, "unavailable")
	prev := map[string]store.StockRow{
		a.Key():    {Availability: a, ChangedAt: time.Unix(1, 0)},
		b.Key():    {Availability: b, ChangedAt: time.Unix(1, 0)},
		gone.Key(): {Availability: gone, ChangedAt: time.Unix(1, 0)},
	}
	aNow := slot("c1", "gra", provider.StatusAvailable, "1H-high")
	bNow := slot("c1", "rbx", provider.StatusAvailable, "1H-high") // same status, new raw state
	fresh := slot("c3", "sbg", provider.StatusAvailable, "72H")    // first sighting

	d := diff(prev, []provider.Availability{aNow, bNow, fresh, fresh}, now)
	if len(d.events) != 1 || d.events[0].Key != a.Key() || d.events[0].From != provider.StatusUnavailable || d.events[0].To != provider.StatusAvailable {
		t.Fatalf("unexpected events: %+v", d.events)
	}
	if len(d.upserts) != 3 {
		t.Fatalf("want 3 upserts, got %d", len(d.upserts))
	}
	for _, u := range d.upserts {
		if u.Key() == b.Key() && !u.ChangedAt.Equal(time.Unix(1, 0)) {
			t.Errorf("raw-state-only change must keep ChangedAt")
		}
	}
	if len(d.deletes) != 1 || d.deletes[0] != gone.Key() {
		t.Fatalf("unexpected deletes: %v", d.deletes)
	}
}

// scripted returns a fixed sequence of availability snapshots.
type scripted struct {
	mu    sync.Mutex
	steps [][]provider.Availability
	i     int
}

func (s *scripted) ID() string                 { return "p" }
func (s *scripted) Name() string               { return "Scripted" }
func (s *scripted) Regions() []provider.Region { return []provider.Region{{ID: "r"}} }
func (s *scripted) FetchCatalog(context.Context, string) ([]provider.Product, error) {
	return []provider.Product{{Provider: "p", Region: "r", Code: "prod", Name: "PROD"}}, nil
}
func (s *scripted) FetchAvailability(context.Context, string) ([]provider.Availability, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.steps[min(s.i, len(s.steps)-1)]
	s.i++
	return out, nil
}

type recorder struct {
	mu     sync.Mutex
	alerts []notify.Alert
}

func (r *recorder) Name() string                    { return "rec" }
func (r *recorder) Configured(context.Context) bool { return true }
func (r *recorder) SendTest(context.Context) error  { return nil }
func (r *recorder) Notify(_ context.Context, a notify.Alert) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.alerts = append(r.alerts, a)
	return nil
}

func TestPollOnceNotifiesWithCooldown(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	set := settings.New(st, settings.Overrides{})
	rec := &recorder{}
	m := New(st, set, []notify.Notifier{rec}, NewHub(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	clock := time.Unix(10_000, 0)
	m.now = func() time.Time { return clock }

	sub := &store.Subscription{Provider: "p", Region: "r", ProductCode: "prod", Locations: []string{"gra"}, Enabled: true}
	if err := sub.Normalize(); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateSubscription(ctx, sub); err != nil {
		t.Fatal(err)
	}

	off := []provider.Availability{slot("c1", "gra", provider.StatusUnavailable, "unavailable"), slot("c1", "rbx", provider.StatusUnavailable, "unavailable")}
	on := []provider.Availability{slot("c1", "gra", provider.StatusAvailable, "72H"), slot("c1", "rbx", provider.StatusAvailable, "72H")}
	p := &scripted{steps: [][]provider.Availability{off, on, off, on, off, on}}
	target := settings.Target{Provider: "p", Region: "r"}
	if err := m.refreshCatalog(ctx, p, target); err != nil {
		t.Fatal(err)
	}

	poll := func() {
		t.Helper()
		if err := m.PollOnce(ctx, p, target); err != nil {
			t.Fatal(err)
		}
	}
	poll() // baseline, no events
	poll() // restock in gra (rbx filtered out by subscription)
	if len(rec.alerts) != 1 || len(rec.alerts[0].Events) != 1 || rec.alerts[0].Events[0].Location != "gra" {
		t.Fatalf("expected one gra restock alert, got %+v", rec.alerts)
	}
	if rec.alerts[0].Product == nil || rec.alerts[0].Product.Name != "PROD" {
		t.Errorf("alert should carry catalog product")
	}
	poll() // sold out: not notified with notifyOn=restock
	clock = clock.Add(time.Minute)
	poll() // restock again within cooldown: suppressed
	if len(rec.alerts) != 1 {
		t.Fatalf("cooldown should suppress, got %d alerts", len(rec.alerts))
	}
	poll()
	clock = clock.Add(settings.DefaultCooldown)
	poll() // after cooldown: notified
	if len(rec.alerts) != 2 {
		t.Fatalf("expected second alert after cooldown, got %d", len(rec.alerts))
	}

	evs, err := st.ListEvents(ctx, store.EventFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 10 {
		t.Errorf("want 10 recorded transitions, got %d", len(evs))
	}
	restocks, _ := st.ListEvents(ctx, store.EventFilter{OnlyRestock: true})
	if len(restocks) != 6 {
		t.Errorf("want 6 restocks, got %d", len(restocks))
	}

	// State survives a restart.
	m2 := New(st, set, nil, NewHub(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := m2.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if got := m2.Slots(target); len(got) != 2 || !got[0].Status.InStock() {
		t.Errorf("unexpected restored state: %+v", got)
	}
}
