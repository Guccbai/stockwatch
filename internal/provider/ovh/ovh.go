// Package ovh implements stock monitoring for OVHcloud dedicated servers
// (Kimsufi, So you Start, Rise, Advance, …) using OVH's public, unauthenticated API.
package ovh

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gucc/stockwatch/internal/provider"
)

type regionInfo struct {
	provider.Region
	APIBase    string
	Subsidiary string
	OrderURL   string
}

var regions = []regionInfo{
	{provider.Region{ID: "eu", Name: "欧洲", Currency: "EUR"}, "https://eu.api.ovh.com/1.0", "FR", "https://eco.ovhcloud.com/fr/"},
	{provider.Region{ID: "ca", Name: "加拿大", Currency: "CAD"}, "https://ca.api.ovh.com/1.0", "CA", "https://eco.ovhcloud.com/en-ca/"},
	{provider.Region{ID: "us", Name: "美国", Currency: "USD"}, "https://api.us.ovhcloud.com/1.0", "US", "https://us.ovhcloud.com/bare-metal/"},
}

type Provider struct {
	client *http.Client
	// baseOverride replaces every region's API base; used by tests.
	baseOverride string
}

func New(timeout time.Duration) *Provider {
	return &Provider{client: &http.Client{Timeout: timeout}}
}

func (p *Provider) ID() string   { return "ovh" }
func (p *Provider) Name() string { return "OVHcloud" }

func (p *Provider) Regions() []provider.Region {
	out := make([]provider.Region, len(regions))
	for i, r := range regions {
		out[i] = r.Region
	}
	return out
}

func lookupRegion(id string) (regionInfo, error) {
	for _, r := range regions {
		if r.ID == id {
			return r, nil
		}
	}
	return regionInfo{}, fmt.Errorf("ovh: unknown region %q", id)
}

func (p *Provider) base(r regionInfo) string {
	if p.baseOverride != "" {
		return p.baseOverride
	}
	return r.APIBase
}

func (p *Provider) getJSON(ctx context.Context, u string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "stockwatch/1.0 (+https://github.com/gucc/stockwatch)")
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("ovh: GET %s: %s: %s", u, resp.Status, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// --- availability ---

type availabilityEntry struct {
	FQN           string `json:"fqn"`
	PlanCode      string `json:"planCode"`
	Server        string `json:"server"`
	Memory        string `json:"memory"`
	Storage       string `json:"storage"`
	SystemStorage string `json:"systemStorage"`
	Datacenters   []struct {
		Availability string `json:"availability"`
		Datacenter   string `json:"datacenter"`
	} `json:"datacenters"`
}

// MapStatus converts OVH availability strings ("1H-high", "72H", "unavailable", …) to a normalized status.
func MapStatus(raw string) provider.StockStatus {
	switch {
	case raw == "unavailable" || raw == "comingSoon":
		return provider.StatusUnavailable
	case raw == "" || raw == "unknown":
		return provider.StatusUnknown
	case strings.HasSuffix(raw, "-low"):
		return provider.StatusLow
	case strings.HasSuffix(raw, "H") || strings.HasSuffix(raw, "-high"):
		return provider.StatusAvailable
	default:
		return provider.StatusUnknown
	}
}

func (p *Provider) FetchAvailability(ctx context.Context, region string) ([]provider.Availability, error) {
	r, err := lookupRegion(region)
	if err != nil {
		return nil, err
	}
	var entries []availabilityEntry
	if err := p.getJSON(ctx, p.base(r)+"/dedicated/server/datacenter/availabilities", &entries); err != nil {
		return nil, err
	}
	return convertAvailability(region, entries), nil
}

func convertAvailability(region string, entries []availabilityEntry) []provider.Availability {
	out := make([]provider.Availability, 0, len(entries)*6)
	for _, e := range entries {
		extra := map[string]string{"memory": e.Memory, "storage": e.Storage}
		if e.SystemStorage != "" {
			extra["systemStorage"] = e.SystemStorage
		}
		for _, dc := range e.Datacenters {
			out = append(out, provider.Availability{
				Provider:    "ovh",
				Region:      region,
				ProductCode: e.PlanCode,
				Config:      e.FQN,
				Location:    dc.Datacenter,
				Status:      MapStatus(dc.Availability),
				RawState:    dc.Availability,
				Extra:       extra,
			})
		}
	}
	return out
}

// --- catalog ---

type catalog struct {
	Locale struct {
		CurrencyCode string `json:"currencyCode"`
	} `json:"locale"`
	Plans []struct {
		PlanCode    string `json:"planCode"`
		InvoiceName string `json:"invoiceName"`
		Product     string `json:"product"`
		Pricings    []struct {
			Capacities   []string `json:"capacities"`
			Commitment   int      `json:"commitment"`
			Interval     int      `json:"interval"`
			IntervalUnit string   `json:"intervalUnit"`
			Mode         string   `json:"mode"`
			Price        int64    `json:"price"` // in 1e-8 of the currency unit
		} `json:"pricings"`
		Configurations []struct {
			Name   string   `json:"name"`
			Values []string `json:"values"`
		} `json:"configurations"`
		AddonFamilies []struct {
			Name    string `json:"name"`
			Default string `json:"default"`
		} `json:"addonFamilies"`
	} `json:"plans"`
	Products []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Blobs       *struct {
			Technical *struct {
				Server *struct {
					Range string `json:"range"`
					CPU   *struct {
						Brand     string  `json:"brand"`
						Model     string  `json:"model"`
						Cores     int     `json:"cores"`
						Threads   int     `json:"threads"`
						Frequency float64 `json:"frequency"`
						Number    int     `json:"number"`
					} `json:"cpu"`
				} `json:"server"`
			} `json:"technical"`
		} `json:"blobs"`
	} `json:"products"`
}

