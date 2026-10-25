// Package telegram sends alerts through the Telegram Bot API and answers a few bot commands.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/Guccbai/stockwatch/internal/labels"
	"github.com/Guccbai/stockwatch/internal/notify"
	"github.com/Guccbai/stockwatch/internal/provider"
	"github.com/Guccbai/stockwatch/internal/settings"
)

const maxLines = 25

// Commands is what the bot needs from the rest of the app to answer commands.
type Commands interface {
	StatusText(ctx context.Context) string
	SubscriptionsText(ctx context.Context) string
	SetPaused(ctx context.Context, paused bool) error
}

type Telegram struct {
	settings *settings.Settings
	client   *http.Client
	apiBase  string
	log      *slog.Logger
}

func New(s *settings.Settings, apiBase string, log *slog.Logger) *Telegram {
	return &Telegram{settings: s, client: &http.Client{Timeout: 60 * time.Second}, apiBase: strings.TrimRight(apiBase, "/"), log: log}
}

func (t *Telegram) Name() string { return "telegram" }

func (t *Telegram) creds(ctx context.Context) (token string, chats []string) {
	v, err := t.settings.Get(ctx)
	if err != nil {
		return "", nil
	}
	for _, c := range strings.Split(v.TelegramChatID, ",") {
		if c = strings.TrimSpace(c); c != "" {
			chats = append(chats, c)
		}
	}
	return v.TelegramToken, chats
}

func (t *Telegram) Configured(ctx context.Context) bool {
	token, chats := t.creds(ctx)
	return token != "" && len(chats) > 0
}

func (t *Telegram) Notify(ctx context.Context, a notify.Alert) error {
	return t.broadcast(ctx, FormatAlert(a))
}

func (t *Telegram) SendTest(ctx context.Context) error {
	return t.broadcast(ctx, "✅ <b>StockWatch</b> 测试消息：Telegram 通知配置成功。")
}

func (t *Telegram) broadcast(ctx context.Context, text string) error {
	token, chats := t.creds(ctx)
	if token == "" || len(chats) == 0 {
		return errors.New("telegram 未配置 token 或 chat_id")
	}
	var errs []error
	for _, chat := range chats {
		if err := t.send(ctx, token, chat, text); err != nil {
			errs = append(errs, fmt.Errorf("chat %s: %w", chat, err))
		}
	}
	return errors.Join(errs...)
}

type apiResponse struct {
	OK          bool            `json:"ok"`
	Description string          `json:"description"`
	Result      json.RawMessage `json:"result"`
	Parameters  *struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

func (t *Telegram) call(ctx context.Context, token, method string, payload any, result any) error {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.apiBase+"/bot"+token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := t.client.Do(req)
	if err != nil {
		// The URL contains the token; strip it from the error.
		var ue interface{ Unwrap() error }
		if errors.As(err, &ue) {
			return fmt.Errorf("%s: %w", method, ue.Unwrap())
		}
		return fmt.Errorf("%s: request failed", method)
	}
	defer resp.Body.Close()
	var r apiResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return fmt.Errorf("%s: %s", method, resp.Status)
	}
	if !r.OK {
		if r.Parameters != nil && r.Parameters.RetryAfter > 0 {
			return &RetryAfterError{Seconds: r.Parameters.RetryAfter, Desc: r.Description}
		}
		return fmt.Errorf("%s: %s", method, r.Description)
	}
	if result != nil {
		return json.Unmarshal(r.Result, result)
	}
	return nil
}

type RetryAfterError struct {
	Seconds int
	Desc    string
}

func (e *RetryAfterError) Error() string {
	return fmt.Sprintf("rate limited (retry after %ds): %s", e.Seconds, e.Desc)
}

