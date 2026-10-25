package ovh

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/gucc/stockwatch/internal/provider"
)

func TestMapStatus(t *testing.T) {
	cases := map[string]provider.StockStatus{
		"unavailable": provider.StatusUnavailable,
		"comingSoon":  provider.StatusUnavailable,
		"unknown":     provider.StatusUnknown,
		"":            provider.StatusUnknown,
		"1H-low":      provider.StatusLow,
		"1H-high":     provider.StatusAvailable,
		"72H":         provider.StatusAvailable,
		"480H":        provider.StatusAvailable,
		"weird":       provider.StatusUnknown,
	}
	for in, want := range cases {
		if got := MapStatus(in); got != want {
			t.Errorf("MapStatus(%q) = %s, want %s", in, got, want)
		}
	}
}

func fixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	serve := func(path, file string) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			b, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(b)
		})
	}
	serve("/dedicated/server/datacenter/availabilities", "testdata/availabilities.json")
	serve("/order/catalog/public/eco", "testdata/catalog.json")
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchAvailability(t *testing.T) {
	srv := fixtureServer(t)
	p := New(5 * time.Second)
	p.baseOverride = srv.URL

	got, err := p.FetchAvailability(context.Background(), "eu")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 14 {
		t.Fatalf("got %d slots, want 14", len(got))
	}
	first := got[0]
	if first.Provider != "ovh" || first.Region != "eu" || first.ProductCode != "24sk602" {
		t.Errorf("unexpected identity: %+v", first)
	}
	if first.Location != "bhs" || first.Status != provider.StatusLow || first.RawState != "1H-low" {
		t.Errorf("unexpected state: %+v", first)
	}
	if first.Config != "24sk602.ram-128g-ecc-2400.softraid-2x1000nvme" || first.Extra["memory"] != "ram-128g-ecc-2400" {
		t.Errorf("unexpected config: %+v", first)
	}
	counts := map[provider.StockStatus]int{}
	for _, a := range got {
		counts[a.Status]++
	}
	if counts[provider.StatusAvailable] != 1 || counts[provider.StatusLow] != 1 || counts[provider.StatusUnavailable] != 12 {
		t.Errorf("unexpected status counts: %v", counts)
	}

	if _, err := p.FetchAvailability(context.Background(), "nope"); err == nil {
		t.Error("expected error for unknown region")
	}
}

func TestFetchCatalog(t *testing.T) {
	srv := fixtureServer(t)
	p := New(5 * time.Second)
	p.baseOverride = srv.URL

	got, err := p.FetchCatalog(context.Background(), "eu")
	if err != nil {
		t.Fatal(err)
	}
	byCode := map[string]provider.Product{}
	for _, pr := range got {
		byCode[pr.Code] = pr
	}
	ks, ok := byCode["24sk602"]
	if !ok {
		t.Fatalf("24sk602 missing from %v", got)
	}
	if ks.Name != "KS-6" || ks.Family != "Kimsufi" || ks.Currency != "EUR" {
		t.Errorf("unexpected product: %+v", ks)
	}
	if ks.Price <= 0 {
		t.Errorf("expected a monthly price, got %v", ks.Price)
	}
	if ks.Specs["cpu"] == "" || len(ks.Locations) == 0 {
		t.Errorf("expected cpu and locations: %+v", ks)
	}
	adv := byCode["24adv01-v3"]
	if adv.Family != "Advance" || adv.Specs["cores"] != "6c/12t" {
		t.Errorf("unexpected advance product: %+v", adv)
	}
	if ks.Price != 38.99 || ks.SetupFee != 38.99 {
		t.Errorf("price/setup = %v/%v, want 38.99/38.99", ks.Price, ks.SetupFee)
	}
	if len(ks.Options) != 7 {
		t.Errorf("got %d options, want 7 (2 memory + 4 storage + 1 bandwidth): %+v", len(ks.Options), ks.Options)
	}

	// Configuration prices: base 38.99 + memory option + storage option.
	for config, want := range map[string]float64{
		"24sk602.ram-128g-ecc-2400.softraid-2x4000sa":   38.99,
		"24sk602.ram-128g-ecc-2400.softraid-2x1000nvme": 38.99 + 15,
		"24sk602.ram-256g-ecc-2400.softraid-2x8000sa":   38.99 + 32 + 10,
	} {
		got, ok := p.ConfigPrice(ks, config)
		if !ok || math.Abs(got.Price-want) > 1e-9 || got.SetupFee != 38.99 {
			t.Errorf("ConfigPrice(%s) = %+v, %v; want %.2f", config, got, ok, want)
		}
	}
	if _, ok := p.ConfigPrice(ks, "24sk602.ram-512g-ecc-2400.softraid-2x4000sa"); ok {
		t.Error("expected no price for a memory size the catalog doesn't offer")
	}
}

func TestMatchOptionFallbacks(t *testing.T) {
	opts := []provider.Option{
		{Family: "memory", Code: "ram-32g-ecc-2400-26sk10b-v1", Price: 0},
		{Family: "memory", Code: "ram-64g-ecc-2400-26sk10b-v1", Price: 10},
		{Family: "storage", Code: "softraid-0disk-24rise", Price: 0},
		{Family: "storage", Code: "hybridsoftraid-2x4000sa-2x512nvme-24sys", Price: 20},
	}
	cases := []struct {
		family, code, want string
	}{
		{"memory", "ram-32g-ecc-2133", "ram-32g-ecc-2400-26sk10b-v1"}, // same size, different speed
		{"storage", "noraid-0", "softraid-0disk-24rise"},              // diskless
		{"storage", "hybridsoftraid-2x4000sa-2x512nvme", "hybridsoftraid-2x4000sa-2x512nvme-24sys"},
		{"storage", "hybridsoftraid-2x4000sa-2x500nvme", ""}, // different disks: no guess
	}
	for _, c := range cases {
		got, ok := matchOption(opts, c.family, c.code)
		if c.want == "" {
			if ok {
				t.Errorf("matchOption(%s) = %s, want no match", c.code, got.Code)
			}
		} else if !ok || got.Code != c.want {
			t.Errorf("matchOption(%s) = %s, %v; want %s", c.code, got.Code, ok, c.want)
		}
	}
}
