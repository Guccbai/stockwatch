VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all web build test dev dev-web docker clean

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
	docker build -t stockwatch:$(VERSION) .

clean:
	rm -rf bin web/dist/assets web/dist/index.html web/dist/favicon.svg
