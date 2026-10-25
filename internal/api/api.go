// Package api serves the JSON API, the SSE stream and the embedded WebUI.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/gucc/stockwatch/internal/auth"
	"github.com/gucc/stockwatch/internal/monitor"
	"github.com/gucc/stockwatch/internal/notify"
	"github.com/gucc/stockwatch/internal/provider"
	"github.com/gucc/stockwatch/internal/settings"
	"github.com/gucc/stockwatch/internal/store"
)

type Server struct {
	Store     *store.Store
	Settings  *settings.Settings
	Auth      *auth.Auth
	Monitor   *monitor.Monitor
	Hub       *monitor.Hub
	Notifiers []notify.Notifier
	Web       fs.FS // built SPA; may be nil
	Log       *slog.Logger
	Version   string
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP, middleware.Recoverer)

	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.NoCache)
		r.Get("/health", s.health)
		r.Post("/auth/login", s.login)
		r.Post("/auth/logout", s.logout)
		r.Get("/auth/me", s.me)

		r.Group(func(r chi.Router) {
			r.Use(s.Auth.Middleware, sameOrigin)
			r.Put("/auth/password", s.changePassword)
			r.Get("/providers", s.providers)
			r.Get("/overview", s.overview)
			r.Get("/stock", s.stock)
			r.Get("/stock/detail", s.stockDetail)
			r.Get("/order", s.order)
			r.Get("/subscriptions", s.listSubs)
			r.Post("/subscriptions", s.createSub)
			r.Put("/subscriptions/{id}", s.updateSub)
			r.Delete("/subscriptions/{id}", s.deleteSub)
			r.Get("/events", s.events)
			r.Get("/notifications", s.notifications)
			r.Get("/settings", s.getSettings)
			r.Put("/settings", s.putSettings)
			r.Post("/notify/test", s.testNotify)
			r.Post("/poll", s.pollNow)
			r.Get("/stream", s.stream)
		})
		r.NotFound(func(w http.ResponseWriter, r *http.Request) { writeErr(w, http.StatusNotFound, "not found") })
	})

	if s.Web != nil {
		r.Handle("/*", spaHandler(s.Web))
	}
	return r
}

