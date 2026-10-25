package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Guccbai/stockwatch/internal/api"
	"github.com/Guccbai/stockwatch/internal/auth"
	"github.com/Guccbai/stockwatch/internal/config"
	"github.com/Guccbai/stockwatch/internal/monitor"
	"github.com/Guccbai/stockwatch/internal/notify"
	"github.com/Guccbai/stockwatch/internal/notify/telegram"
	"github.com/Guccbai/stockwatch/internal/provider"
	"github.com/Guccbai/stockwatch/internal/provider/fake"
	"github.com/Guccbai/stockwatch/internal/provider/ovh"
	"github.com/Guccbai/stockwatch/internal/settings"
	"github.com/Guccbai/stockwatch/internal/store"
	"github.com/Guccbai/stockwatch/web"
)

var version = "dev"

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	provider.Register(ovh.New(cfg.HTTPTimeout))
	if cfg.FakeProvider {
		provider.Register(fake.New())
	}

	st, err := store.Open(cfg.DBPath())
	if err != nil {
		return err
	}
	defer st.Close()

	set := settings.New(st, settings.Overrides{TelegramToken: cfg.TelegramToken, TelegramChatID: cfg.TelegramChatID})
	au := auth.New(st, set)
	generated, err := au.EnsurePassword(ctx, cfg.AdminPassword)
	if err != nil {
		return err
	}
	if generated != "" {
		log.Warn("no SW_ADMIN_PASSWORD set; generated an admin password (change it in Settings)", "password", generated)
	}

	tg := telegram.New(set, cfg.TelegramAPI, log)
	notifiers := []notify.Notifier{tg}
	hub := monitor.NewHub()
	mon := monitor.New(st, set, notifiers, hub, log)
	if err := mon.Load(ctx); err != nil {
		return err
	}
	go mon.Run(ctx)
	go tg.RunBot(ctx, mon)

	srv := &api.Server{Store: st, Settings: set, Auth: au, Monitor: mon, Hub: hub, Notifiers: notifiers, Web: web.FS(), Log: log, Version: version}
	if srv.Web == nil {
		log.Warn("WebUI not embedded; run `make web` before building to include it")
	}
	httpSrv := &http.Server{Addr: cfg.Listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(sctx)
	}()
	log.Info("stockwatch listening", "addr", cfg.Listen, "data", cfg.DataDir, "version", version)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
