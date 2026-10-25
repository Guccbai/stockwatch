package monitor

import "sync"

// Message is pushed to live WebUI clients over SSE.
type Message struct {
	Type string `json:"type"` // "events" | "poll"
	Data any    `json:"data"`
}

// Hub fans out messages to subscribers; slow subscribers drop messages instead of blocking polling.
type Hub struct {
	mu   sync.Mutex
	subs map[chan Message]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[chan Message]struct{}{}} }

func (h *Hub) Subscribe() (<-chan Message, func()) {
	ch := make(chan Message, 32)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
}

func (h *Hub) Publish(m Message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- m:
		default:
		}
	}
}
