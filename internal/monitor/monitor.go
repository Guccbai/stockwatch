// Package monitor polls providers, detects stock transitions and dispatches notifications.
package monitor

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gucc/stockwatch/internal/notify"
	"github.com/gucc/stockwatch/internal/provider"
	"github.com/gucc/stockwatch/internal/settings"
	"github.com/gucc/stockwatch/internal/store"
)

const (
	catalogRefresh = 6 * time.Hour
	maxBackoff     = 10 * time.Minute
	fetchTimeout   = 45 * time.Second
	reconcileEvery = 10 * time.Second
)

type PollStatus struct {
	Target         settings.Target `json:"target"`
	LastPoll       time.Time       `json:"lastPoll"`
	LastSuccess    time.Time       `json:"lastSuccess"`
	LastError      string          `json:"lastError"`
	DurationMS     int64           `json:"durationMs"`
	Slots          int             `json:"slots"`
	InStock        int             `json:"inStock"`
	Failures       int             `json:"failures"`
	NextPoll       time.Time       `json:"nextPoll"`
	CatalogUpdated time.Time       `json:"catalogUpdated"`
	CatalogError   string          `json:"catalogError"`
}

type Monitor struct {
	store     *store.Store
	settings  *settings.Settings
	notifiers []notify.Notifier
	hub       *Hub
	log       *slog.Logger
	now       func() time.Time

	mu           sync.RWMutex
	state        map[string]map[string]store.StockRow // target -> key -> row
	products     map[string]provider.Product          // provider|region|code
	status       map[string]*PollStatus
	lastNotified map[string]time.Time
	running      map[string]*worker
}

type worker struct {
	cancel context.CancelFunc
	kick   chan struct{}
}

func New(st *store.Store, s *settings.Settings, notifiers []notify.Notifier, hub *Hub, log *slog.Logger) *Monitor {
	return &Monitor{
		store: st, settings: s, notifiers: notifiers, hub: hub, log: log, now: time.Now,
		state:        map[string]map[string]store.StockRow{},
		products:     map[string]provider.Product{},
		status:       map[string]*PollStatus{},
		lastNotified: map[string]time.Time{},
		running:      map[string]*worker{},
	}
}

func productKey(p, r, code string) string { return p + "|" + r + "|" + code }

// Load restores state and catalog from the database.
func (m *Monitor) Load(ctx context.Context) error {
	rows, err := m.store.LoadStockState(ctx)
	if err != nil {
		return err
	}
	products, err := m.store.ListProducts(ctx)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range rows {
		t := settings.Target{Provider: r.Provider, Region: r.Region}.String()
		if m.state[t] == nil {
			m.state[t] = map[string]store.StockRow{}
		}
		m.state[t][r.Key()] = r
	}
	for _, p := range products {
		m.products[productKey(p.Provider, p.Region, p.Code)] = p
	}
	return nil
}

