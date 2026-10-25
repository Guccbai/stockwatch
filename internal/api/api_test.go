package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/gucc/stockwatch/internal/auth"
	"github.com/gucc/stockwatch/internal/monitor"
	"github.com/gucc/stockwatch/internal/provider"
	"github.com/gucc/stockwatch/internal/provider/fake"
	"github.com/gucc/stockwatch/internal/settings"
	"github.com/gucc/stockwatch/internal/store"
)

func newTestServer(t *testing.T) (*httptest.Server, *http.Client) {
	t.Helper()
	provider.Register(fake.New())
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	set := settings.New(st, settings.Overrides{})
	au := auth.New(st, set)
	if _, err := au.EnsurePassword(context.Background(), "correct-horse"); err != nil {
		t.Fatal(err)
	}
	hub := monitor.NewHub()
	mon := monitor.New(st, set, nil, hub, log)
	p, _ := provider.Get("fake")
	tgt := settings.Target{Provider: "fake", Region: "test"}
	for i := 0; i < 3; i++ {
		if err := mon.PollOnce(context.Background(), p, tgt); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer((&Server{Store: st, Settings: set, Auth: au, Monitor: mon, Hub: hub, Log: log}).Handler())
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	return srv, &http.Client{Jar: jar, Timeout: 5 * time.Second}
}

func do(t *testing.T, c *http.Client, method, url string, body any, out any) int {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, url, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

func TestAPIFlow(t *testing.T) {
	srv, c := newTestServer(t)
	u := srv.URL + "/api"

	if code := do(t, c, "GET", u+"/subscriptions", nil, nil); code != 401 {
		t.Fatalf("want 401 before login, got %d", code)
	}
	if code := do(t, c, "POST", u+"/auth/login", map[string]string{"password": "wrong-pass"}, nil); code != 401 {
		t.Fatalf("want 401 for bad password, got %d", code)
	}
	if code := do(t, c, "POST", u+"/auth/login", map[string]string{"password": "correct-horse"}, nil); code != 200 {
		t.Fatalf("login failed: %d", code)
	}

	var created store.Subscription
	code := do(t, c, "POST", u+"/subscriptions", map[string]any{"provider": "fake", "region": "test", "productCode": "fake-small", "locations": []string{"aaa"}, "enabled": true}, &created)
	if code != 201 || created.ID == 0 || created.NotifyOn != "restock" {
		t.Fatalf("create: %d %+v", code, created)
	}
	if code := do(t, c, "POST", u+"/subscriptions", map[string]any{"provider": "fake", "region": "mars", "productCode": "x"}, nil); code != 400 {
		t.Fatalf("want 400 for unknown region, got %d", code)
	}
	created.Note = "hi"
	var updated store.Subscription
	if code := do(t, c, "PUT", u+"/subscriptions/"+itoa(created.ID), created, &updated); code != 200 || updated.Note != "hi" {
		t.Fatalf("update: %d %+v", code, updated)
	}

	var stock struct {
		Locations []string         `json:"locations"`
		Products  []productSummary `json:"products"`
	}
	if code := do(t, c, "GET", u+"/stock?provider=fake&region=test", nil, &stock); code != 200 {
		t.Fatalf("stock: %d", code)
	}
	if len(stock.Products) != 2 || len(stock.Locations) != 2 || stock.Products[0].Total != 4 {
		t.Fatalf("unexpected stock: %+v", stock)
	}
	for _, p := range stock.Products {
		if p.Code == "fake-small" && p.Locations["aaa"].InStock != 2 {
			t.Errorf("fake-small/aaa should have two in-stock configs after 3 flips: %+v", p.Locations["aaa"])
		}
	}

	var det struct {
		Configs []configDetail `json:"configs"`
	}
	do(t, c, "GET", u+"/stock/detail?provider=fake&region=test&product=fake-small", nil, &det)
	if len(det.Configs) != 2 {
		t.Fatalf("detail configs: %+v", det)
	}

	var evs []store.Event
	do(t, c, "GET", u+"/events?restock=1", nil, &evs)
	if len(evs) != 2 {
		t.Errorf("want 2 restock events, got %d", len(evs))
	}

	var sv settingsView
	if code := do(t, c, "PUT", u+"/settings", map[string]any{"interval": 5}, nil); code != 400 {
		t.Errorf("want 400 for too-small interval, got %d", code)
	}
	do(t, c, "PUT", u+"/settings", map[string]any{"interval": 30, "telegramToken": "123456:ABCDEFGHIJ", "telegramChatId": "42"}, &sv)
	if sv.Interval != 30 || !sv.TelegramTokenSet || sv.TelegramTokenHint != "1234…GHIJ" || sv.TelegramChatID != "42" {
		t.Errorf("unexpected settings: %+v", sv)
	}

	if code := do(t, c, "DELETE", u+"/subscriptions/"+itoa(created.ID), nil, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	do(t, c, "POST", u+"/auth/logout", nil, nil)
	if code := do(t, c, "GET", u+"/subscriptions", nil, nil); code != 401 {
		t.Fatalf("want 401 after logout, got %d", code)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
