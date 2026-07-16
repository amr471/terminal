// Package wsutil is the tiny shared dial/read/write helper every exchange
// package builds on. Exchange-specific subscription payloads, symbol
// mapping, and decode logic stay in each exchange's own package (they don't
// share enough to be worth abstracting) — this package only owns the
// gorilla/websocket plumbing common to all three.
package wsutil

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Conn wraps a gorilla/websocket connection with the one thing its docs
// call out explicitly: writes need external synchronization if more than one
// goroutine can call them (a read loop goroutine and a ping-sender goroutine,
// in every feed that uses this package).
type Conn struct {
	ws      *websocket.Conn
	writeMu sync.Mutex
}

// Dial opens a websocket connection with a bounded handshake timeout — never
// hang forever on a hostile/slow endpoint (CLAUDE.md §2).
func Dial(ctx context.Context, url string) (*Conn, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	ws, _, err := dialer.DialContext(ctx, url, nil)
	if err != nil {
		return nil, fmt.Errorf("wsutil: dial %s: %w", url, err)
	}
	return &Conn{ws: ws}, nil
}

func (c *Conn) WriteJSON(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.ws.WriteJSON(v)
}

func (c *Conn) WriteText(s string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.ws.WriteMessage(websocket.TextMessage, []byte(s))
}

// ReadMessage blocks for the next text/binary frame. gorilla's default ping
// handler already answers server-initiated control-frame pings with a pong
// automatically — Binance's "answer within 1s" rule (exchange-websockets
// skill) is satisfied without extra code as long as nothing overrides the
// handler.
func (c *Conn) ReadMessage() ([]byte, error) {
	_, data, err := c.ws.ReadMessage()
	return data, err
}

func (c *Conn) SetPongHandler(h func(appData string) error) { c.ws.SetPongHandler(h) }

func (c *Conn) Close() error { return c.ws.Close() }
