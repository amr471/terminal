---
name: exchange-websockets
description: Use when connecting to Binance, Bybit, or OKX websocket feeds — subscription formats, ping/pong rules, sequence semantics for order books, and how each feed plugs into the market-data conn.Feed framework.
---

# Exchange websockets (Binance / Bybit / OKX)

Free prices/candles/books (CLAUDE.md §7). Every connection goes through
`services/market-data/internal/conn` — never hand-roll reconnect logic; the
Manager owns backoff (§5.1), staleness (§5.2), and gap resync (§5.3).

## Per-exchange cheat sheet (VERIFY against current docs when implementing)

| | Binance (futures) | Bybit v5 | OKX v5 |
| --- | --- | --- | --- |
| URL | `wss://fstream.binance.com/ws` | `wss://stream.bybit.com/v5/public/linear` | `wss://ws.okx.com:8443/ws/v5/public` |
| Subscribe | `{"method":"SUBSCRIBE","params":["btcusdt@aggTrade"],"id":1}` | `{"op":"subscribe","args":["publicTrade.BTCUSDT"]}` | `{"op":"subscribe","args":[{"channel":"trades","instId":"BTC-USDT"}]}` |
| Ping rule | server pings; answer pong <1s or be dropped | client pings every 20s `{"op":"ping"}` | client sends literal `ping` every <30s |
| Book seq | `U`/`u` first/final update id; resync via REST snapshot + buffered deltas | `u` update id, `type: snapshot|delta` | `seqId`/`prevSeqId`; checksum field for verification |
| Symbol form | `btcusdt` (lower in stream name) | `BTCUSDT` | `BTC-USDT` |

Normalize all symbol forms with `norm.NormalizeSymbol` → `btcusdt`.

## Implementing a feed

1. Implement `conn.Feed` (Name, ExpectedInterval, Connect, Messages, Resync, Close).
2. Decode exchange JSON → `norm.Envelope` with string decimals, exchange event
   time in `ts`, receive time in `rts`, and your own per-channel `seq`.
3. Book feeds: implement `Resync` = REST snapshot + delta replay; never
   publish from a gapped book (§5.3).
4. Register in `cmd/market-data/main.go`: one Manager per feed, own goroutine.
5. Tests use a fakeFeed — see `internal/conn/manager_test.go` for the pattern.

## Grows at

P1.8 (charts data), P1.6 (screener updates), P2.1 (book aggregation).
