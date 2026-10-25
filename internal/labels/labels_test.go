package labels

import (
	"reflect"
	"testing"
)

func TestHardware(t *testing.T) {
	cases := []struct {
		fn       func(string) string
		in, want string
	}{
		{Memory, "ram-64g-ddr5-on-die-ecc-3600-25rises01-v2", "64GB DDR5 ECC 3600MHz"},
		{Memory, "ram-32g-noecc-2133-24skgame01", "32GB 非 ECC 2133MHz"},
		{Memory, "ram-16g-ecc-2133-24sk40-v1-us", "16GB ECC 2133MHz"},
		{Storage, "hybridsoftraid-2x960nvme-pcie-gen4-2x3840nvme-pcie-gen4", "2×960GB NVMe + 2×3.84TB NVMe · 混合软 RAID"},
		{Storage, "noraid-1x120ssd-25skb01", "1×120GB SSD"},
		{Storage, "softraid-2x22000sas-24advstor01-v3", "2×22TB SAS · 软 RAID"},
		{Storage, "hybridsoftraid-4x4000sa-1x500nvme-24skstor01-v1", "4×4TB HDD + 1×500GB NVMe · 混合软 RAID"},
		{Storage, "softraid-0disk-24rise", "无硬盘 (需另购)"},
		{Storage, "noraid-0-24rise07-v1", "无硬盘 (需另购)"},
		{Storage, "softraid-2x1920nvme-25risexl01-v1", "2×1.92TB NVMe · 软 RAID"},
		{Storage, "softraid-2x2000sa-24sk10-us", "2×2TB HDD · 软 RAID"},
		{Bandwidth, "bandwidth-1000-upto-2000-24sys3p-eu", "1Gbps (最高 2Gbps)"},
		{Bandwidth, "traffic-10tb-300-apac-ca", "300Mbps · 10TB 流量"},
		{Bandwidth, "bandwidth-1000-unguaranteed-rise-gen2", "1Gbps 共享"},
		{Location, "rbx", "🇫🇷 鲁贝 (RBX)"},
		{Location, "eu-west-par-b", "🇫🇷 巴黎 B 区 (EU-WEST-PAR-B)"},
		{Location, "xyz", "XYZ"},
	}
	for _, c := range cases {
		if got := c.fn(c.in); got != c.want {
			t.Errorf("%q → %q, want %q", c.in, got, c.want)
		}
	}
}

func TestConfig(t *testing.T) {
	if got, want := Config("24sk602.ram-128g-ecc-2400.softraid-2x1000nvme", "24sk602"), "内存 128GB ECC 2400MHz · 硬盘 2×1TB NVMe · 软 RAID"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got, want := Config("fake-small.cfg-a.cfg-b", "fake-small"), "cfg-a / cfg-b"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestSortLocations(t *testing.T) {
	got := []string{"sgp", "bhs", "eu-west-par-b", "rbx", "zzz", "eu-west-par-a"}
	SortLocations(got)
	want := []string{"rbx", "eu-west-par-a", "eu-west-par-b", "bhs", "sgp", "zzz"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
