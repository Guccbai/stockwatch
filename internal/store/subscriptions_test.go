package store

import (
	"testing"

	"github.com/Guccbai/stockwatch/internal/provider"
)

func TestSubscriptionMatchesConfigs(t *testing.T) {
	sub := Subscription{Provider: "ovh", Region: "eu", ProductCode: "ks-1", Configs: []string{"ks-1.ram-32g.disk-1t"}}
	slot := func(config string) provider.Availability {
		return provider.Availability{Provider: "ovh", Region: "eu", ProductCode: "ks-1", Config: config, Location: "gra"}
	}
	if !sub.Matches(slot("ks-1.ram-32g.disk-1t")) {
		t.Error("subscribed config should match")
	}
	// Exact match: a config whose id merely contains the subscribed one is a different configuration.
	if sub.Matches(slot("ks-1.ram-32g.disk-1t.extra")) || sub.Matches(slot("ks-1.ram-64g.disk-1t")) {
		t.Error("other configs should not match")
	}
	sub.Configs = nil
	if !sub.Matches(slot("ks-1.ram-64g.disk-1t")) {
		t.Error("empty configs should match any config")
	}
}