// sameOrigin blocks cross-site state-changing requests (defense in depth on top of SameSite cookies).
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if o := r.Header.Get("Origin"); o != "" && !strings.HasSuffix(o, "://"+r.Host) {
				writeErr(w, http.StatusForbidden, "cross-origin request rejected")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func spaHandler(web fs.FS) http.Handler {
	files := http.FileServer(http.FS(web))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if f, err := web.Open(p); err == nil {
				f.Close()
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		// Client-side route: serve index.html.
		b, err := fs.ReadFile(web, "index.html")
		if err != nil {
			http.Error(w, "WebUI not built. Run `make web`.", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	})
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) internal(w http.ResponseWriter, err error) {
	s.Log.Error("api error", "err", err)
	writeErr(w, http.StatusInternalServerError, "internal error")
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func target(r *http.Request) (settings.Target, error) {
	t := settings.Target{Provider: r.URL.Query().Get("provider"), Region: r.URL.Query().Get("region")}
	if t.Provider == "" || t.Region == "" {
		return t, errors.New("provider and region are required")
	}
	return t, nil
}

// --- handlers ---

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.Version})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	token, exp, err := s.Auth.Login(r.Context(), auth.ClientIP(r), body.Password)
	switch {
	case errors.Is(err, auth.ErrRateLimited):
		writeErr(w, http.StatusTooManyRequests, err.Error())
		return
	case errors.Is(err, auth.ErrBadPassword):
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	case err != nil:
		s.internal(w, err)
		return
	}
	auth.SetCookie(w, r, token, exp)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	_ = s.Auth.Logout(r.Context(), r)
	auth.ClearCookie(w)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": s.Auth.Authenticated(r), "version": s.Version})
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.Auth.CheckPassword(r.Context(), body.Current); err != nil {
		writeErr(w, http.StatusBadRequest, "当前密码错误")
		return
	}
	if err := s.Auth.SetPassword(r.Context(), body.New); err != nil {
		if errors.Is(err, auth.ErrWeak) {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		s.internal(w, err)
		return
	}
	// Invalidate every session, then log this browser back in.
	if err := s.Store.DeleteAllSessions(r.Context()); err != nil {
		s.internal(w, err)
		return
	}
	token, exp, err := s.Auth.Login(r.Context(), auth.ClientIP(r), body.New)
	if err != nil {
		s.internal(w, err)
		return
	}
	auth.SetCookie(w, r, token, exp)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) providers(w http.ResponseWriter, r *http.Request) {
	type out struct {
		ID      string            `json:"id"`
		Name    string            `json:"name"`
		Regions []provider.Region `json:"regions"`
	}
	res := []out{}
	for _, p := range provider.All() {
		res = append(res, out{ID: p.ID(), Name: p.Name(), Regions: p.Regions()})
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	subs, err := s.Store.ListSubscriptions(ctx)
	if err != nil {
		s.internal(w, err)
		return
	}
	v, err := s.Settings.Get(ctx)
	if err != nil {
		s.internal(w, err)
		return
	}
	recent, err := s.Store.ListEvents(ctx, store.EventFilter{OnlyRestock: true, Limit: 15})
	if err != nil {
		s.internal(w, err)
		return
	}
	day, err := s.Store.ListEvents(ctx, store.EventFilter{OnlyRestock: true, Since: time.Now().Add(-24 * time.Hour), Limit: 1000})
	if err != nil {
		s.internal(w, err)
		return
	}

	type subState struct {
		store.Subscription
		Name      string   `json:"name"`
		InStock   int      `json:"inStock"`
		Locations []string `json:"locations"`
	}
	enabled := 0
	watched := []subState{}
	for _, sub := range subs {
		if !sub.Enabled {
			continue
		}
		enabled++
		st := subState{Subscription: sub, Name: sub.ProductCode, Locations: []string{}}
		if p, ok := s.Monitor.Product(sub.Provider, sub.Region, sub.ProductCode); ok && p.Name != "" {
			st.Name = p.Name
		}
		locs := map[string]bool{}
		for _, row := range s.Monitor.Slots(settings.Target{Provider: sub.Provider, Region: sub.Region}) {
			if row.Status.InStock() && sub.Matches(row.Availability) {
				st.InStock++
				if !locs[row.Location] {
					locs[row.Location] = true
					st.Locations = append(st.Locations, row.Location)
				}
			}
		}
		watched = append(watched, st)
	}

	telegram := false
	for _, n := range s.Notifiers {
		if n.Name() == "telegram" && n.Configured(ctx) {
			telegram = true
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"polls":                s.Monitor.Status(),
		"subscriptions":        len(subs),
		"enabledSubscriptions": enabled,
		"watched":              watched,
		"recentRestocks":       recent,
		"restocks24h":          len(day),
		"paused":               v.Paused,
		"telegramConfigured":   telegram,
		"interval":             int(v.Interval.Seconds()),
	})
}

func (s *Server) stock(w http.ResponseWriter, r *http.Request) {
	t, err := target(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	products, locs := summarize(s.Monitor.Slots(t), s.Monitor.Products(t.Provider, t.Region), pricerFor(t.Provider))
	var poll *monitor.PollStatus
	for _, st := range s.Monitor.Status() {
		if st.Target == t {
			poll = &st
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"target": t, "poll": poll, "locations": locs, "products": products})
}

// pricerFor returns the provider's per-configuration pricing, or nil when it has none.
func pricerFor(providerID string) provider.ConfigPricer {
	p, err := provider.Get(providerID)
	if err != nil {
		return nil
	}
	pricer, _ := p.(provider.ConfigPricer)
	return pricer
}

func (s *Server) stockDetail(w http.ResponseWriter, r *http.Request) {
	t, err := target(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	code := r.URL.Query().Get("product")
	var prod *provider.Product
	if p, ok := s.Monitor.Product(t.Provider, t.Region, code); ok {
		prod = &p
	}
	configs, locs := detail(s.Monitor.Slots(t), code, prod, pricerFor(t.Provider))
	writeJSON(w, http.StatusOK, map[string]any{"target": t, "product": prod, "code": code, "locations": locs, "configs": configs})
}

// order redirects to the provider's pre-filled order page for a product. Without config it picks
// the cheapest configuration in stock (at location, or anywhere when location is empty). When no
// pre-filled link can be built it falls back to the provider's storefront for the region.
func (s *Server) order(w http.ResponseWriter, r *http.Request) {
	t, err := target(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	q := r.URL.Query()
	code, location, config := q.Get("product"), q.Get("location"), q.Get("config")
	prod, ok := s.Monitor.Product(t.Provider, t.Region, code)
	if !ok {
		// Slots for plans missing from the public catalog: nothing to pre-fill, send to the storefront.
		for _, p := range s.Monitor.Products(t.Provider, t.Region) {
			if p.OrderURL != "" {
				http.Redirect(w, r, p.OrderURL, http.StatusFound)
				return
			}
		}
		writeErr(w, http.StatusNotFound, "unknown product")
		return
	}
	if config == "" {
		config, location = cheapestInStock(s.Monitor.Slots(t), &prod, location, pricerFor(t.Provider))
	}
	if p, err := provider.Get(t.Provider); err == nil {
		if linker, ok := p.(provider.OrderLinker); ok && config != "" {
			if u, ok := linker.OrderURL(prod, config, location); ok {
				http.Redirect(w, r, u, http.StatusFound)
				return
			}
		}
	}
	if prod.OrderURL == "" {
		writeErr(w, http.StatusNotFound, "no order link for this product")
		return
	}
	http.Redirect(w, r, prod.OrderURL, http.StatusFound)
}

func (s *Server) listSubs(w http.ResponseWriter, r *http.Request) {
	subs, err := s.Store.ListSubscriptions(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, subs)
}

func (s *Server) validateSub(sub *store.Subscription) error {
	if err := sub.Normalize(); err != nil {
		return err
	}
	p, err := provider.Get(sub.Provider)
	if err != nil {
		return err
	}
	for _, reg := range p.Regions() {
		if reg.ID == sub.Region {
			return nil
		}
	}
	return fmt.Errorf("unknown region %q for provider %s", sub.Region, sub.Provider)
}

func (s *Server) createSub(w http.ResponseWriter, r *http.Request) {
	var sub store.Subscription
	if err := decode(r, &sub); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.validateSub(&sub); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.Store.CreateSubscription(r.Context(), &sub); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, sub)
}

func subID(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
}

func (s *Server) updateSub(w http.ResponseWriter, r *http.Request) {
	id, err := subID(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var sub store.Subscription
	if err := decode(r, &sub); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	sub.ID = id
	if err := s.validateSub(&sub); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.Store.UpdateSubscription(r.Context(), &sub); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "subscription not found")
			return
		}
		s.internal(w, err)
		return
	}
	updated, err := s.Store.GetSubscription(r.Context(), id)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) deleteSub(w http.ResponseWriter, r *http.Request) {
	id, err := subID(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	if err := s.Store.DeleteSubscription(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "subscription not found")
			return
		}
		s.internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.EventFilter{
		Provider: q.Get("provider"), Region: q.Get("region"), ProductCode: q.Get("product"), Key: q.Get("key"),
		OnlyRestock: q.Get("restock") == "1",
	}
	f.Limit, _ = strconv.Atoi(q.Get("limit"))
	f.BeforeID, _ = strconv.ParseInt(q.Get("before"), 10, 64)
	if d, err := strconv.Atoi(q.Get("days")); err == nil && d > 0 {
		f.Since = time.Now().AddDate(0, 0, -d)
	}
	evs, err := s.Store.ListEvents(r.Context(), f)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, evs)
}

func (s *Server) notifications(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	ns, err := s.Store.ListNotifications(r.Context(), limit)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ns)
}

