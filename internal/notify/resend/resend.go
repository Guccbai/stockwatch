// Package resend sends alerts as email through the Resend API.
package resend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Guccbai/stockwatch/internal/labels"
	"github.com/Guccbai/stockwatch/internal/notify"
	"github.com/Guccbai/stockwatch/internal/notify/telegram"
	"github.com/Guccbai/stockwatch/internal/settings"
)

type Resend struct {
	settings *settings.Settings
	client   *http.Client
	apiBase  string
}

func New(s *settings.Settings, apiBase string) *Resend {
	return &Resend{settings: s, client: &http.Client{Timeout: 30 * time.Second}, apiBase: strings.TrimRight(apiBase, "/")}
}

func (r *Resend) Name() string { return "resend" }

func (r *Resend) creds(ctx context.Context) (key, from string, to []string) {
	v, err := r.settings.Get(ctx)
	if err != nil {
		return "", "", nil
	}
	for addr := range strings.SplitSeq(v.ResendTo, ",") {
		if addr = strings.TrimSpace(addr); addr != "" {
			to = append(to, addr)
		}
	}
	return v.ResendAPIKey, strings.TrimSpace(v.ResendFrom), to
}

func (r *Resend) Configured(ctx context.Context) bool {
	key, from, to := r.creds(ctx)
	return key != "" && from != "" && len(to) > 0
}

func (r *Resend) Notify(ctx context.Context, a notify.Alert) error {
	body := telegram.FormatAlert(a)
	return r.send(ctx, Subject(a), htmlBody(body), plainText(body))
}

func (r *Resend) SendTest(ctx context.Context) error {
	msg := "✅ <b>StockWatch</b> 测试邮件：Resend 邮件通知配置成功。"
	return r.send(ctx, "StockWatch 测试邮件", htmlBody(msg), plainText(msg))
}

// Subject is a one-line summary, e.g. "🟢 补货 KS-6 (24sk602) · OVHcloud · 欧洲".
func Subject(a notify.Alert) string {
	status := "🔴 售罄"
	for _, e := range a.Events {
		if e.To.InStock() {
			status = "🟢 补货"
			break
		}
	}
	name := a.Subscription.ProductCode
	if a.Product != nil && a.Product.Name != "" && a.Product.Name != name {
		name = fmt.Sprintf("%s (%s)", a.Product.Name, a.Subscription.ProductCode)
	}
	region, ok := labels.TargetName(a.Subscription.Provider, a.Subscription.Region)
	if !ok {
		region = strings.TrimSpace(a.ProviderName + " " + strings.ToUpper(a.Subscription.Region))
	}
	return fmt.Sprintf("%s %s · %s", status, name, region)
}

// htmlBody wraps the Telegram-flavoured HTML (b, code, a and newlines) into an email document.
func htmlBody(msg string) string {
	return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#111">` +
		strings.ReplaceAll(msg, "\n", "<br>\n") + `</div>`
}

var tagRe = regexp.MustCompile(`<[^>]*>`)
var hrefRe = regexp.MustCompile(`<a href="([^"]*)">([^<]*)</a>`)

func plainText(msg string) string {
	msg = hrefRe.ReplaceAllString(msg, "$2 $1")
	return html.UnescapeString(tagRe.ReplaceAllString(msg, ""))
}

type apiError struct {
	Message string `json:"message"`
	Name    string `json:"name"`
}

func (r *Resend) send(ctx context.Context, subject, htmlBody, text string) error {
	key, from, to := r.creds(ctx)
	if key == "" || from == "" || len(to) == 0 {
		return errors.New("resend 未配置 API Key、发件人或收件人")
	}
	payload, _ := json.Marshal(map[string]any{"from": from, "to": to, "subject": subject, "html": htmlBody, "text": text})
	for attempt := 0; ; attempt++ {
		retry, err := r.post(ctx, key, payload)
		if retry > 0 && attempt < 2 {
			select {
			case <-time.After(retry):
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return err
	}
}

// post returns a positive retry delay when rate limited.
func (r *Resend) post(ctx context.Context, key string, payload []byte) (time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.apiBase+"/emails", bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("resend: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 == 2 {
		return 0, nil
	}
	var e apiError
	_ = json.NewDecoder(resp.Body).Decode(&e)
	msg := e.Message
	if msg == "" {
		msg = resp.Status
	}
	err = fmt.Errorf("resend: %s", msg)
	if resp.StatusCode == http.StatusTooManyRequests {
		secs, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		return time.Duration(max(secs, 1)) * time.Second, err
	}
	return 0, err
}
