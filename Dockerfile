FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=docker
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/stockwatch ./cmd/stockwatch

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/stockwatch /stockwatch
ENV SW_LISTEN=:8080 SW_DATA=/data
VOLUME /data
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/stockwatch"]