// Run reconciles polling workers with the configured targets until ctx is cancelled.
func (m *Monitor) Run(ctx context.Context) {
	tick := time.NewTicker(reconcileEvery)
	defer tick.Stop()
	lastPrune := time.Time{}
	for {
		m.reconcile(ctx)
		if m.now().Sub(lastPrune) > 24*time.Hour {
			m.prune(ctx)
			lastPrune = m.now()
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// Targets returns configured targets plus any region referenced by an enabled subscription.
func (m *Monitor) Targets(ctx context.Context) []settings.Target {
	v, err := m.settings.Get(ctx)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []settings.Target
	add := func(t settings.Target) {
		if seen[t.String()] {
			return
		}
		if _, err := provider.Get(t.Provider); err != nil {
			return
		}
		seen[t.String()] = true
		out = append(out, t)
	}
	for _, t := range v.Targets {
		add(t)
	}
	if subs, err := m.store.ListSubscriptions(ctx); err == nil {
		for _, s := range subs {
			if s.Enabled {
				add(settings.Target{Provider: s.Provider, Region: s.Region})
			}
		}
	}
	return out
}

func (m *Monitor) reconcile(ctx context.Context) {
	want := map[string]settings.Target{}
	for _, t := range m.Targets(ctx) {
		want[t.String()] = t
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, w := range m.running {
		if _, ok := want[k]; !ok {
			w.cancel()
			delete(m.running, k)
			delete(m.status, k)
		}
	}
	for k, t := range want {
		if _, ok := m.running[k]; ok {
			continue
		}
		wctx, cancel := context.WithCancel(ctx)
		w := &worker{cancel: cancel, kick: make(chan struct{}, 1)}
		m.running[k] = w
		if m.status[k] == nil {
			m.status[k] = &PollStatus{Target: t}
		}
		go m.loop(wctx, t, w)
	}
}

// PollNow asks every worker to poll immediately.
func (m *Monitor) PollNow() {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, w := range m.running {
		select {
		case w.kick <- struct{}{}:
		default:
		}
	}
}

func (m *Monitor) loop(ctx context.Context, t settings.Target, w *worker) {
	p, err := provider.Get(t.Provider)
	if err != nil {
		return
	}
	// Stagger start so several targets don't hit APIs at the same instant.
	sleep(ctx, time.Duration(rand.Int64N(int64(2*time.Second))))
	var catalogAt time.Time
	failures := 0
	for ctx.Err() == nil {
		if m.now().Sub(catalogAt) > catalogRefresh {
			if err := m.refreshCatalog(ctx, p, t); err != nil {
				m.log.Warn("catalog refresh failed", "target", t, "err", err)
				catalogAt = m.now().Add(-catalogRefresh + 5*time.Minute) // retry in 5 min
			} else {
				catalogAt = m.now()
			}
		}

		if err := m.PollOnce(ctx, p, t); err != nil {
			failures++
			m.log.Warn("poll failed", "target", t, "failures", failures, "err", err)
		} else {
			failures = 0
		}

		v, _ := m.settings.Get(ctx)
		interval := v.Interval
		if interval <= 0 {
			interval = settings.DefaultInterval
		}
		wait := interval
		if failures > 0 {
			wait = min(interval<<min(failures, 6), maxBackoff)
		}
		wait += time.Duration(rand.Int64N(int64(wait/10) + 1)) // ±10% jitter (positive only)
		m.mu.Lock()
		if st := m.status[t.String()]; st != nil {
			st.NextPoll = m.now().Add(wait)
			st.Failures = failures
		}
		m.mu.Unlock()

		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		case <-w.kick:
		}
	}
}

func (m *Monitor) refreshCatalog(ctx context.Context, p provider.Provider, t settings.Target) error {
	cctx, cancel := context.WithTimeout(ctx, 2*fetchTimeout)
	defer cancel()
	products, err := p.FetchCatalog(cctx, t.Region)
	m.mu.Lock()
	st := m.status[t.String()]
	if st != nil {
		st.CatalogError = ""
		if err != nil {
			st.CatalogError = err.Error()
		}
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	if err := m.store.ReplaceProducts(ctx, t.Provider, t.Region, products); err != nil {
		return err
	}
	m.mu.Lock()
	for k, pr := range m.products {
		if pr.Provider == t.Provider && pr.Region == t.Region {
			delete(m.products, k)
		}
	}
	for _, pr := range products {
		m.products[productKey(pr.Provider, pr.Region, pr.Code)] = pr
	}
	if st != nil {
		st.CatalogUpdated = m.now()
	}
	m.mu.Unlock()
	return nil
}

// PollOnce fetches availability for one target, persists transitions and sends notifications.
func (m *Monitor) PollOnce(ctx context.Context, p provider.Provider, t settings.Target) error {
	start := m.now()
	fctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	fresh, err := p.FetchAvailability(fctx, t.Region)
	cancel()

	key := t.String()
	m.mu.RLock()
	prev := m.state[key]
	m.mu.RUnlock()
	if err == nil && len(fresh) == 0 && len(prev) > 0 {
		err = fmt.Errorf("provider returned no availability data (previously %d slots); ignoring", len(prev))
	}
	if err != nil {
		m.setStatus(key, t, func(st *PollStatus) {
			st.LastPoll, st.LastError, st.DurationMS = start, err.Error(), m.now().Sub(start).Milliseconds()
		})
		return err
	}

	now := m.now()
	d := diff(prev, fresh, now)
	if err := m.store.ApplyChanges(ctx, d.upserts, d.deletes, d.events); err != nil {
		return fmt.Errorf("persist: %w", err)
	}

	next := make(map[string]store.StockRow, len(fresh))
	inStock := 0
	for k, r := range prev {
		next[k] = r
	}
	for _, r := range d.upserts {
		next[r.Key()] = r
	}
	for _, k := range d.deletes {
		delete(next, k)
	}
	for _, r := range next {
		if r.Status.InStock() {
			inStock++
		}
	}
	m.mu.Lock()
	m.state[key] = next
	m.mu.Unlock()

	m.setStatus(key, t, func(st *PollStatus) {
		st.LastPoll, st.LastSuccess, st.LastError = start, now, ""
		st.DurationMS = m.now().Sub(start).Milliseconds()
		st.Slots, st.InStock = len(next), inStock
	})

	if len(d.events) > 0 {
		evs := make([]store.Event, len(d.events))
		for i, e := range d.events {
			evs[i] = *e
		}
		m.hub.Publish(Message{Type: "events", Data: evs})
		m.dispatch(ctx, p, evs)
	}
	m.hub.Publish(Message{Type: "poll", Data: m.Status()})
	return nil
}

func (m *Monitor) setStatus(key string, t settings.Target, f func(*PollStatus)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.status[key]
	if st == nil {
		st = &PollStatus{Target: t}
		m.status[key] = st
	}
	f(st)
}

func (m *Monitor) dispatch(ctx context.Context, p provider.Provider, events []store.Event) {
	v, err := m.settings.Get(ctx)
	if err != nil || v.Paused {
		return
	}
	subs, err := m.store.ListSubscriptions(ctx)
	if err != nil {
		m.log.Error("list subscriptions", "err", err)
		return
	}
	now := m.now()
	for _, sub := range subs {
		if !sub.Enabled {
			continue
		}
		var matched []store.Event
		m.mu.Lock()
		for _, e := range events {
			kind := Classify(e.From, e.To)
			if kind == KindNone || (kind == KindSoldOut && sub.NotifyOn != store.NotifyAll) {
				continue
			}
			a := provider.Availability{Provider: e.Provider, Region: e.Region, ProductCode: e.ProductCode, Config: e.Config, Location: e.Location}
			if !sub.Matches(a) {
				continue
			}
			ck := fmt.Sprintf("%d|%s|%d", sub.ID, e.Key, kind)
			if last, ok := m.lastNotified[ck]; ok && now.Sub(last) < v.Cooldown {
				continue
			}
			m.lastNotified[ck] = now
			matched = append(matched, e)
		}
		var prod *provider.Product
		if pr, ok := m.products[productKey(sub.Provider, sub.Region, sub.ProductCode)]; ok {
			prod = &pr
		}
		m.mu.Unlock()
		if len(matched) == 0 {
			continue
		}
		sort.Slice(matched, func(i, j int) bool {
			if matched[i].Location != matched[j].Location {
				return matched[i].Location < matched[j].Location
			}
			return matched[i].Config < matched[j].Config
		})
		alert := notify.Alert{Subscription: sub, ProviderName: p.Name(), Product: prod, Events: matched}
		m.send(ctx, alert)
	}
}

func (m *Monitor) send(ctx context.Context, a notify.Alert) {
	for _, n := range m.notifiers {
		if !n.Configured(ctx) {
			continue
		}
		sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := n.Notify(sctx, a)
		cancel()
		rec := store.Notification{EventID: a.Events[0].ID, SubscriptionID: a.Subscription.ID, Channel: n.Name(), OK: err == nil, At: m.now()}
		if err != nil {
			rec.Error = err.Error()
			m.log.Warn("notify failed", "channel", n.Name(), "subscription", a.Subscription.ID, "err", err)
		} else {
			m.log.Info("notified", "channel", n.Name(), "subscription", a.Subscription.ID, "events", len(a.Events))
		}
		if err := m.store.RecordNotification(ctx, rec); err != nil {
			m.log.Error("record notification", "err", err)
		}
	}
}

func (m *Monitor) prune(ctx context.Context) {
	v, err := m.settings.Get(ctx)
	if err != nil {
		return
	}
	if err := m.store.PruneEvents(ctx, m.now().AddDate(0, 0, -v.RetentionDays)); err != nil {
		m.log.Warn("prune events", "err", err)
	}
	_ = m.store.PurgeExpiredSessions(ctx)
	m.mu.Lock()
	for k, t := range m.lastNotified {
		if m.now().Sub(t) > 24*time.Hour {
			delete(m.lastNotified, k)
		}
	}
	m.mu.Unlock()
}

// --- read access for API / bot ---

func (m *Monitor) Status() []PollStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]PollStatus, 0, len(m.status))
	for _, s := range m.status {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Target.String() < out[j].Target.String() })
	return out
}

