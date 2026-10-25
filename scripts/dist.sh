#!/bin/sh
# Cross-compiles release archives into dist/ (used by the release workflow; also runs locally).
# Expects the WebUI to be built already (make web). Usage: scripts/dist.sh v1.2.3
set -eu

version="${1:?usage: scripts/dist.sh <version>}"
cd "$(dirname "$0")/.."

if [ ! -f web/dist/index.html ]; then
	echo "web/dist/index.html missing: run 'make web' first" >&2
	exit 1
fi

# Pure-Go SQLite (modernc.org/sqlite) supports all of these with CGO off.
targets="linux/amd64 linux/arm64 linux/arm/7 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64 freebsd/amd64"

rm -rf dist
mkdir -p dist
for t in $targets; do
	os=$(echo "$t" | cut -d/ -f1)
	arch=$(echo "$t" | cut -d/ -f2)
	arm=$(echo "$t" | cut -d/ -f3)
	name="stockwatch_${version#v}_${os}_${arch}${arm:+v$arm}"
	ext=""
	[ "$os" = windows ] && ext=".exe"

	echo "building $name"
	mkdir -p "dist/$name"
	CGO_ENABLED=0 GOOS=$os GOARCH=$arch GOARM=$arm \
		go build -trimpath -ldflags "-s -w -X main.version=$version" -o "dist/$name/stockwatch$ext" ./cmd/stockwatch
	cp LICENSE README.md "dist/$name/"

	if [ "$os" = windows ]; then
		(cd dist && zip -qr "$name.zip" "$name")
	else
		tar -C dist -czf "dist/$name.tar.gz" "$name"
	fi
	rm -rf "dist/$name"
done

cd dist
if command -v sha256sum >/dev/null; then
	sha256sum -- * >checksums.txt
else
	shasum -a 256 -- * >checksums.txt
fi
cat checksums.txt
