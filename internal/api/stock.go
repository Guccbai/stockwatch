package api

import (
	"sort"
	"strings"
	"time"

	"github.com/gucc/stockwatch/internal/provider"
	"github.com/gucc/stockwatch/internal/store"
)

var statusRank = map[provider.StockStatus]int{
	provider.StatusAvailable:   3,
	provider.StatusLow:         2,
	provider.StatusUnavailable: 1,
	provider.StatusUnknown:     0,
}

type locationSummary struct {
	Status  provider.StockStatus `json:"status"`
	Raw     string               `json:"raw"` // fastest delivery among the best-status slots
	InStock int                  `json:"inStock"`
	Total   int                  `json:"total"`
}

type productSummary struct {
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Family   string  `json:"family"`
	Price    float64 `json:"price"`    // default configuration
	SetupFee float64 `json:"setupFee"` // one-time, without commitment
	// InStockPrice is the cheapest configuration currently in stock (0 when none, or unpriced).
	InStockPrice float64                     `json:"inStockPrice,omitempty"`
	Currency     string                      `json:"currency"`
	Specs        map[string]string           `json:"specs"`
	OrderURL     string                      `json:"orderUrl"`
	InCatalog    bool                        `json:"inCatalog"`
	InStock      int                         `json:"inStock"`
	Total        int                         `json:"total"`
	LastChange   time.Time                   `json:"lastChange"`
	Locations    map[string]*locationSummary `json:"locations"`
}

// deliveryHours orders OVH raw states such as "1H-high" < "24H" < "72H".
func deliveryHours(raw string) int {
	s := strings.SplitN(raw, "-", 2)[0]
	s = strings.TrimSuffix(s, "H")
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 1 << 30
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return 1 << 30
	}
	return n
}

func better(a, b store.StockRow) bool {
	if ra, rb := statusRank[a.Status], statusRank[b.Status]; ra != rb {
		return ra > rb
	}
	return deliveryHours(a.RawState) < deliveryHours(b.RawState)
}

// configPrice prices one configuration when the provider supports it.
func configPrice(pricer provider.ConfigPricer, prod *provider.Product, config string) (provider.ConfigPrice, bool) {
	if pricer == nil || prod == nil {
		return provider.ConfigPrice{}, false
	}
	return pricer.ConfigPrice(*prod, config)
}

func summarize(rows []store.StockRow, products []provider.Product, pricer provider.ConfigPricer) ([]productSummary, []string) {
	byCode := map[string]*productSummary{}
	catalog := map[string]*provider.Product{}
	for i, p := range products {
		catalog[p.Code] = &products[i]
		byCode[p.Code] = &productSummary{
			Code: p.Code, Name: p.Name, Family: p.Family, Price: p.Price, SetupFee: p.SetupFee, Currency: p.Currency,
			Specs: p.Specs, OrderURL: p.OrderURL, InCatalog: true, Locations: map[string]*locationSummary{},
		}
	}
	priced := map[string]float64{} // config -> monthly price, computed once per config
	priceOf := func(code, config string) (float64, bool) {
		if v, ok := priced[config]; ok {
			return v, v > 0
		}
		cp, ok := configPrice(pricer, catalog[code], config)
		priced[config] = cp.Price
		return cp.Price, ok
	}
	best := map[string]store.StockRow{} // code|location -> best row
	locSet := map[string]bool{}
	for _, r := range rows {
		ps := byCode[r.ProductCode]
		if ps == nil {
			ps = &productSummary{Code: r.ProductCode, Name: r.ProductCode, Locations: map[string]*locationSummary{}}
			byCode[r.ProductCode] = ps
		}
		locSet[r.Location] = true
		ls := ps.Locations[r.Location]
		if ls == nil {
			ls = &locationSummary{Status: r.Status, Raw: r.RawState}
			ps.Locations[r.Location] = ls
		}
		ls.Total++
		ps.Total++
		if r.Status.InStock() {
			ls.InStock++
			ps.InStock++
			if v, ok := priceOf(r.ProductCode, r.Config); ok && (ps.InStockPrice == 0 || v < ps.InStockPrice) {
				ps.InStockPrice = v
			}
		}
		k := r.ProductCode + "|" + r.Location
		if b, ok := best[k]; !ok || better(r, b) {
			best[k] = r
			ls.Status, ls.Raw = r.Status, r.RawState
		}
		if r.ChangedAt.After(ps.LastChange) {
			ps.LastChange = r.ChangedAt
		}
	}
	out := make([]productSummary, 0, len(byCode))
	for _, ps := range byCode {
		if ps.Total == 0 && !ps.InCatalog {
			continue
		}
		out = append(out, *ps)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].InCatalog != out[j].InCatalog {
			return out[i].InCatalog
		}
		if out[i].Family != out[j].Family {
			return out[i].Family < out[j].Family
		}
		if out[i].Price != out[j].Price {
			return out[i].Price < out[j].Price
		}
		return out[i].Code < out[j].Code
	})
	locs := make([]string, 0, len(locSet))
	for l := range locSet {
		locs = append(locs, l)
	}
	sort.Strings(locs)
	return out, locs
}

// cheapestInStock picks the in-stock slot of a product to order: the cheapest priced configuration,
// else the first in stock. location "" means any location. Empty config when nothing is in stock.
func cheapestInStock(rows []store.StockRow, prod *provider.Product, location string, pricer provider.ConfigPricer) (config, loc string) {
	bestPrice := 0.0
	for _, r := range rows {
		if r.ProductCode != prod.Code || location != "" && r.Location != location || !r.Status.InStock() {
			continue
		}
		cp, ok := configPrice(pricer, prod, r.Config)
		if config == "" || ok && (bestPrice == 0 || cp.Price < bestPrice) {
			config, loc, bestPrice = r.Config, r.Location, cp.Price
		}
	}
	return config, loc
}

type slotState struct {
	Status    provider.StockStatus `json:"status"`
	Raw       string               `json:"raw"`
	ChangedAt time.Time            `json:"changedAt"`
}

type configDetail struct {
	Config    string                `json:"config"`
	Extra     map[string]string     `json:"extra"`
	Price     *provider.ConfigPrice `json:"price"` // nil when the configuration couldn't be priced
	Locations map[string]slotState  `json:"locations"`
}

func detail(rows []store.StockRow, code string, prod *provider.Product, pricer provider.ConfigPricer) ([]configDetail, []string) {
	byCfg := map[string]*configDetail{}
	locSet := map[string]bool{}
	for _, r := range rows {
		if r.ProductCode != code {
			continue
		}
		c := byCfg[r.Config]
		if c == nil {
			c = &configDetail{Config: r.Config, Extra: r.Extra, Locations: map[string]slotState{}}
			if cp, ok := configPrice(pricer, prod, r.Config); ok {
				c.Price = &cp
			}
			byCfg[r.Config] = c
		}
		c.Locations[r.Location] = slotState{Status: r.Status, Raw: r.RawState, ChangedAt: r.ChangedAt}
		locSet[r.Location] = true
	}
	out := make([]configDetail, 0, len(byCfg))
	for _, c := range byCfg {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Config < out[j].Config })
	locs := make([]string, 0, len(locSet))
	for l := range locSet {
		locs = append(locs, l)
	}
	sort.Strings(locs)
	return out, locs
}
