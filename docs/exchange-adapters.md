# Exchange adapters (P1.5b)

A pluggable per-venue contract so adding a venue is one adapter file, and so
the consolidated views (P1.7b best-price, P2.2 spreads) and dynamic discovery
(P1.5c) have one place to ask "which venues exist, what do they list, what's
their connection budget." Extends P1.5a (`docs/market-data-feeds.md`), which
built Binance/Bybit/OKX as three independent packages.

## What the adapter abstracts — and what it deliberately doesn't

P1.5a's writeup found the three venues "don't share enough to be worth
abstracting" their decode / subscribe / book-gap logic — every exchange's
wire format, timeframe codes, ping rule, and sequence-continuity field differ
enough that a shared decode engine would be all special-cases. That finding
still holds. So the adapter is a **thin registry + metadata seam**, not a
generic feed engine:

The `exchange.Adapter` interface (`internal/exchange/adapter.go`) standardizes
only the parts downstream code needs to treat venues uniformly:

- **`Name()`** — the venue id used in `md.{exchange}.*` channels and health.
- **`WireSymbol(normalized)`** — maps our normalized symbol (`"btcusdt"`) to
  the venue's canonical instrument id, and reports whether the venue lists it
  at all (`ok=false` → skip). This is where per-venue symbol quirks live:
  Bybit upper-cases (`BTCUSDT`), OKX appends `-USDT-SWAP`, KuCoin renames BTC
  to XBT (`XBTUSDTM`), HyperLiquid uses the bare base (`BTC`). Downstream
  correlation (same coin across venues) goes through this.
- **`ProvidedKinds()`** — which `norm.Kind*` channels the venue emits, so a
  consumer knows e.g. not to expect funding from a spot-only venue.
- **`Limits()`** — the venue's subscriptions-per-connection budget and a
  human note on its rate-limit model. **This is P1.5c's input**: dynamic
  discovery of the full instrument universe needs connection sharding, and the
  shard count comes from here.
- **`Feeds(symbols, log)`** — builds every `conn.Feed` for the venue (the
  ws/book/(oi) split, skipping unlisted symbols). The adapter owns its own
  topology; the caller just registers whatever it returns.

Everything venue-specific — the JSON decode, the subscribe-arg builder, the
book gap/resync state machine, the ping loop — stays inside each venue
package exactly as P1.5a left it. The adapter wraps those; it does not replace
them.

## Registry & wiring

`exchange.Registry` (`internal/exchange/adapter.go`) is an ordered set of
adapters with `ByName` lookup. It's assembled in `cmd/market-data/main.go`
(not inside package `exchange`, which would create an import cycle: venue
packages import `exchange` for the interface, so `exchange` must not import
them back). `registerFeeds` iterates the registry and starts one
`conn.Manager` per returned feed — the same per-feed-Manager contract as
P1.5a, now venue-agnostic.

Adding a venue is: one new `internal/exchange/<venue>` package (feeds + decode,
same shape as the existing three) whose `Adapter()` returns an
`exchange.Adapter`, plus one line in main.go's registry assembly. No change to
`registerFeeds`, `conn`, `store`, or the gateway.

## Venues shipped here

Refactored existing three (Binance, Bybit, OKX) onto the adapter with **zero
change to their decode/book code** — only a new `adapter.go` per package.
Added two new venues to prove the "one adapter file" claim on genuinely
different shapes:

- **HyperLiquid** — a DEX perp venue; single info-API websocket, bare-base
  symbols (`BTC`), its own channel set. See `docs/market-data-feeds.md` and
  the `hyperliquid-data` skill.
- **KuCoin Futures** — a CEX whose connect path is genuinely different: a REST
  "bullet" call returns a short-lived token + WS endpoint before you can dial,
  and BTC is `XBT` (`XBTUSDTM`). The best stress test of the adapter's
  construction seam — `Feeds()` / the feed's `Connect()` does the bullet
  handshake, and nothing outside the KuCoin package knows it happens.

P1.5d then added the last three: **Aster** (`internal/exchange/aster`, a Binance
USDT-M clone — mirrors `binance` with partial-depth snapshot books), **MEXC
Futures** (`internal/exchange/mexc`, plain JSON, trades/candles/funding; book+OI
scoped out), and **BingX** (`internal/exchange/bingx`, JSON under gzip frames +
Ping/Pong; trades/candles/book, funding+OI scoped out). **All eight default
venues now run on the adapter.** See `docs/market-data-feeds.md` for each
venue's quirks and scope calls.

## Grows at

P1.5c (connection sharding + runtime lifecycle reads `Limits()` and
`WireSymbol`), P1.7b (best-price correlates venues via `WireSymbol` /
`ProvidedKinds`), P2.2 (cross-venue spreads over the same seam).
