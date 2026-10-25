package ovh

import (
	"math"
	"regexp"
	"strings"

	"github.com/Guccbai/stockwatch/internal/provider"
)

// ConfigPrice prices an availability fqn ("24adv01-v3.ram-128g-on-die-ecc-3600.softraid-2x960nvme-pcie-gen4")
// as base plan + matching memory and storage options + the default bandwidth option.
//
// Availability codes are catalog option codes without the plan suffix ("ram-32g-ecc-2133" vs
// "ram-32g-ecc-2133-24sk10"), so options are matched by prefix, falling back to an unambiguous
// match on memory size or disk layout when the two feeds disagree on details (≈1% of slots).
func (p *Provider) ConfigPrice(prod provider.Product, config string) (provider.ConfigPrice, bool) {
	if prod.Price <= 0 {
		return provider.ConfigPrice{}, false
	}
	opts, ok := configOptions(prod, config)
	if !ok {
		return provider.ConfigPrice{}, false
	}
	out := provider.ConfigPrice{Price: prod.Price, SetupFee: prod.SetupFee}
	for _, o := range opts {
		out.Price += o.Price
		out.SetupFee += o.SetupFee
	}
	out.Price, out.SetupFee = cents(out.Price), cents(out.SetupFee)
	return out, true
}

// configOptions resolves the catalog options an fqn is made of, plus the default bandwidth.
func configOptions(prod provider.Product, config string) ([]provider.Option, bool) {
	if len(prod.Options) == 0 {
		return nil, false
	}
	var out []provider.Option
	var matched int
	seenStorage := false
	for part := range strings.SplitSeq(strings.TrimPrefix(config, prod.Code+"."), ".") {
		family := ""
		switch {
		case strings.HasPrefix(part, "ram-"):
			family = "memory"
		case strings.HasSuffix(part, "-system") || seenStorage && strings.Contains(part, "raid"):
			// STOR servers have separate OS disks: suffixed "-system" on Advance, the second disk group on Rise.
			family = "system-storage"
		case strings.Contains(part, "raid") || strings.Contains(part, "disk"):
			family = "storage"
			seenStorage = true
		default:
			continue
		}
		o, ok := matchOption(prod.Options, family, part)
		if !ok {
			return nil, false
		}
		out = append(out, o)
		matched++
	}
	if matched == 0 {
		return nil, false
	}
	// Bandwidth isn't part of the fqn; the default option is what an order gets unless upgraded.
	if bw := prod.Specs["bandwidth"]; bw != "" {
		for _, o := range prod.Options {
			if o.Family == "bandwidth" && o.Code == bw {
				out = append(out, o)
			}
		}
	}
	return out, true
}

// cents drops float noise from summing prices (36.989999… → 36.99).
func cents(v float64) float64 { return math.Round(v*100) / 100 }

var (
	ramSize   = regexp.MustCompile(`^ram-(\d+g)-`)
	diskGroup = regexp.MustCompile(`(\d+)x(\d+)(nvme|ssd|sas|sa|hdd)(?:[^a-z]|$)`)
)

// diskLayout normalizes a storage code to its disks ("2x960nvme+2x1920nvme"), ignoring RAID mode and
// suffixes; diskless codes ("noraid-0", "softraid-0disk-…") all map to "none".
func diskLayout(code string) string {
	groups := diskGroup.FindAllStringSubmatch(code, -1)
	if len(groups) == 0 {
		return "none"
	}
	parts := make([]string, len(groups))
	for i, g := range groups {
		parts[i] = g[1] + "x" + g[2] + g[3]
	}
	return strings.Join(parts, "+")
}

func matchOption(opts []provider.Option, family, code string) (provider.Option, bool) {
	var prefix, fuzzy []provider.Option
	var key string
	switch family {
	case "memory":
		if m := ramSize.FindStringSubmatch(code); m != nil {
			key = m[1]
		}
	case "storage", "system-storage":
		key = diskLayout(code)
	}
	for _, o := range opts {
		if o.Family != family {
			continue
		}
		if o.Code == code {
			return o, true
		}
		if strings.HasPrefix(o.Code, code+"-") {
			prefix = append(prefix, o)
		}
		if key != "" {
			if family == "memory" && strings.HasPrefix(o.Code, "ram-"+key+"-") || family != "memory" && diskLayout(o.Code) == key {
				fuzzy = append(fuzzy, o)
			}
		}
	}
	if len(prefix) > 0 {
		// Several options can share a prefix ("…-24sk10" and "…-24sk10-v2"); the shortest is the plain one.
		best := prefix[0]
		for _, o := range prefix[1:] {
			if len(o.Code) < len(best.Code) {
				best = o
			}
		}
		return best, true
	}
	if len(fuzzy) == 1 {
		return fuzzy[0], true
	}
	return provider.Option{}, false
}