type settingsView struct {
	TelegramTokenSet  bool              `json:"telegramTokenSet"`
	TelegramTokenHint string            `json:"telegramTokenHint"`
	TelegramChatID    string            `json:"telegramChatId"`
	TelegramCommands  bool              `json:"telegramCommands"`
	Interval          int               `json:"interval"`
	Cooldown          int               `json:"cooldown"`
	Targets           []settings.Target `json:"targets"`
	Paused            bool              `json:"paused"`
	RetentionDays     int               `json:"retentionDays"`
	EnvOverrides      map[string]bool   `json:"envOverrides"`
}

func (s *Server) settingsView(ctx context.Context) (settingsView, error) {
	v, err := s.Settings.Get(ctx)
	if err != nil {
		return settingsView{}, err
	}
	hint := ""
	if n := len(v.TelegramToken); n > 8 {
		hint = v.TelegramToken[:4] + "…" + v.TelegramToken[n-4:]
	}
	o := s.Settings.Overrides()
	return settingsView{
		TelegramTokenSet: v.TelegramToken != "", TelegramTokenHint: hint,
		TelegramChatID: v.TelegramChatID, TelegramCommands: v.TelegramCommands,
		Interval: int(v.Interval.Seconds()), Cooldown: int(v.Cooldown.Seconds()),
		Targets: v.Targets, Paused: v.Paused, RetentionDays: v.RetentionDays,
		EnvOverrides: map[string]bool{"telegramToken": o.TelegramToken != "", "telegramChatId": o.TelegramChatID != ""},
	}, nil
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	v, err := s.settingsView(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TelegramToken    *string            `json:"telegramToken"`
		TelegramChatID   *string            `json:"telegramChatId"`
		TelegramCommands *bool              `json:"telegramCommands"`
		Interval         *int               `json:"interval"`
		Cooldown         *int               `json:"cooldown"`
		Targets          *[]settings.Target `json:"targets"`
		Paused           *bool              `json:"paused"`
		RetentionDays    *int               `json:"retentionDays"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	kv := map[string]string{}
	if body.TelegramToken != nil {
		kv[settings.KeyTelegramToken] = strings.TrimSpace(*body.TelegramToken)
	}
	if body.TelegramChatID != nil {
		kv[settings.KeyTelegramChatID] = strings.TrimSpace(*body.TelegramChatID)
	}
	if body.TelegramCommands != nil {
		kv[settings.KeyTelegramCommands] = strconv.FormatBool(*body.TelegramCommands)
	}
	if body.Interval != nil {
		if time.Duration(*body.Interval)*time.Second < settings.MinInterval {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("轮询间隔不能小于 %d 秒", int(settings.MinInterval.Seconds())))
			return
		}
		kv[settings.KeyInterval] = strconv.Itoa(*body.Interval)
	}
	if body.Cooldown != nil {
		if *body.Cooldown < 0 {
			writeErr(w, http.StatusBadRequest, "冷却时间不能为负")
			return
		}
		kv[settings.KeyCooldown] = strconv.Itoa(max(*body.Cooldown, 1))
	}
	if body.Targets != nil {
		for _, t := range *body.Targets {
			p, err := provider.Get(t.Provider)
			if err != nil {
				writeErr(w, http.StatusBadRequest, err.Error())
				return
			}
			ok := false
			for _, reg := range p.Regions() {
				ok = ok || reg.ID == t.Region
			}
			if !ok {
				writeErr(w, http.StatusBadRequest, "unknown region "+t.String())
				return
			}
		}
		kv[settings.KeyTargets] = settings.FormatTargets(*body.Targets)
	}
	if body.Paused != nil {
		kv[settings.KeyPaused] = strconv.FormatBool(*body.Paused)
	}
	if body.RetentionDays != nil {
		if *body.RetentionDays < 1 {
			writeErr(w, http.StatusBadRequest, "保留天数至少 1 天")
			return
		}
		kv[settings.KeyRetentionDays] = strconv.Itoa(*body.RetentionDays)
	}
	if err := s.Settings.Set(r.Context(), kv); err != nil {
		s.internal(w, err)
		return
	}
	s.getSettings(w, r)
}

func (s *Server) testNotify(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	for _, n := range s.Notifiers {
		if n.Name() != "telegram" {
			continue
		}
		err := n.SendTest(ctx)
		_ = s.Store.RecordNotification(ctx, store.Notification{Channel: n.Name(), OK: err == nil, Error: errString(err), At: time.Now()})
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (s *Server) pollNow(w http.ResponseWriter, r *http.Request) {
	s.Monitor.PollNow()
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, unsub := s.Hub.Subscribe()
	defer unsub()

	send := func(m monitor.Message) bool {
		b, _ := json.Marshal(m.Data)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", m.Type, b); err != nil {
			return false
		}
		fl.Flush()
		return true
	}
	if !send(monitor.Message{Type: "poll", Data: s.Monitor.Status()}) {
		return
	}
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case m, ok := <-ch:
			if !ok || !send(m) {
				return
			}
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}
