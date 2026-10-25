// Package notify defines notification channels.
package notify

import (
	"context"

	"github.com/Guccbai/stockwatch/internal/provider"
	"github.com/Guccbai/stockwatch/internal/store"
)

// Alert groups the transitions of one poll that matched one subscription.
type Alert struct {
	Subscription store.Subscription
	ProviderName string
	Product      *provider.Product // nil when the product is missing from the catalog
	Events       []store.Event
}

type Notifier interface {
	Name() string
	Configured(ctx context.Context) bool
	Notify(ctx context.Context, a Alert) error
	SendTest(ctx context.Context) error
}
