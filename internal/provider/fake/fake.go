// Package fake is a demo provider whose stock flips on every fetch. Enable with SW_FAKE_PROVIDER=1
// to exercise notifications end to end without waiting for a real restock.
package fake

import (
	"context"
	"sync"

	"github.com/gucc/stockwatch/internal/provider"
)

type Provider struct {
	mu    sync.Mutex
	step  int
	state map[string]provider.StockStatus
}

func New() *Provider { return &Provider{state: map[string]provider.StockStatus{}} }

func (p *Provider) ID() string   { return "fake" }
func (p *Provider) Name() string { return "Fake Cloud" }
func (p *Provider) Regions() []provider.Region {
	return []provider.Region{{ID: "test", Name: "测试区域", Currency: "EUR"}}
}

var (
	products  = []string{"fake-small", "fake-large"}
	configs   = []string{"ram-16g.ssd-500", "ram-64g.nvme-2000"}
	locations = []string{"aaa", "bbb"}
)

func (p *Provider) FetchCatalog(ctx context.Context, region string) ([]provider.Product, error) {
	return []provider.Product{
		{Provider: "fake", Region: region, Code: "fake-small", Name: "FAKE-S", Family: "Fake", Specs: map[string]string{"cpu": "Fake CPU 4c"}, Price: 4.99, Currency: "EUR", Locations: locations, OrderURL: "https://example.com/order"},
		{Provider: "fake", Region: region, Code: "fake-large", Name: "FAKE-L", Family: "Fake", Specs: map[string]string{"cpu": "Fake CPU 16c"}, Price: 39.99, Currency: "EUR", Locations: locations, OrderURL: "https://example.com/order"},
	}, nil
}

func (p *Provider) FetchAvailability(ctx context.Context, region string) ([]provider.Availability, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []provider.Availability
	i := 0
	n := len(products) * len(configs) * len(locations)
	flip := p.step % n
	p.step++
	for _, prod := range products {
		for _, cfg := range configs {
			for _, loc := range locations {
				k := prod + cfg + loc
				st, ok := p.state[k]
				if !ok {
					st = provider.StatusUnavailable
				}
				if i == flip {
					if st == provider.StatusUnavailable {
						st = provider.StatusAvailable
					} else {
						st = provider.StatusUnavailable
					}
				}
				p.state[k] = st
				raw := "unavailable"
				if st == provider.StatusAvailable {
					raw = "1H-high"
				}
				out = append(out, provider.Availability{
					Provider: "fake", Region: region, ProductCode: prod, Config: prod + "." + cfg,
					Location: loc, Status: st, RawState: raw,
				})
				i++
			}
		}
	}
	return out, nil
}
