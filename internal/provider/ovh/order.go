package ovh

import (
	"fmt"
	"strings"

	"github.com/Guccbai/stockwatch/internal/provider"
)

// OrderURL links to OVH's express order review page with the cart pre-filled: the plan at one
// datacenter, the configuration's memory/storage options and the default bandwidth, pay monthly,
// no OS. The page builds the cart without logging in; the user still signs in and pays on OVH.
//
// The express app reads ?products= as a JSURL-encoded list of
// {planCode, productId, pricingMode, quantity, duration, configuration[], option[]}; OVH adds
// mandatory extras such as the private vRack bandwidth by itself.
func (p *Provider) OrderURL(prod provider.Product, config, location string) (string, bool) {
	r, err := lookupRegion(prod.Region)
	if err != nil || r.ExpressURL == "" || location == "" {
		return "", false
	}
	opts, ok := configOptions(prod, config)
	if !ok {
		return "", false
	}
	item := func(planCode string) jsObj {
		return jsObj{{"planCode", planCode}, {"duration", "P1M"}, {"pricingMode", "default"}, {"quantity", 1}}
	}
	options := make(jsArr, len(opts))
	for i, o := range opts {
		options[i] = item(o.Code)
	}
	plan := jsObj{
		{"planCode", prod.Code}, {"productId", "eco"}, {"pricingMode", "default"}, {"quantity", 1}, {"duration", "P1M"},
		{"configuration", jsArr{
			jsObj{{"label", "dedicated_datacenter"}, {"value", location}},
			jsObj{{"label", "dedicated_os"}, {"value", "none_64.en"}},
		}},
		{"option", options},
	}
	return r.ExpressURL + "#/express/review?products=" + jsurl(jsArr{plan}), true
}

// --- minimal JSURL encoder (https://github.com/Sage/jsurl) ---

type (
	jsKV struct {
		k string
		v any
	}
	jsObj []jsKV // ordered, so links are stable
	jsArr []any
)

func jsurl(v any) string {
	var b strings.Builder
	jsurlWrite(&b, v)
	return b.String()
}

func jsurlWrite(b *strings.Builder, v any) {
	switch x := v.(type) {
	case string:
		b.WriteString("~'")
		b.WriteString(jsurlString(x))
	case int:
		fmt.Fprintf(b, "~%d", x)
	case jsArr:
		b.WriteString("~(")
		if len(x) == 0 {
			b.WriteString("~")
		}
		for _, e := range x {
			jsurlWrite(b, e)
		}
		b.WriteString(")")
	case jsObj:
		b.WriteString("~(")
		for i, kv := range x {
			if i > 0 {
				b.WriteString("~")
			}
			b.WriteString(jsurlString(kv.k))
			jsurlWrite(b, kv.v)
		}
		b.WriteString(")")
	default:
		panic(fmt.Sprintf("jsurl: unsupported %T", v))
	}
}

// jsurlString keeps [A-Za-z0-9_.-] and escapes everything else the way JSURL does ($ → !, *XX, **XXXX).
func jsurlString(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '.', r == '-':
			b.WriteRune(r)
		case r == '$':
			b.WriteByte('!')
		case r < 0x100:
			fmt.Fprintf(&b, "*%02x", r)
		default:
			fmt.Fprintf(&b, "**%04x", r)
		}
	}
	return b.String()
}
