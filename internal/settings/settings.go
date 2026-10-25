// Package settings exposes typed, runtime-editable settings backed by the store,
// with optional environment overrides.
package settings

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/Guccbai/stockwatch/internal/store"
)

const (
	KeyTelegramToken    = "telegram.token"
	KeyTelegramChatID   = "telegram.chat_id"
	KeyTelegramCommands = "telegram.commands"
	KeyInterval         = "monitor.interval"
	KeyCooldown         = "monitor.cooldown"
	KeyTargets          = "monitor.targets"
	KeyPaused           = "monitor.paused"
	KeyRetentionDays    = "monitor.retention_days"
	KeyPasswordHash     = "auth.password_hash"
)

const (
	MinInterval     = 15 * time.Second
	DefaultInterval = 60 * time.Second
	DefaultCooldown = 10 * time.Minute
)

// Target is one provider region that is polled.
type Target struct {
	Provider string `json:"provider"`
	Region   string `json:"region"`
}

func (t Target) String() string { return t.Provider + ":" + t.Region }

type Values struct {
	TelegramToken    string        `json:"-"`
	TelegramChatID   string        `json:"telegramChatId"`
	TelegramCommands bool          `json:"telegramCommands"`
	Interval         time.Duration `json:"-"`
	Cooldown         time.Duration `json:"-"`
	Targets          []Target      `json:"targets"`
	Paused           bool          `json:"paused"`
	RetentionDays    int           `json:"retentionDays"`
}

type Overrides struct {
	TelegramToken  string
	TelegramChatID string
}

type Settings struct {
	store     *store.Store
	overrides Overrides
}

func New(s *store.Store, o Overrides) *Settings { return &Settings{store: s, overrides: o} }

func (s *Settings) Overrides() Overrides { return s.overrides }

func (s *Settings) Get(ctx context.Context) (Values, error) {
	m, err := s.store.AllSettings(ctx)
	if err != nil {
		return Values{}, err
	}
	v := Values{
		TelegramToken:    m[KeyTelegramToken],
		TelegramChatID:   m[KeyTelegramChatID],
		TelegramCommands: m[KeyTelegramCommands] != "false",
		Interval:         seconds(m[KeyInterval], DefaultInterval),
		Cooldown:         seconds(m[KeyCooldown], DefaultCooldown),
		Targets:          ParseTargets(m[KeyTargets]),
		Paused:           m[KeyPaused] == "true",
		RetentionDays:    30,
	}
	if n, err := strconv.Atoi(m[KeyRetentionDays]); err == nil && n > 0 {
		v.RetentionDays = n
	}
	if _, ok := m[KeyTargets]; !ok {
		v.Targets = []Target{{Provider: "ovh", Region: "eu"}}
	}
	if v.Interval < MinInterval {
		v.Interval = MinInterval
	}
	if s.overrides.TelegramToken != "" {
		v.TelegramToken = s.overrides.TelegramToken
	}
	if s.overrides.TelegramChatID != "" {
		v.TelegramChatID = s.overrides.TelegramChatID
	}
	return v, nil
}

func (s *Settings) Set(ctx context.Context, kv map[string]string) error {
	return s.store.SetSettings(ctx, kv)
}

func (s *Settings) PasswordHash(ctx context.Context) (string, error) {
	h, err := s.store.GetSetting(ctx, KeyPasswordHash)
	if err == store.ErrNotFound {
		return "", nil
	}
	return h, err
}

func ParseTargets(s string) []Target {
	out := []Target{}
	for _, part := range strings.Split(s, ",") {
		p, r, ok := strings.Cut(strings.TrimSpace(part), ":")
		if ok && p != "" && r != "" {
			out = append(out, Target{Provider: p, Region: r})
		}
	}
	return out
}

func FormatTargets(ts []Target) string {
	parts := make([]string, len(ts))
	for i, t := range ts {
		parts[i] = t.String()
	}
	return strings.Join(parts, ",")
}

func seconds(s string, def time.Duration) time.Duration {
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return time.Duration(n) * time.Second
}
