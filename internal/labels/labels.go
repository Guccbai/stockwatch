// Package labels turns vendor codes (OVH datacenters, hardware option ids) into readable Chinese text
// for notifications. It mirrors web/src/lib.ts; keep the two in sync.
package labels

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gucc/stockwatch/internal/provider"
)

type datacenter struct{ code, city, country, flag string }

// Order matters: it is the display order (Europe, North America, Asia-Pacific).
var datacenters = []datacenter{
	{"rbx", "鲁贝", "法国", "🇫🇷"},
	{"gra", "格拉沃利讷", "法国", "🇫🇷"},
	{"sbg", "斯特拉斯堡", "法国", "🇫🇷"},
	{"par", "巴黎", "法国", "🇫🇷"},
	{"fra", "法兰克福", "德国", "🇩🇪"},
	{"lim", "林堡", "德国", "🇩🇪"},
	{"lon", "伦敦", "英国", "🇬🇧"},
	{"eri", "伦敦", "英国", "🇬🇧"},
	{"waw", "华沙", "波兰", "🇵🇱"},
	{"mil", "米兰", "意大利", "🇮🇹"},
	{"bhs", "博阿努瓦", "加拿大", "🇨🇦"},
	{"tor", "多伦多", "加拿大", "🇨🇦"},
	{"vin", "弗吉尼亚", "美国东部", "🇺🇸"},
	{"hil", "俄勒冈", "美国西部", "🇺🇸"},
	{"sgp", "新加坡", "新加坡", "🇸🇬"},
	{"syd", "悉尼", "澳大利亚", "🇦🇺"},
	{"ynm", "孟买", "印度", "🇮🇳"},
	{"mum", "孟买", "印度", "🇮🇳"},
}

// Multi-AZ locations look like "eu-west-par-a": city code + availability zone letter.
var azRe = regexp.MustCompile(`^[a-z]{2}-[a-z]+-([a-z]{3})-([a-z])$`)

func lookup(code string) (dc datacenter, zone string, order int, ok bool) {
	key := code
	if m := azRe.FindStringSubmatch(code); m != nil {
		key, zone = m[1], m[2]
	}
	for i, d := range datacenters {
		if d.code == key {
			order = i * 10
			if zone != "" {
				order += int(zone[0]-'a') + 1
			}
			return d, zone, order, true
		}
	}
	return datacenter{}, "", 1 << 20, false
}

// Location renders a datacenter code as "🇫🇷 鲁贝 (RBX)"; unknown codes come back upper-cased.
func Location(code string) string {
	d, zone, _, ok := lookup(code)
	if !ok {
		return strings.ToUpper(code)
	}
	city := d.city
	if zone != "" {
		city += " " + strings.ToUpper(zone) + " 区"
	}
	return fmt.Sprintf("%s %s (%s)", d.flag, city, strings.ToUpper(code))
}

// SortLocations orders codes geographically (same order as the web UI's columns).
func SortLocations(codes []string) {
	sort.SliceStable(codes, func(i, j int) bool {
		_, _, oi, _ := lookup(codes[i])
		_, _, oj, _ := lookup(codes[j])
		if oi != oj {
			return oi < oj
		}
		return codes[i] < codes[j]
	})
}

// Locations formats a list of codes, sorted, joined with "、".
func Locations(codes []string) string {
	cs := append([]string(nil), codes...)
	SortLocations(cs)
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = Location(c)
	}
	return strings.Join(out, "、")
}

// Target renders "OVHcloud · 欧洲" using the provider registry, falling back to "ovh/eu".
func Target(providerID, region string) string {
	if name, ok := TargetName(providerID, region); ok {
		return name
	}
	return providerID + "/" + region
}

// TargetName is Target without the fallback; ok is false when the provider or region isn't registered.
func TargetName(providerID, region string) (string, bool) {
	if p, err := provider.Get(providerID); err == nil {
		for _, r := range p.Regions() {
			if r.ID == region {
				return p.Name() + " · " + r.Name, true
			}
		}
	}
	return "", false
}

// --- OVH hardware option codes ---

var (
	memRe   = regexp.MustCompile(`^ram-(\d+)g(.*)$`)
	ddrRe   = regexp.MustCompile(`-ddr(\d)`)
	speedRe = regexp.MustCompile(`-(?:no)?ecc-(\d{4})`)
	raidRe  = regexp.MustCompile(`^([a-z]+raid)-`)
	diskRe  = regexp.MustCompile(`(\d+)x(\d+)(nvme|ssd|sas|sa|hdd)(?:[^a-z]|$)`)
	noDisk  = regexp.MustCompile(`0disk|noraid-0(?:-|$)`)
	bwRe    = regexp.MustCompile(`^bandwidth-(\d+)(?:-upto-(\d+))?`)
	trafRe  = regexp.MustCompile(`^traffic-(\d+)tb-(\d+)`)
)