// Slots returns a copy of the current state for one target.
func (m *Monitor) Slots(t settings.Target) []store.StockRow {
	m.mu.RLock()
	defer m.mu.RUnlock()
	src := m.state[t.String()]
	out := make([]store.StockRow, 0, len(src))
	for _, r := range src {
		out = append(out, r)
	}
	return out
}

func (m *Monitor) Product(providerID, region, code string) (provider.Product, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.products[productKey(providerID, region, code)]
	return p, ok
}

func (m *Monitor) Products(providerID, region string) []provider.Product {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []provider.Product
	for _, p := range m.products {
		if p.Provider == providerID && p.Region == region {
			out = append(out, p)
		}
	}
	return out
}

// Telegram bot commands.

func (m *Monitor) StatusText(ctx context.Context) string {
	subs, err := m.store.ListSubscriptions(ctx)
	if err != nil {
		return "读取订阅失败"
	}
	var b strings.Builder
	b.WriteString("<b>当前库存</b>\n")
	hasAny := false
	for _, s := range subs {
		if !s.Enabled {
			continue
		}
		hasAny = true
		locs := map[string]bool{}
		n := 0
		for _, r := range m.Slots(settings.Target{Provider: s.Provider, Region: s.Region}) {
			if r.Status.InStock() && s.Matches(r.Availability) {
				n++
				locs[strings.ToUpper(r.Location)] = true
			}
		}
		name := s.ProductCode
		if p, ok := m.Product(s.Provider, s.Region, s.ProductCode); ok && p.Name != "" {
			name = p.Name
		}
		if n == 0 {
			fmt.Fprintf(&b, "🔴 %s <code>%s</code> 无货\n", name, s.ProductCode)
		} else {
			keys := make([]string, 0, len(locs))
			for l := range locs {
				keys = append(keys, l)
			}
			sort.Strings(keys)
			fmt.Fprintf(&b, "🟢 %s <code>%s</code> %d 个配置有货：%s\n", name, s.ProductCode, n, strings.Join(keys, ", "))
		}
	}
	if !hasAny {
		b.WriteString("暂无启用的订阅")
	}
	if v, err := m.settings.Get(ctx); err == nil && v.Paused {
		b.WriteString("\n⏸ 通知已暂停")
	}
	return b.String()
}

func (m *Monitor) SubscriptionsText(ctx context.Context) string {
	subs, err := m.store.ListSubscriptions(ctx)
	if err != nil {
		return "读取订阅失败"
	}
	if len(subs) == 0 {
		return "暂无订阅，请在 WebUI 中添加。"
	}
	var b strings.Builder
	b.WriteString("<b>订阅列表</b>\n")
	for _, s := range subs {
		state := "✅"
		if !s.Enabled {
			state = "⏸"
		}
		locs := "全部机房"
		if len(s.Locations) > 0 {
			locs = strings.ToUpper(strings.Join(s.Locations, ","))
		}
		fmt.Fprintf(&b, "%s #%d %s/%s <code>%s</code> · %s\n", state, s.ID, s.Provider, s.Region, s.ProductCode, locs)
	}
	return b.String()
}

func (m *Monitor) SetPaused(ctx context.Context, paused bool) error {
	return m.settings.Set(ctx, map[string]string{settings.KeyPaused: fmt.Sprint(paused)})
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-time.After(d):
	case <-ctx.Done():
	}
}
