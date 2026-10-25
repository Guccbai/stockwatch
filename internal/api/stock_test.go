package api

import (
	"strings"
	"testing"

	"github.com/Guccbai/stockwatch/internal/provider"
	"github.com/Guccbai/stockwatch/internal/store"
)

// suffixPricer prices "p.big" at base+100 and "p.small" at base; anything else is unpriced.
type suffixPricer struct{}

func (suffixPricer) ConfigPrice(p provider.Product, config string) (provider.ConfigPrice, bool) {
	switch {
	case strings.HasSuffix(config, ".big"):
		return provider.ConfigPrice{Price: p.Price + 100, SetupFee: p.SetupFee}, true
	case strings.HasSuffix(config, ".small"):
		return provider.ConfigPrice{Price: p.Price, SetupFee: p.SetupFee}, true
	}
	return provider.ConfigPrice{}, false
}

func row(config, loc string, st provider.StockStatus) store.StockRow {
	return store.StockRow{Availability: provider.Availability{ProductCode: "p", Config: config, Location: loc, Status: st}}
}

func TestSummarizeAndDetailPrices(t *testing.T) {
	prod := provider.Product{Code: "p", Name: "P", Price: 10, SetupFee: 5}
	rows := []store.StockRow{
		row("p.big", "rbx", provider.StatusAvailable),
		row("p.small", "rbx", provider.StatusUnavailable),
		row("p.odd", "gra", provider.StatusAvailable),
	}

	sum, _ := summarize(rows, []provider.Product{prod}, suffixPricer{})
	if len(sum) != 1 || sum[0].SetupFee != 5 || sum[0].InStockPrice != 110 {
		t.Fatalf("summary = %+v; want setupFee 5 and in-stock price 110 (small is sold out, odd unpriced)", sum)
	}

	cfgs, _ := detail(rows, "p", &prod, suffixPricer{})
	prices := map[string]*provider.ConfigPrice{}
	for _, c := range cfgs {
		prices[c.Config] = c.Price
	}
	if prices["p.big"] == nil || prices["p.big"].Price != 110 || prices["p.small"].Price != 10 || prices["p.odd"] != nil {
		t.Errorf("detail prices = big %v small %v odd %v", prices["p.big"], prices["p.small"], prices["p.odd"])
	}

	// Providers without per-config pricing still summarize.
	if sum, _ := summarize(rows, []provider.Product{prod}, nil); sum[0].InStockPrice != 0 {
		t.Errorf("in-stock price without pricer = %v, want 0", sum[0].InStockPrice)
	}
}

func TestCheapestInStock(t *testing.T) {
	prod := provider.Product{Code: "p", Price: 10}
	rows := []store.StockRow{
		row("p.odd", "rbx", provider.StatusAvailable),     // in stock but unpriced
		row("p.big", "rbx", provider.StatusLow),           // 110
		row("p.small", "rbx", provider.StatusUnavailable), // cheapest, but sold out
		row("p.small", "gra", provider.StatusAvailable),
	}
	cases := []struct{ loc, wantCfg, wantLoc string }{
		{"rbx", "p.big", "rbx"},
		{"gra", "p.small", "gra"},
		{"sbg", "", ""},
		{"", "p.small", "gra"}, // anywhere: the cheapest in-stock slot
	}
	for _, c := range cases {
		cfg, loc := cheapestInStock(rows, &prod, c.loc, suffixPricer{})
		if cfg != c.wantCfg || loc != c.wantLoc {
			t.Errorf("cheapestInStock(%q) = %q@%q, want %q@%q", c.loc, cfg, loc, c.wantCfg, c.wantLoc)
		}
	}
	if cfg, _ := cheapestInStock(rows, &prod, "rbx", nil); cfg != "p.odd" {
		t.Errorf("without pricer = %q, want first in-stock config", cfg)
	}
}