func (p *Provider) FetchCatalog(ctx context.Context, region string) ([]provider.Product, error) {
	r, err := lookupRegion(region)
	if err != nil {
		return nil, err
	}
	var c catalog
	u := p.base(r) + "/order/catalog/public/eco?ovhSubsidiary=" + url.QueryEscape(r.Subsidiary)
	if err := p.getJSON(ctx, u, &c); err != nil {
		return nil, err
	}
	return convertCatalog(r, &c), nil
}

var familyByPrefix = []struct{ prefix, family string }{
	{"KS-", "Kimsufi"},
	{"SYS-", "So you Start"},
	{"RISE-", "Rise"},
	{"ADVANCE-", "Advance"},
	{"SCALE-", "Scale"},
	{"HGR-", "High Grade"},
}

func convertCatalog(r regionInfo, c *catalog) []provider.Product {
	type tech struct {
		rng, cpu string
		cores    int
		threads  int
		freq     float64
	}
	techs := map[string]tech{}
	for _, pr := range c.Products {
		t := tech{cpu: pr.Description}
		if pr.Blobs != nil && pr.Blobs.Technical != nil && pr.Blobs.Technical.Server != nil {
			s := pr.Blobs.Technical.Server
			t.rng = s.Range
			if s.CPU != nil {
				t.cpu = strings.TrimSpace(s.CPU.Brand + " " + s.CPU.Model)
				t.cores, t.threads, t.freq = s.CPU.Cores, s.CPU.Threads, s.CPU.Frequency
				if s.CPU.Number > 1 {
					t.cpu = fmt.Sprintf("%dx %s", s.CPU.Number, t.cpu)
				}
			}
		}
		techs[pr.Name] = t
	}

	currency := c.Locale.CurrencyCode
	if currency == "" {
		currency = r.Currency
	}
	out := make([]provider.Product, 0, len(c.Plans))
	for _, pl := range c.Plans {
		name := pl.InvoiceName
		if i := strings.Index(name, "|"); i > 0 {
			name = strings.TrimSpace(name[:i])
		}
		t := techs[pl.Product]
		family := t.rng
		if family != "" {
			family = strings.ToUpper(family[:1]) + family[1:]
		}
		for _, f := range familyByPrefix {
			if strings.HasPrefix(strings.ToUpper(name), f.prefix) {
				family = f.family
				break
			}
		}

		specs := map[string]string{}
		if t.cpu != "" {
			specs["cpu"] = t.cpu
		}
		if t.cores > 0 {
			specs["cores"] = fmt.Sprintf("%dc/%dt", t.cores, t.threads)
		}
		if t.freq > 0 {
			specs["frequency"] = fmt.Sprintf("%.1f GHz", t.freq)
		}
		for _, af := range pl.AddonFamilies {
			if (af.Name == "memory" || af.Name == "storage" || af.Name == "bandwidth") && af.Default != "" {
				specs[af.Name] = af.Default
			}
		}

		var locations []string
		for _, cf := range pl.Configurations {
			if cf.Name == "dedicated_datacenter" {
				locations = cf.Values
			}
		}

		var price int64 = -1
		for _, pr := range pl.Pricings {
			if pr.Interval == 1 && pr.IntervalUnit == "month" && pr.Commitment == 0 && pr.Mode == "default" && contains(pr.Capacities, "renew") {
				if price < 0 || pr.Price < price {
					price = pr.Price
				}
			}
		}

		out = append(out, provider.Product{
			Provider:  "ovh",
			Region:    r.ID,
			Code:      pl.PlanCode,
			Name:      name,
			Family:    family,
			Specs:     specs,
			Price:     float64(max(price, 0)) / 1e8,
			Currency:  currency,
			Locations: locations,
			OrderURL:  r.OrderURL,
		})
	}
	return out
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
