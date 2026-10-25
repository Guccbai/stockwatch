VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all web build test dev dev-web docker dist clean

all: web build

web:
	cd web && npm ci && npm run build

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/stockwatch ./cmd/stockwatch

test:
	go test ./...

# Backend on :8080 with the fake provider enabled; run `make dev-web` in another shell for the Vite dev server.
dev:
	SW_DATA=./data SW_ADMIN_PASSWORD=$${SW_ADMIN_PASSWORD:-stockwatch} SW_FAKE_PROVIDER=1 go run ./cmd/stockwatch

dev-web:
	cd web && npm run dev

docker:
	docker build --build-arg VERSION=$(VERSION) -t stockwatch:$(VERSION) .

# Release archives for every platform into dist/ (what the release workflow publishes).
dist: web
	scripts/dist.sh $(VERSION)

clean:
	rm -rf bin dist web/dist/assets web/dist/index.html web/dist/favicon.svg
