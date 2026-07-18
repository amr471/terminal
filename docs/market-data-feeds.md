# Live exchange feeds (P1.5a)

Implements Binance/Bybit/OKX on the F0.6 `conn.Feed`/`Manager` framework
(`docs/architecture.md` §5 is the resilience contract this whole doc assumes
— reconnect backoff, staleness, sequence-gap resync, health states). Companion
to the `exchange-websockets` skill's per-exchange cheat sheet; this doc covers
what actually got built, the per-exchange divergences that weren't obvious
until implementing them, and the deliberate scope calls.

## Feed topology

Each exchange gets 2–3 `conn.Feed` implementations, each its own
`conn.Manager` and goroutine (`cmd/market-data/main.go`'s `registerFeeds`):

| Exchange | Feeds | Why this split |
| --- | --- | --- |
| Binance | `binance.ws` (trades+candles+funding, all symbols multiplexed), `binance.book.{symbol}` (one per symbol), `binance.oi.rest` (REST poller, all symbols) | Futures has no OI websocket channel — the only exchange needing a poller. |
| Bybit | `bybit.ws` (trades+candles+tickers[funding+OI], all symbols multiplexed), `bybit.book.{symbol}` (one per symbol) | `tickers` channel carries funding *and* OI together — no poller needed. |
| OKX | `okx.ws` (trades+candles+funding-rate+open-interest, all symbols multiplexed), `okx.book.{symbol}` (one per symbol) | Same as Bybit — OI is a websocket channel here too. |

> **This table is P1.5a-era and stale on book topology** (P1.5c multiplexed
> books into each venue's `*.ws` feed instead of per-symbol `*.book.{symbol}`
> feeds — see "Sharding" below). It's also stale on Binance specifically as
> of 2026-07-17: `binance.ws` is now trades+candles+funding only, and a
> second feed `binance.ws.depth` (partial-depth book) runs alongside it on
> its own connection — see "Real bugs found + fixed" below for why. Left
> as-is rather than rewritten in full to avoid asserting current book-feed
> shape for OKX/Bybit without re-verifying them too.

**Order books are always their own per-symbol `Feed`, never multiplexed
into the trades/candles connection.** `conn.Manager` tracks exactly one
`lastSeq` counter per Manager instance (`internal/conn/manager.go`) and calls
`Feed.Resync()` with no argument when it sees a gap — both only make sense if
one Feed's sequence stream maps to one coherent thing to resync. A book
multiplexed across N symbols would have its gap detection and its resync
target both become ambiguous ("which symbol's book restarts on Resync()?").
Splitting book feeds per symbol keeps the existing framework's contract
exactly correct without changing `conn.Manager` itself. Trades/candles/funding
/OI don't need this — see "Sequence numbers" below.

## Sequence numbers, concretely

For the multiplexed feeds (`*.ws`), `Seq` is a private atomic counter,
incremented once per emitted message regardless of which symbol/channel it
belongs to. Since it increments by exactly 1 every time with no exceptions,
`Manager.checkSeq`'s generic `seq == last+1` check always holds — no false
gap detection across interleaved symbols/channels, and a dropped message
(backpressure from a full channel buffer) correctly reads as a gap and
triggers a harmless resubscribe.

For book feeds, each exchange's *own* documented continuity field drives
gap detection **inside the Feed**, before anything reaches `Manager`:

- **Binance**: `pu` (previous event's final update id) must equal the last
  applied event's `u`. A gap triggers an internal REST snapshot fetch +
  buffered-delta replay (`internal/exchange/binance/book.go`'s `sync()`),
  matching the documented USDT-M futures depth procedure exactly (this
  differs from Binance's own *spot* docs, which use `U == prevU+1` instead —
  easy to copy the wrong one).
- **Bybit**: `u` must equal `lastU+1`. A gap triggers an unsubscribe+
  resubscribe — Bybit's own documented recovery, no REST call needed (the
  channel replays a fresh `"snapshot"` message on resubscribe).
- **OKX**: `prevSeqId` must equal the last applied message's `seqId`. Same
  resubscribe-based recovery as Bybit. **Checksum verification is
  intentionally not implemented** — OKX's `books` channel also carries a CRC32
  checksum over the top 25 levels for a stronger integrity guarantee; seqId
  continuity alone already satisfies §5.3's "detect gaps" mandate, and the
  checksum algorithm is enough extra surface area that it's scoped out of
  P1.5a. Worth adding if book-driven features (P1.7b, P2.1/P2.2) ever need
  the stronger guarantee.

Each book Feed's own `Seq` (fed to `Manager`) only increments on a
successfully-applied, contiguous update — so a self-healed gap (the normal
case above) never even reaches `Manager.checkSeq` as a gap; `Manager`'s own
reactive `Resync()` call is a redundant safety net for the rarer case of a
local channel-buffer drop between the Feed and the Manager.

## Per-exchange wire quirks (verified against current docs while implementing)

| | Binance (futures) | Bybit v5 (linear) | OKX v5 |
| --- | --- | --- | --- |
| Candle payload | named JSON object (`k.o`, `k.h`, ...) | named JSON object | **positional array** `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]` — decoded by position, confirm read from the last element |
| Candle timeframe codes | identical to ours (`1m`...`1d`) | numeric strings + `D`/`W`/`M` (`intervalFor`/`tfFor` maps) | each timeframe is its *own channel name* (`candle1m`...`candle1D`, note the uppercase `H`/`D`) |
| Funding/OI | `markPriceUpdate` gives funding only; OI needs REST (`/fapi/v1/openInterest`) | `tickers` channel gives both, deltas may omit unchanged fields — decoded as `*string` so "absent" ≠ "zero" | separate `funding-rate` / `open-interest` channels |
| Perp vs. spot instrument | one instrument set (already perpetual futures) | one instrument set (already linear perpetual) | **separate instId**: `BTC-USDT` is spot, `BTC-USDT-SWAP` is the perpetual this package actually wants — `internal/exchange/okx/instid.go` converts, hardcoded to this repo's USDT-quoted symbol universe (not general base/quote parsing) |
| Ping | server-initiated control-frame ping, answered automatically by gorilla/websocket's default pong handler | client sends `{"op":"ping"}` every 20s (JSON, not a control frame) | client sends the literal text `"ping"` every <30s; server replies literal text `"pong"` |
| A JSON decode gotcha worth remembering | `encoding/json`'s case-insensitive fallback matching collided a message's `E` (event time) with a `classify()` struct that only declared a field for `e` (event type) — `"E":1` tried to fall back onto the `e`-tagged string field and failed to unmarshal a number into a string. Fixed by decoding `{"e": ...}` through a `map[string]json.RawMessage` instead of a struct (map keys are never case-folded). Every other Binance decode struct declares *both* `"e"` and `"E"` explicitly, which is why only `classify()` hit this. | — | — |

## Symbol universe

`MARKET_DATA_SYMBOLS` env var, comma-separated, default `btcusdt,ethusdt,solusdt`
(same three as `db/dev/seed.sql`'s placeholder rows). Fetched from **all
three exchanges** — cross-exchange comparison is the architectural point
(feeds P1.7b's best-price and P2.2's spread/arb view later), unlike
`seed.sql`'s placeholder which assigned one exchange per symbol. Stocks
(`aapl` in the seed data) are out of scope here — that's P1B.3's own market
data source.

## Persistence: `internal/store`

- **Hypertables** (`candles`, `funding`, `oi`): written on every *final*
  candle bucket / funding tick / OI reading. Order books are **not**
  persisted to Postgres — `docs/schema.md` §5 already decided this
  ("books live in Redis `cache:book:*`, Postgres only gets derived series").
- **`instrument_state`**: two cadences, not per-tick, so a busy trade stream
  never hammers Postgres:
  - Live fields (price, spread, funding rate, open interest) update
    in-memory on every tick; a **2s flush loop** upserts the current
    snapshot.
  - Derived stats (`change_1h/24h/7d`, `volume_24h`, `volatility_24h`) need
    historical candles, so a **30s recompute loop** queries this service's
    own just-persisted hypertables (`PriorClose`/`RecentCloses`/`Volume24h`
    in `internal/store/postgres.go`) and updates the in-memory state for the
    next flush to pick up. `volatility_24h` is the population stdev of
    hourly log returns over the trailing ~24h of 1h candles.
  - **These derived fields are legitimately `NULL` for the first ~24h after
    a symbol starts ingesting** — there's no history yet to compute a
    baseline against. Not a bug.
  - `market_cap` is always `NULL` — no circulating-supply data source is
    wired up yet (would need a CoinGecko-style reference API, out of scope
    here). Same placeholder-field stance as `db/dev/seed.sql`'s `aapl` row.
- **`cache:ticker:{exchange}:{symbol}`** (Redis, TTL 10s) / **`cache:book:{exchange}:{symbol}`**
  (Redis, no TTL, overwritten) — architecture.md §4.1's contract, consumed
  verbatim by the gateway's `GET /md/snapshot/:exchange/:symbol`
  (`docs/gateway-ws.md`, previously always `null` — **this is what populates
  it**). `cache:book` mirrors up to 50 levels per side (`store.bookLevels`).

## OI polling cadence (Binance only)

30s per symbol (`binance.pollInterval`). Binance's own OI number isn't
real-time on their side either; this stays well under any reasonable public
rate limit across a handful of symbols while remaining fresh enough for a
screener column (not a scalping signal — Bybit/OKX's websocket OI is
naturally more current).

## Testing

Every exchange's decode functions, subscribe-arg builders, and book
gap/resync state machines are unit tested against exchange-shaped JSON
fixtures — no live network or mock websocket server needed, since the
network-facing `Connect()`/read-loop layer is a thin wrapper around already-
tested pure `handle()`/`onUpdate()` methods (same pattern as the F0.6
`fakeFeed` tests in `internal/conn/manager_test.go`). `internal/store`
follows the same shape: `Aggregator` is tested against a `fakeWriter` +
`miniredis` + a fake clock (no sleeping, no real Postgres); `Postgres` itself
gets its own skip-if-unreachable integration tests
(`internal/store/postgres_test.go`), matching every TS test suite's existing
convention — this sandbox has no Docker, so those 5 tests skip here and run
for real on John's machine or CI.

## New venues via the adapter (P1.5b)

P1.5b introduced the `exchange.Adapter` contract (`docs/exchange-adapters.md`)
and added two venues on top of the original three, to prove "adding a venue is
one package." Both are structurally different from the CEX-perp trio above, so
they exercise the seam rather than copy it:

### HyperLiquid (`internal/exchange/hyperliquid`)

A DEX perp venue. **One multiplexed connection carries everything** — trades,
candles, book, funding, OI — unlike the P1.5a rule of splitting order books
into per-symbol feeds. That rule existed only for exchange-sequence gap
detection; HyperLiquid's `l2Book` is a **full-snapshot** channel (each message
is the whole book, pushed each block ≥0.5s), so there is no per-book sequence
to gap-check and nothing to `Resync` — the feed's own monotonic counter is the
only `Seq`, exactly like the *.ws feeds. Other quirks:

- **Symbols are the bare base coin** (`BTC`, not `BTCUSDT`); `coinFor`/
  `symbolFor` convert. USD-margined, keyed by coin.
- **Funding + OI both come from one `activeAssetCtx` channel** (like Bybit's
  tickers) — no REST poller. That channel carries no event timestamp, so we
  stamp receive time into `ts` (flagged VERIFY in the package doc).
- **Candle numeric fields arrive as JSON numbers *or* strings**; `flexStr`
  (decode.go) accepts both and keeps them as string decimals.
- **No candle "closed" flag on the wire**, so final-bucket detection is by
  open-time rollover (`candleTracker`): a message for a later bucket finalizes
  the previous one. Same normalized `Final` result as the exchanges that send
  a confirm flag, different source.

### KuCoin Futures (`internal/exchange/kucoin`)

The CEX chosen to stress the adapter's **construction** seam: you can't dial a
fixed URL. `WSFeed.Connect` first does a REST **bullet handshake**
(`POST /api/v1/bullet-public` → short-lived token + server list + ping
cadence, `bullet.go`), then dials the returned endpoint with
`?token=…&connectId=…`. Nothing outside the package knows the handshake
happens. Other points:

- **BTC is `XBT`**: the contract is `XBTUSDTM`. `wireSymbol` applies the
  rename so the quirk stays contained.
- **Book uses `level2Depth50`** — full 50-level snapshots ~every 100ms — so,
  like HyperLiquid, it's multiplexed with no per-symbol seq machine. The
  alternative `level2` delta channel (REST-snapshot bootstrap + seq tracking)
  is scoped out; add it only if a book-driven feature needs sub-100ms
  freshness.
- **Candle array order is `[time, open, CLOSE, high, low, volume, turnover]`**
  — open/close come before high/low; decoded positionally, final via the same
  rollover tracker as HL.
- **Two documented scope calls** (same stance as OKX-checksum / `market_cap`
  above, not silent gaps): trade **quantities are in contracts** (lot size),
  emitted verbatim — normalizing to base units needs each contract's
  multiplier (REST `/contracts`), a follow-up before any size-sensitive
  consumer (P1.7b). And **open interest is not wired** (KuCoin exposes it via a
  separate snapshot/REST path, not the channels used here), so KuCoin's
  `ProvidedKinds()` omits `oi` and a REST OI poller — like Binance's — is the
  natural follow-up.

### Aster (`internal/exchange/aster`, P1.5d)

Aster (AsterDEX) is a **Binance USDT-M clone** — same `@aggTrade`/`@kline_<tf>`
/`@markPrice`/`@depth<levels>` stream names, combined-stream `SUBSCRIBE`
method, and `/fapi/v1/*` REST surface (`wss://fstream.asterdex.com`,
`https://fapi.asterdex.com`). So this package mirrors `binance` rather than
sharing its code (keeps the just-confirmed binance venue untouched; extract a
shared Binance-dialect core only if a third clone appears). Two deliberate
differences, both documented scope choices:

- **Book uses the partial-depth snapshot stream** (`@depth20@100ms`), not
  binance's diff-depth `@depth` + REST-snapshot/replay machine. Each
  partial-depth message is a full top-20 snapshot, so it's multiplexed into
  the one ws feed with no per-symbol book feed and no `U`/`u`/`pu` gap machine
  — same topology as HyperLiquid/KuCoin. Top-20 covers the cache:book
  first-paint and best-price (P1.7b); upgrade to diff-depth if a book-driven
  feature needs full Aster depth.
- **Open interest** rides a REST poller against `/fapi/v1/openInterest`
  (Binance-standard path, `aster.oi.rest`) — the one Binance-family channel
  with no websocket equivalent. VERIFY the endpoint exists on Aster; if it
  differs/absent, fetches log and OI stays null (ADR-006), not a crash.

Funding comes off `@markPrice` (`r` field), exactly like binance — no separate
funding channel or poller.

### MEXC Futures (`internal/exchange/mexc`, P1.5d)

`wss://contract.mexc.com/edge`, **plain JSON** — the protobuf format is MEXC
*spot* only. Each subscribe sends `"gzip": false` so responses arrive
uncompressed. One multiplexed feed: `sub.deal` (trades), `sub.kline` (candles,
`interval` codes `Min1`..`Day1`), `sub.funding.rate` (funding). Client ping
`{"method":"ping"}` → `{"channel":"pong"}`. Symbol form `BTC_USDT`; trade side
`T` = 1 buy / 2 sell; kline `t` is the window-start in **seconds** (×1000) with
no closed-bucket flag → open-time rollover finals (same tracker as HL/KuCoin).

Three documented scope calls for this first cut (not silent — same stance as
OKX-checksum above):

- **Book not wired.** MEXC's only native depth channel (`push.depth`) is
  *incremental* (version-keyed 200ms deltas, levels `[price, orderCount, qty]`)
  with no native full-snapshot variant, so a correct book needs a REST-snapshot
  bootstrap + version-continuity machine. `ProvidedKinds` omits `book`.
- **OI not wired.** MEXC surfaces OI via `push.tickers`/contract-data, not a
  per-symbol OI stream this feed uses. `ProvidedKinds` omits `oi`.
- **Trade quantities in contracts** (`v`), emitted verbatim — same base-unit
  normalization gap as KuCoin.

MEXC's **30-channels-per-connection** cap is the tightest of any venue: at 8
channels/symbol (deal + funding + 6 klines) the static 3-symbol MVP fits one
connection (24), but the full universe won't — the first venue P1.5c must
shard (reads `Adapter.Limits()`).

**Real bug found + fixed (2026-07-17):** production logs showed recurring
`"decode deal: json: cannot unmarshal string into Go struct field
dealMsg.i of type int64"` — MEXC sends the deal id (`i`) as a JSON *string*
for some deals, not consistently as a number. `decodeDeals` unmarshals the
whole batch in one `json.Unmarshal` call, so a single bad-shaped `i` failed
the entire frame, dropping every trade in it, not just the offending one.
Fixed by declaring `dealMsg.I` as `flexStr` (the same JSON-string-or-number
type already used for `p`/`v` on this struct) instead of `int64` — `i` was
only ever converted to a string ID afterward anyway, so there was no real
reason to force it through `int64` in the first place. Regression test:
`TestDecodeDeals_StringDealID`.

## Backpressure ("dropped message; consumer too slow") — expected, not a bug, but worth knowing the lever

Every venue's `WSFeed.emit` pushes onto a buffered channel (`f.msgs`, size
256) with a non-blocking `select`/`default` — if the single consumer
goroutine (`conn.Manager.consume`, which calls the sink synchronously per
message) can't drain it fast enough, new messages are dropped rather than
blocking the read loop, logged as `"dropped message; consumer too slow"`.
This is ADR-004's documented lossy-by-design stance for `md.*`, not new
behavior — but two things make it worth flagging: (1) it recurs
persistently for `hyperliquid` (funding/oi) and `bingx` (book/trades) under
real load, meaning the 256-message buffer is undersized relative to how
many symbols those two venues' single shared connection multiplexes; (2)
unlike trades (where losing one update is harmless — the next one
supersedes it), a dropped `oi`/`funding` message leaves that field stale
until the *next* update fires, which is a plausible contributor to sparse-
looking Open Interest data. Not fixed this round — the real fix is either a
bigger buffer (cheap, just delays the problem) or moving the sink call off
the single per-feed consumer goroutine (a bigger architectural change,
worth a real discussion before building). Flagged here rather than
silently building either without agreeing on the approach first.

## "context canceled" bursts on shutdown/restart — expected, same root cause class as the WaitGroup fix above

A burst of `"store: flush instrument_state failed... context canceled"`
(Postgres) and `"fetch open interest failed... context canceled"`
(binance's OI REST poller) landing together, all sharing the exact same
`context canceled` reason, is the signature of one shared `ctx` cancellation
event — i.e. the process was stopped (SIGINT) while those operations were
in flight. This is different from the earlier crossed-book-adjacent bug:
those calls already correctly respect `ctx` and abort promptly when it's
cancelled, which is the *correct* behavior for a graceful shutdown — an
in-flight Postgres upsert or HTTP request can't finish "for free" just
because the process is shutting down gracefully; something has to interrupt
it. The `sync.WaitGroup` fix above's job was narrower: guarantee nothing
touches an *already-closed* Redis/Postgres client, not guarantee every
in-flight write completes. These logs are therefore expected noise around
any restart, not a new bug — though logging them at `ERROR` rather than a
quieter level during a confirmed shutdown could be revisited if the noise
itself becomes a problem (not done here, since distinguishing "shutdown in
progress" from "this connection genuinely failed" at each call site is
non-trivial and wasn't asked for).

### BingX (`internal/exchange/bingx`, P1.5d)

`wss://open-api-swap.bingx.com/swap-market` (swapV2). Two BingX-specific
wrinkles: **every server frame is GZIP-compressed** (the read loop gunzips
before decoding, `compress/gzip`), and the heartbeat is a literal **"Ping" →
"Pong"** (server sends a gzipped `Ping` every ~5s; client replies with the text
`Pong`). Subscribe is one `{"id","reqType":"sub","dataType":...}` frame per
topic (200 topics/socket). One multiplexed feed: trades (`{symbol}@trade`,
`{T,s,m,p,q}`, `m`=buyer-is-maker → taker sold, Binance-style), candles
(`{symbol}@kline_<interval>`, `1min`..`1day`, Binance-flavored
`{e,E,s,K{t,T,o,c,h,l,v,q}}`, no close flag → rollover finals), and book
(`{symbol}@depth<level>@<interval>`, a limited snapshot of `[price,qty]` arrays
+ `ts` — multiplexed, no seq machine, like Aster/HL/KuCoin). Symbol form
`BTC-USDT`. Note the kline `K` must declare both `t` and `T` or encoding/json
folds `T` onto `t` (the same case-fold trap as `binance.classify`).

The current wire format was read off the live docs' compiled JS bundle (the
docs site is a client-rendered SPA; the older `bingbon.pro` mirror is stale and
was **not** used). Scoped out for this first cut (documented, same stance as
MEXC): **funding and open interest** — BingX exposes neither as a swapV2 ws
market channel this feed uses (both are REST), so `ProvidedKinds` lists only
trades, candles, book. A REST poller is the follow-up.

### All eight default venues are now on the adapter

Binance, Bybit, OKX (P1.5a/b) · HyperLiquid, KuCoin (P1.5b) · Aster, MEXC,
BingX (P1.5d). Adding the next venue remains one `internal/exchange/<venue>`
package + one registry line.

## Dynamic instrument universe (P1.5c)

P1.5a's static `MARKET_DATA_SYMBOLS` is replaced by a supervisor
(`internal/supervisor`) that discovers each venue's live instrument list,
shards it across connections, and starts/stops feeds at runtime as symbols
list and delist. `MARKET_DATA_SYMBOLS`, if set, is now an **optional static
override** (handy for local dev / CI so we don't poll eight REST endpoints or
open hundreds of connections); left empty, the supervisor runs.

**Discovery.** Each `exchange.Adapter` gained `Instruments(ctx) ([]string,
error)` — a REST call to the venue's instrument endpoint, filtered to live
USDT perpetuals and returned as normalized symbols. Endpoints (all **VERIFY**
against live docs — response shapes were written from knowledge, defensively
filtered; a wrong shape yields an empty list and that venue simply gets no
feeds, never a crash): Binance/Aster `/fapi/v1/exchangeInfo`, Bybit
`/v5/market/instruments-info?category=linear`, OKX
`/api/v5/public/instruments?instType=SWAP`, KuCoin `/api/v1/contracts/active`,
MEXC `/api/v1/contract/detail`, BingX `/openApi/swap/v2/quote/contracts`,
HyperLiquid `POST /info {"type":"meta"}`.

**Sharding (stable by hash).** Each venue also gained `StreamsPerSymbol()`;
shard size = `Limits().MaxStreamsPerConn / StreamsPerSymbol`. The number of
shard *slots* is fixed from the `MAX_SYMBOLS_PER_VENUE` cap (not the current
count), and a symbol maps to a slot by hash — so a listing/delisting only
disturbs the one shard it hashes into, never the whole venue (no mass
resubscribe). A shard of symbols is one `Adapter.Feeds(shard)` call → one
multiplexed connection (the P1.5c book refactor is what makes this true: books
ride the ws feed, so there's no per-symbol book connection to explode).

**Runtime lifecycle.** One discovery goroutine per venue owns that venue's
running-shards map (no lock). Each shard's managers run under a per-shard
context that is a child of the venue context; a membership change cancels the
old shard (which closes its connections via `conn.Manager`) and starts a fresh
one, and supervisor shutdown cancels everything and waits for the managers to
exit — no leaked goroutines or sockets. The placement decisions (`shardSize`,
`shardCount`, `assignShards`, `planReconcile`) are pure and unit-tested apart
from the goroutine machinery.

**Prune.** When a symbol delists, the supervisor calls `Aggregator.Forget`
(a `supervisor.Pruner`): it drops the in-memory instrument_state + book, the
`cache:ticker`/`cache:book` Redis keys, and the `instrument_state` Postgres row
so the screener never shows dead instruments. Hypertables (candles/funding/oi)
are append-only history and kept.

**Config:** `MAX_SYMBOLS_PER_VENUE` (default 200 — bounds connection and
Postgres load; the true "every perpetual" universe is thousands), and
`DISCOVERY_INTERVAL` (default 5m). Their metadata inputs (`Limits()`,
`StreamsPerSymbol()`) carry VERIFY markers to tune before lifting the cap.

## Real bug found + fixed: shutdown closed Redis before feeds stopped writing (2026-07-17)

John reported a burst of near-identical log lines on shutdown — `"redis:
client is closed"` errors from `store: write ticker cache`/`store: write book
cache` (multiple venues) landing at the same millisecond as `"read error;
feed will reconnect"` / `"use of closed network connection"` warnings from
those same venues' feeds. Root cause: `cmd/market-data/main.go` started
`agg.Run(ctx)`, `publisher.Heartbeat(ctx, ...)`, and either
`sup.Run(ctx)`/`registerFeeds`'s per-feed `mgr.Run(ctx)` goroutines with a
bare `go` and never joined any of them before returning — `main()`'s
deferred `client.Close()`/`pg.Close()` ran the instant `<-ctx.Done()` +
`srv.Shutdown()` finished, racing every feed/aggregator goroutine that was
independently reacting to the same `ctx` cancellation and tearing down its
own websocket. A goroutine mid-teardown could still be flushing one last
write to Redis at the exact instant the deferred `Close()` fired.

Every one of those goroutines already returns promptly on `ctx.Done()`
(`Manager.Run`, `Aggregator.Run`, `Redis.Heartbeat`, `Supervisor.Run` all
`select` on it — this wasn't a "goroutine never exits" bug), so the fix is
purely about *waiting* for that exit before closing shared clients: a
top-level `sync.WaitGroup` in `main()` that every one of those goroutines
joins, `wg.Wait()`'d (with a 10s bounded fallback, since nothing here is
expected to hang) between `srv.Shutdown()` and the function returning.
`registerFeeds` (the static-`MARKET_DATA_SYMBOLS` path) now takes the
`*sync.WaitGroup` as a parameter so its per-feed managers are tracked the
same way. `go build`/`go vet`/`gofmt` clean; `go test ./... -race` — every
package still passes, 0 fail (this file has no test file of its own, it's
pure goroutine-lifecycle wiring, not additional pure logic to unit test).

## Real bugs found + fixed: OKX message-too-big and Binance's legacy WS endpoint decommission (2026-07-17)

John ran `go run ./cmd/market-data` live and pasted the first ~7 seconds of
output: repeated `websocket: close 1009 (message too big)` from OKX and
`websocket: close 1008 (policy violation): Invalid request` from Binance,
alongside one `"http: server gave HTTP response to HTTPS client"` discovery
failure from Aster. All three are addressed below; the OKX/Binance ones are
the more direct explanation for "not all the coins are there" than the
backpressure-buffer fix earlier in this doc, since these two venues were
failing to hold a connection at all under real 200-symbol shard load.

**OKX — 1009, fixed.** `okx/adapter.go`'s `Limits()` has carried
`MaxStreamsPerConn: 0` (shard math treats 0 as uncapped) with a "VERIFY the
current numbers before P1.5c sharding" comment since that section landed —
never resolved. At a real 200-symbol/`StreamsPerSymbol()`=10 shard, that's
~2000 subscribe args, all sent in one `{"op":"subscribe","args":[...]}`
message. Verified against OKX's v5 docs 2026-07-17: there's no documented cap
on how many channels one *connection* may hold, but there is a hard 4096-byte
cap on any single SUBSCRIBE *message's* argument payload, plus a 3-req/s (480/hr)
subscribe rate limit — our one giant message was ~10x over the byte cap, and
OKX's server rejected it outright. Fixed without touching shard size (it
didn't need to shrink): `okx/decode.go` gained `subscribeBatches`, which
splits the arg list into chunks that each marshal under ~3800 bytes (measured
per-arg via `json.Marshal`, not estimated), and `okx/ws.go` gained
`subscribeAll`, which writes those batches ~400ms apart (comfortably under
3 req/s) and is `ctx`-aware so a shutdown mid-subscribe doesn't block on the
pacing sleep. `WSFeed.Connect` now starts `readLoop`/`pingLoop` *before*
calling `subscribeAll` (previously subscribe-then-start-reading) — a
multi-second batched subscribe means OKX starts acking/pushing data for
early batches while later ones are still being sent, and nothing was
draining the connection during that window before this fix. `Resync` batches
the same way. `okx/adapter.go`'s `Limits()` doc comment now records the
verified numbers instead of carrying the open VERIFY.

**Binance — 1008, fixed.** This one wasn't a sharding bug at all: Binance
migrated USDS-M futures websockets from a single unrouted
`wss://fstream.binance.com/ws` to three routed bases —
`/public` (book/bookTicker), `/market` (aggTrade/markPrice/kline/ticker),
`/private` (user data) — and, per their "Important WebSocket Change Notice",
**decommissioned the legacy unrouted URLs on 2026-04-23**. Today is
2026-07-17: every Binance connection this service opened was hitting a URL
that no longer exists, hence the policy-violation close on every single
shard regardless of how well-sized they were (shard math itself was correct
— `MaxStreamsPerConn: 200` even undersold the venue's real 1024-streams/conn
cap, so shards were never the problem). Fixed by splitting `WSFeed` (still
`aggTrade`+`markPrice`+`kline`, now dialing `wss://fstream.binance.com/market/ws`)
and a new `DepthFeed` (`binance.ws.depth`, just the partial-depth stream,
dialing `wss://fstream.binance.com/public/ws`) — two connections per shard
now instead of one, since a single connection can only receive one route's
data. `binance/adapter.go`'s `Feeds()` returns both alongside the existing
REST OI poller. `StreamsPerSymbol()` dropped from 9 to 8 (aggTrade+markPrice+
6 klines; depth's 1-stream cost moved to `DepthFeed` and is low enough
relative to `MaxStreamsPerConn` that sizing shards off the market
connection's cost alone keeps both connections safely under budget). Also
corrected `Limits().MaxStreamsPerConn` from a stale 200 to the verified
current 1024 — unrelated to the 1008s (the old 200 was conservative, not
wrong-direction), but flagged VERIFY since P1.5c and worth fixing alongside
everything else touched here. Binance's 24-hour "connection is only valid for
24 hours; expect to be disconnected" limit is unchanged and already handled
by `conn.Manager`'s reconnect loop.

**Aster — likely not a bug.** The one `"http: server gave HTTP response to
HTTPS client"` discovery failure didn't recur in the pasted log, and
`aster/aster.go`'s `restBase` is already `https://fapi.asterdex.com` (correct
scheme) — so this reads as a transient issue on Aster's side, not a client
bug. Nothing to fix; the existing "instrument discovery failed; keeping
current shards" degradation path already handled it gracefully (no crash, no
lost shards). Worth another look if it recurs.

Verified: `go build ./...`, `go vet ./...`, `gofmt -l .` clean; `go test
./... -race -count=1` — every package passes, 0 fail, including new tests for
`subscribeBatches` (byte-cap correctness at 200-symbol scale) and the split
`WSFeed`/`DepthFeed` topology. Not yet verified: a live re-run against the
real exchanges (this fix was built and unit-tested in the sandbox, which has
no outbound access to Binance/OKX's actual websocket endpoints) — John still
needs to run `go run ./cmd/market-data` again and confirm the 1008/1009
closes are gone before this counts as confirmed fixed in production.

## Grows at

P1.6 (screener reads `instrument_state`), P1.7b (best-price correlates venues
via `Adapter.WireSymbol`/`ProvidedKinds`; also wants KuCoin's contract→base
qty normalization), P1.8 (charts read `candles`), P1.12 (alert engine reads
`md.*`), P1.5c (connection sharding reads `Adapter.Limits()`; runtime
lifecycle over the full universe), P2.1 (real order-book aggregation may want
the OKX checksum this doc scoped out, and could revisit per-symbol book Feed
granularity at higher venue counts), P2.2 (cross-venue spreads over the same
adapter seam).
