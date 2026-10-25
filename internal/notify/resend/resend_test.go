package resend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Guccbai/stockwatch/internal/notify"
	"github.com/Guccbai/stockwatch/internal/provider"
	"github.com/Guccbai/stockwatch/internal/settings"
	"github.com/Guccbai/stockwatch/internal/store"
)

func TestSend(t *testing.T) {
	var sent []map[string]any
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/emails" || r.Header.Get("Authorization") != "Bearer re_KEY" {
			w.WriteHeader(401)
			w.Write([]byte(`{"statusCode":401,"message":"API key is invalid","name":"validation_error"}`))
			return
		}
		if calls == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(429)
			w.Write([]byte(`{"message":"Too many requests"}`))
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		sent = append(sent, body)
		w.Write([]byte(`{"id":"abc"}`))
	}))
	defer srv.Close()

	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	set := settings.New(st, settings.Overrides{})
	rs := New(set, srv.URL)
	ctx := context.Background()

	if rs.Configured(ctx) {
		t.Fatal("should not be configured yet")
	}
	if err := rs.SendTest(ctx); err == nil {
		t.Fatal("expected error when unconfigured")
	}
	set.Set(ctx, map[string]string{settings.KeyResendAPIKey: "re_BAD", settings.KeyResendFrom: "StockWatch <sw@example.com>", settings.KeyResendTo: "a@example.com, b@example.com"})
	if err := rs.SendTest(ctx); err == nil || !strings.Contains(err.Error(), "API key is invalid") {
		t.Fatalf("want API error, got %v", err)
	}
	set.Set(ctx, map[string]string{settings.KeyResendAPIKey: "re_KEY"})
	calls = 0

	a := notify.Alert{
		Subscription: store.Subscription{ProductCode: "24sk602", Region: "eu"},
		ProviderName: "OVHcloud",
		Product:      &provider.Product{Name: "KS-6", OrderURL: "https://eco.ovhcloud.com/fr/"},
		Events:       []store.Event{{ProductCode: "24sk602", Location: "gra", From: provider.StatusUnavailable, To: provider.StatusAvailable, RawState: "72H"}},
	}
	if err := rs.Notify(ctx, a); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(sent) != 1 {
		t.Fatalf("want one retry after 429, calls=%d sent=%d", calls, len(sent))
	}
	m := sent[0]
	to, _ := m["to"].([]any)
	if len(to) != 2 || to[1] != "b@example.com" || m["from"] != "StockWatch <sw@example.com>" {
		t.Errorf("unexpected recipients: %+v", m)
	}
	if subj, _ := m["subject"].(string); !strings.Contains(subj, "补货 KS-6 (24sk602)") {
		t.Errorf("subject: %q", subj)
	}
	if h, _ := m["html"].(string); !strings.Contains(h, "<br>") || !strings.Contains(h, `<a href="https://eco.ovhcloud.com/fr/">`) {
		t.Errorf("html: %s", h)
	}
	if txt, _ := m["text"].(string); strings.Contains(txt, "<b>") || !strings.Contains(txt, "https://eco.ovhcloud.com/fr/") {
		t.Errorf("text: %s", txt)
	}
}
