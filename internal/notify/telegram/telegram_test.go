package telegram

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gucc/stockwatch/internal/notify"
	"github.com/gucc/stockwatch/internal/provider"
	"github.com/gucc/stockwatch/internal/settings"
	"github.com/gucc/stockwatch/internal/store"
)

func TestFormatAlert(t *testing.T) {
	a := notify.Alert{
		Subscription: store.Subscription{ProductCode: "24sk602", Region: "eu", Note: "<买>"},
		ProviderName: "OVHcloud",
		Product:      &provider.Product{Name: "KS-6", Price: 12.99, Currency: "EUR", Specs: map[string]string{"cpu": "AMD Epyc 7351P"}, OrderURL: "https://eco.ovhcloud.com/fr/"},
		Events: []store.Event{
			{ProductCode: "24sk602", Config: "24sk602.ram-128g-ecc-2400.softraid-2x1000nvme", Location: "gra", From: provider.StatusUnavailable, To: provider.StatusAvailable, RawState: "72H"},
		},
	}
	got := FormatAlert(a)
	for _, want := range []string{"补货", "<b>KS-6</b>", "12.99 EUR/月", "🇫🇷 格拉沃利讷 (GRA)", "内存 128GB ECC 2400MHz · 硬盘 2×1TB NVMe · 软 RAID", "OVHcloud EU", "CPU AMD Epyc 7351P", "72 小时内交付", "&lt;买&gt;", "前往下单"} {
		if !strings.Contains(got, want) {
			t.Errorf("alert missing %q:\n%s", want, got)
		}
	}
}

type fakeCmds struct{ paused bool }

func (f *fakeCmds) StatusText(context.Context) string        { return "status!" }
func (f *fakeCmds) SubscriptionsText(context.Context) string { return "subs!" }
func (f *fakeCmds) SetPaused(_ context.Context, p bool) error {
	f.paused = p
	return nil
}

func TestSendAndCommands(t *testing.T) {
	var mu sync.Mutex
	var sent []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/botTOKEN/") {
			http.Error(w, "bad token", 401)
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		sent = append(sent, body)
		mu.Unlock()
		w.Write([]byte(`{"ok":true,"result":{}}`))
	}))
	defer srv.Close()

	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	set := settings.New(st, settings.Overrides{})
	tg := New(set, srv.URL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx := context.Background()

	if tg.Configured(ctx) {
		t.Fatal("should not be configured yet")
	}
	if err := tg.SendTest(ctx); err == nil {
		t.Fatal("expected error when unconfigured")
	}
	set.Set(ctx, map[string]string{settings.KeyTelegramToken: "TOKEN", settings.KeyTelegramChatID: "1, 2"})
	if err := tg.SendTest(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || sent[0]["chat_id"] != "1" || sent[1]["chat_id"] != "2" || sent[0]["parse_mode"] != "HTML" {
		t.Fatalf("unexpected requests: %+v", sent)
	}

	cmds := &fakeCmds{}
	if got := tg.handleCommand(ctx, cmds, "/status@MyBot"); got != "status!" {
		t.Errorf("status: %q", got)
	}
	tg.handleCommand(ctx, cmds, "/pause")
	if !cmds.paused {
		t.Error("pause not applied")
	}
	if got := tg.handleCommand(ctx, cmds, "hello"); got != "" {
		t.Errorf("non-command should be ignored, got %q", got)
	}
}
