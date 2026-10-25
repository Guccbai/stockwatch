// Package auth implements single-admin password login with cookie sessions.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/Guccbai/stockwatch/internal/settings"
	"github.com/Guccbai/stockwatch/internal/store"
)

const (
	CookieName = "sw_session"
	sessionTTL = 30 * 24 * time.Hour
	minPassLen = 8
)

var (
	ErrBadPassword = errors.New("密码错误")
	ErrRateLimited = errors.New("尝试次数过多，请稍后再试")
	ErrWeak        = errors.New("密码至少 8 位")
)

type Auth struct {
	store    *store.Store
	settings *settings.Settings

	mu       sync.Mutex
	failures map[string][]time.Time
}

func New(st *store.Store, s *settings.Settings) *Auth {
	return &Auth{store: st, settings: s, failures: map[string][]time.Time{}}
}

// EnsurePassword sets the admin password on first start. It returns the generated password
// when none was supplied, so the caller can print it once.
func (a *Auth) EnsurePassword(ctx context.Context, initial string) (generated string, err error) {
	h, err := a.settings.PasswordHash(ctx)
	if err != nil || h != "" {
		return "", err
	}
	if initial == "" {
		initial = RandomToken(12)
		generated = initial
	}
	return generated, a.SetPassword(ctx, initial)
}

func (a *Auth) SetPassword(ctx context.Context, pw string) error {
	if len(pw) < minPassLen {
		return ErrWeak
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	return a.settings.Set(ctx, map[string]string{settings.KeyPasswordHash: string(h)})
}

func (a *Auth) CheckPassword(ctx context.Context, pw string) error {
	h, err := a.settings.PasswordHash(ctx)
	if err != nil {
		return err
	}
	if h == "" || bcrypt.CompareHashAndPassword([]byte(h), []byte(pw)) != nil {
		return ErrBadPassword
	}
	return nil
}

// Login verifies the password with per-IP throttling (5 failures / 15 min) and creates a session.
func (a *Auth) Login(ctx context.Context, ip, pw string) (string, time.Time, error) {
	if a.limited(ip) {
		return "", time.Time{}, ErrRateLimited
	}
	if err := a.CheckPassword(ctx, pw); err != nil {
		a.fail(ip)
		return "", time.Time{}, err
	}
	a.mu.Lock()
	delete(a.failures, ip)
	a.mu.Unlock()
	token := RandomToken(32)
	exp := time.Now().Add(sessionTTL)
	return token, exp, a.store.CreateSession(ctx, token, exp)
}

func (a *Auth) limited(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	cut := time.Now().Add(-15 * time.Minute)
	var keep []time.Time
	for _, t := range a.failures[ip] {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	a.failures[ip] = keep
	return len(keep) >= 5
}

func (a *Auth) fail(ip string) {
	a.mu.Lock()
	a.failures[ip] = append(a.failures[ip], time.Now())
	a.mu.Unlock()
}

func (a *Auth) Logout(ctx context.Context, r *http.Request) error {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return nil
	}
	return a.store.DeleteSession(ctx, c.Value)
}

func (a *Auth) Authenticated(r *http.Request) bool {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return false
	}
	ok, err := a.store.ValidSession(r.Context(), c.Value)
	return err == nil && ok
}

// Middleware rejects unauthenticated requests with 401.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.Authenticated(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func SetCookie(w http.ResponseWriter, r *http.Request, token string, exp time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: token, Path: "/", Expires: exp,
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	})
}

func ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
}

func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func RandomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