func (t *Telegram) send(ctx context.Context, token, chat, text string) error {
	payload := map[string]any{
		"chat_id":                  chat,
		"text":                     text,
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	}
	for attempt := 0; ; attempt++ {
		err := t.call(ctx, token, "sendMessage", payload, nil)
		var ra *RetryAfterError
		if errors.As(err, &ra) && attempt < 2 {
			select {
			case <-time.After(time.Duration(ra.Seconds) * time.Second):
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return err
	}
}

// FormatAlert renders an alert as Telegram HTML.
func FormatAlert(a notify.Alert) string {
	var pricer provider.ConfigPricer
	var linker provider.OrderLinker
	if p, err := provider.Get(a.Subscription.Provider); err == nil {
		pricer, _ = p.(provider.ConfigPricer)
		linker, _ = p.(provider.OrderLinker)
	}
	orderURL := "" // pre-filled order for the first restocked slot, else the product page
	if a.Product != nil {
		orderURL = a.Product.OrderURL
	}
	linked := false
	var restock, soldout []string
	for _, e := range a.Events {
		line := fmt.Sprintf("• <b>%s</b> %s", html.EscapeString(labels.Location(e.Location)), html.EscapeString(labels.Config(e.Config, e.ProductCode)))
		if e.To.InStock() {
			line += " · " + html.EscapeString(deliveryLabel(e.RawState))
			if pricer != nil && a.Product != nil {
				if cp, ok := pricer.ConfigPrice(*a.Product, e.Config); ok {
					line += fmt.Sprintf(" · <b>%.2f %s/月</b>", cp.Price, html.EscapeString(a.Product.Currency))
				}
			}
			if !linked && linker != nil && a.Product != nil {
				if u, ok := linker.OrderURL(*a.Product, e.Config, e.Location); ok {
					orderURL, linked = u, true
				}
			}
			restock = append(restock, line)
		} else {
			soldout = append(soldout, line)
		}
	}

	name := a.Subscription.ProductCode
	if a.Product != nil && a.Product.Name != "" {
		name = a.Product.Name
	}
	var b strings.Builder
	if len(restock) > 0 {
		b.WriteString("🟢 <b>补货</b> ")
	} else {
		b.WriteString("🔴 <b>售罄</b> ")
	}
	fmt.Fprintf(&b, "<b>%s</b> <code>%s</code> · %s\n",
		html.EscapeString(name), html.EscapeString(a.Subscription.ProductCode), html.EscapeString(regionLabel(a)))
	if p := a.Product; p != nil {
		var parts []string
		if cpu := p.Specs["cpu"]; cpu != "" {
			parts = append(parts, "CPU "+cpu)
		}
		if mem := p.Specs["memory"]; mem != "" {
			parts = append(parts, "内存 "+labels.Memory(mem))
		}
		if sto := p.Specs["storage"]; sto != "" {
			parts = append(parts, "硬盘 "+labels.Storage(sto))
		}
		if p.Price > 0 {
			parts = append(parts, fmt.Sprintf("%.2f %s/月起", p.Price, p.Currency))
		}
		if p.SetupFee > 0 {
			parts = append(parts, fmt.Sprintf("安装费 %.2f %s", p.SetupFee, p.Currency))
		}
		if len(parts) > 0 {
			b.WriteString(html.EscapeString(strings.Join(parts, " · ")) + "\n")
		}
	}
	writeLines := func(title string, lines []string) {
		if len(lines) == 0 {
			return
		}
		b.WriteString("\n" + title + "\n")
		for i, l := range lines {
			if i == maxLines {
				fmt.Fprintf(&b, "… 另有 %d 项\n", len(lines)-maxLines)
				break
			}
			b.WriteString(l + "\n")
		}
	}
	writeLines("<b>有货：</b>", restock)
	writeLines("<b>已售罄：</b>", soldout)
	if a.Subscription.Note != "" {
		b.WriteString("\n📝 " + html.EscapeString(a.Subscription.Note) + "\n")
	}
	if orderURL != "" && len(restock) > 0 {
		label := "前往下单 →"
		if linked {
			label = "前往下单（已预选第一个有货配置）→"
		}
		fmt.Fprintf(&b, "\n<a href=\"%s\">%s</a>", html.EscapeString(orderURL), label)
	}
	return b.String()
}

// regionLabel prefers the registry's "OVHcloud · 欧洲", falling back to the provider name the alert carries.
func regionLabel(a notify.Alert) string {
	if name, ok := labels.TargetName(a.Subscription.Provider, a.Subscription.Region); ok {
		return name
	}
	return strings.TrimSpace(a.ProviderName + " " + strings.ToUpper(a.Subscription.Region))
}

func deliveryLabel(raw string) string {
	switch raw {
	case "1H-high":
		return "1 小时内交付"
	case "1H-low":
		return "1 小时内交付（库存紧张）"
	}
	if strings.HasSuffix(raw, "H") {
		return strings.TrimSuffix(raw, "H") + " 小时内交付"
	}
	return raw
}

// RunBot long-polls getUpdates and answers commands from the configured chats.
// It keeps running until ctx is cancelled, re-reading settings so changes apply without restart.
func (t *Telegram) RunBot(ctx context.Context, cmds Commands) {
	var offset int64
	var lastToken string
	for ctx.Err() == nil {
		v, err := t.settings.Get(ctx)
		token, chats := t.creds(ctx)
		if err != nil || !v.TelegramCommands || token == "" || len(chats) == 0 {
			sleep(ctx, 15*time.Second)
			continue
		}
		if token != lastToken {
			offset, lastToken = 0, token
		}
		var updates []struct {
			UpdateID int64 `json:"update_id"`
			Message  *struct {
				Text string `json:"text"`
				Chat struct {
					ID int64 `json:"id"`
				} `json:"chat"`
			} `json:"message"`
		}
		err = t.call(ctx, token, "getUpdates", map[string]any{"offset": offset, "timeout": 30, "allowed_updates": []string{"message"}}, &updates)
		if err != nil {
			if ctx.Err() == nil {
				t.log.Warn("telegram getUpdates failed", "err", err)
				sleep(ctx, 30*time.Second)
			}
			continue
		}
		for _, u := range updates {
			offset = u.UpdateID + 1
			if u.Message == nil {
				continue
			}
			chat := fmt.Sprint(u.Message.Chat.ID)
			if !slices.Contains(chats, chat) {
				continue
			}
			if reply := t.handleCommand(ctx, cmds, u.Message.Text); reply != "" {
				if err := t.send(ctx, token, chat, reply); err != nil {
					t.log.Warn("telegram reply failed", "err", err)
				}
			}
		}
	}
}

func (t *Telegram) handleCommand(ctx context.Context, cmds Commands, text string) string {
	cmd, _, _ := strings.Cut(strings.TrimSpace(text), " ")
	cmd, _, _ = strings.Cut(cmd, "@") // "/status@MyBot" in groups
	switch cmd {
	case "/start", "/help":
		return "<b>StockWatch</b> 命令：\n/status 当前有货的订阅\n/subs 订阅列表\n/pause 暂停通知\n/resume 恢复通知"
	case "/status":
		return cmds.StatusText(ctx)
	case "/subs":
		return cmds.SubscriptionsText(ctx)
	case "/pause", "/resume":
		paused := cmd == "/pause"
		if err := cmds.SetPaused(ctx, paused); err != nil {
			return "操作失败：" + html.EscapeString(err.Error())
		}
		if paused {
			return "⏸ 已暂停通知（监控仍在运行）"
		}
		return "▶️ 已恢复通知"
	}
	return ""
}

// StatusEmoji is shared by text renderers.
func StatusEmoji(s provider.StockStatus) string {
	switch s {
	case provider.StatusAvailable:
		return "🟢"
	case provider.StatusLow:
		return "🟡"
	case provider.StatusUnavailable:
		return "🔴"
	}
	return "⚪"
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-time.After(d):
	case <-ctx.Done():
	}
}