var diskKind = map[string]string{"nvme": "NVMe", "ssd": "SSD", "sa": "HDD", "sas": "SAS", "hdd": "HDD"}
var raidKind = map[string]string{"softraid": "软 RAID", "hybridsoftraid": "混合软 RAID", "hardraid": "硬 RAID"}

func size(gb int) string {
	if gb < 1000 {
		return fmt.Sprintf("%dGB", gb)
	}
	return strconv.FormatFloat(float64(gb)/1000, 'f', -1, 64) + "TB"
}

// Memory: "ram-64g-ddr5-on-die-ecc-3600-25rises01-v2" → "64GB DDR5 ECC 3600MHz".
func Memory(code string) string {
	m := memRe.FindStringSubmatch(code)
	if m == nil {
		return code
	}
	rest := m[2]
	parts := []string{m[1] + "GB"}
	if d := ddrRe.FindStringSubmatch(rest); d != nil {
		parts = append(parts, "DDR"+d[1])
	}
	if strings.Contains(rest, "-noecc") {
		parts = append(parts, "非 ECC")
	} else if strings.Contains(rest, "-ecc") {
		parts = append(parts, "ECC")
	}
	if s := speedRe.FindStringSubmatch(rest); s != nil {
		parts = append(parts, s[1]+"MHz")
	}
	return strings.Join(parts, " ")
}

// Storage: "hybridsoftraid-2x960nvme-pcie-gen4-2x3840nvme-pcie-gen4" → "2×960GB NVMe + 2×3.84TB NVMe · 混合软 RAID".
func Storage(code string) string {
	groups := diskRe.FindAllStringSubmatch(code, -1)
	if len(groups) == 0 {
		if noDisk.MatchString(code) {
			return "无硬盘 (需另购)"
		}
		return code
	}
	parts := make([]string, len(groups))
	count := 0
	for i, g := range groups {
		n, _ := strconv.Atoi(g[1])
		gb, _ := strconv.Atoi(g[2])
		count += n
		parts[i] = fmt.Sprintf("%d×%s %s", n, size(gb), diskKind[g[3]])
	}
	text := strings.Join(parts, " + ")
	if r := raidRe.FindStringSubmatch(code); r != nil && raidKind[r[1]] != "" && count > 1 {
		text += " · " + raidKind[r[1]]
	}
	return text
}

// Bandwidth: "bandwidth-1000-upto-2000-24sys3p" → "1Gbps (最高 2Gbps)"; "traffic-10tb-300-apac" → "300Mbps · 10TB 流量".
func Bandwidth(code string) string {
	speed := func(s string) string {
		mbps, _ := strconv.Atoi(s)
		if mbps >= 1000 {
			return strconv.FormatFloat(float64(mbps)/1000, 'f', -1, 64) + "Gbps"
		}
		return s + "Mbps"
	}
	if m := bwRe.FindStringSubmatch(code); m != nil {
		s := speed(m[1])
		if m[2] != "" {
			s += " (最高 " + speed(m[2]) + ")"
		}
		if strings.Contains(code, "unguaranteed") {
			s += " 共享"
		}
		return s
	}
	if m := trafRe.FindStringSubmatch(code); m != nil {
		return speed(m[2]) + " · " + m[1] + "TB 流量"
	}
	return code
}

// Config renders an OVH fqn ("plan.ram-….softraid-…") as "内存 128GB ECC 2400MHz · 硬盘 2×1TB NVMe · 软 RAID".
// Configs without recognizable options are returned with the plan code stripped.
func Config(config, productCode string) string {
	c := strings.TrimPrefix(config, productCode+".")
	var mem, sto string
	for p := range strings.SplitSeq(c, ".") {
		switch {
		case strings.HasPrefix(p, "ram-"):
			mem = Memory(p)
		case strings.Contains(p, "raid") || strings.Contains(p, "disk"):
			sto = Storage(p)
		}
	}
	if mem == "" && sto == "" {
		return strings.ReplaceAll(c, ".", " / ")
	}
	var parts []string
	if mem != "" {
		parts = append(parts, "内存 "+mem)
	}
	if sto != "" {
		parts = append(parts, "硬盘 "+sto)
	}
	return strings.Join(parts, " · ")
}
