// Package provider defines the abstraction every cloud vendor integration implements.
package provider

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

type StockStatus string

const (
	StatusAvailable   StockStatus = "available"
	StatusLow         StockStatus = "low"
	StatusUnavailable StockStatus = "unavailable"
	StatusUnknown     StockStatus = "unknown"
)

// InStock reports whether the status means the item can be ordered now.
func (s StockStatus) InStock() bool { return s == StatusAvailable || s == StatusLow }

type Region struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Currency string `json:"currency"`
}

// Product is catalog metadata used for display (name, specs, price).
type Product struct {
	Provider  string            `json:"provider"`
	Region    string            `json:"region"`
	Code      string            `json:"code"`
	Name      string            `json:"name"`
	Family    string            `json:"family"`
	Specs     map[string]string `json:"specs"`
	Price     float64           `json:"price"`    // monthly, excluding tax, for the default configuration
	SetupFee  float64           `json:"setupFee"` // one-time installation fee without commitment, excluding tax
	Currency  string            `json:"currency"`
	Locations []string          `json:"locations"`
	OrderURL  string            `json:"orderUrl"`
	Options   []Option          `json:"options,omitempty"`
}

// Option is one orderable hardware choice (memory, storage, bandwidth…) priced on top of the base plan.
type Option struct {
	Family   string  `json:"family"`
	Code     string  `json:"code"`
	Price    float64 `json:"price"`    // monthly surcharge, excluding tax
	SetupFee float64 `json:"setupFee"` // one-time surcharge, excluding tax
}

// ConfigPrice is what one concrete configuration costs (base plan plus its options).
type ConfigPrice struct {
	Price    float64 `json:"price"`
	SetupFee float64 `json:"setupFee"`
}

// ConfigPricer is implemented by providers whose configurations are priced differently.
// ok is false when the configuration can't be matched to catalog options.
type ConfigPricer interface {
	ConfigPrice(p Product, config string) (price ConfigPrice, ok bool)
}

// Availability is the stock state of one product configuration at one location.
type Availability struct {
	Provider    string            `json:"provider"`
	Region      string            `json:"region"`
	ProductCode string            `json:"productCode"`
	Config      string            `json:"config"` // vendor-specific configuration id (OVH: fqn)
	Location    string            `json:"location"`
	Status      StockStatus       `json:"status"`
	RawState    string            `json:"rawState"`
	Extra       map[string]string `json:"extra,omitempty"`
}

// Key uniquely identifies an availability slot across providers.
func (a Availability) Key() string {
	return strings.Join([]string{a.Provider, a.Region, a.Config, a.Location}, "|")
}

type Provider interface {
	ID() string
	Name() string
	Regions() []Region
	FetchCatalog(ctx context.Context, region string) ([]Product, error)
	FetchAvailability(ctx context.Context, region string) ([]Availability, error)
}

var (
	mu       sync.RWMutex
	registry = map[string]Provider{}
)

func Register(p Provider) {
	mu.Lock()
	defer mu.Unlock()
	registry[p.ID()] = p
}

func Get(id string) (Provider, error) {
	mu.RLock()
	defer mu.RUnlock()
	p, ok := registry[id]
	if !ok {
		return nil, fmt.Errorf("unknown provider %q", id)
	}
	return p, nil
}

func All() []Provider {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]Provider, 0, len(registry))
	for _, p := range registry {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}
