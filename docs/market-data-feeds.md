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

## Backpressure ("dropped message; consumer too slow") — expected in small doses, was a real bug at scale for bybit/OKX (fixed 2026-07-19, see below)

Every venue's `WSFeed.emit` pushes onto a buffered channel (`f.msgs`) with a
non-blocking check/send — if the single consumer goroutine
(`conn.Manager.consume`, which calls the sink synchronously per message)
can't drain it fast enough, new messages are dropped rather than blocking
the read loop, logged as `"dropped message; consumer too slow"`. This is
ADR-004's documented lossy-by-design stance for `md.*`, not new behavior —
occasional drops under a burst are fine. What was NOT fine, and got fixed
2026-07-19, is when an entire venue's multiplexed connection structurally
can't keep up under sustained real load — see "Real bugs found + fixed:
seq-before-drop ordering, bybit/OKX mega-shard backpressure" below for the
full story (this note used to end with "not fixed this round... worth a
real discussion before building" — that discussion happened via research
into each venue's real documented limits, and the fix landed as
per-venue connection sharding, not a Manager-level architecture change).

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

## Real bugs found + fixed: OKX subscribe-ack misclassification, buffer bump, Aster kline decode (2026-07-18)

John ran `go run ./cmd/market-data` live to verify the fixes above and
pasted a screenshot (Screener/Best Price tables now showing symbol columns
correctly, unrelated frontend fix) alongside a fresh log dump. The
OKX/Binance connection fixes held — no more 1008/1009 closes — but the log
exposed a new, real regression the OKX batching fix itself introduced,
plus one unrelated Aster decode bug.

**OKX — a burst of hundreds of `"decode trades/funding-rate/open-interest/
books5 failed","err":"...unexpected end of JSON input"` plus a matching
flood of `"dropped message; consumer too slow"`, both within a ~300ms
window right after connecting.** Root cause: `okx/decode.go`'s `classify()`
filtered out subscribe acks/errors by checking only `env.Arg == nil` — but
OKX subscribe acks *do* carry `arg` (they echo back the channel/instId just
subscribed: `{"event":"subscribe","arg":{...},"connId":"..."}`). That gap
existed before today but was harmless when one shard sent a single SUBSCRIBE
message and got back a handful of acks. The 2026-07-18 batching fix (above)
that fixed the 1009 "message too big" made it a real problem: OKX acks each
subscribed arg individually, so a 200-symbol shard (~2000 args) now
produces on the order of 2000 ack frames in a burst right after connecting.
Every one of those was being misclassified as a real data push and handed
to `decodeTrades`/`decodeFunding`/`decodeOI`/`decodeBook5`, all of which
failed on the ack's missing `data` field — and processing ~2000 failed
decodes synchronously in the single read/decode goroutine is what was
actually starving real message consumption and triggering the backpressure
drops, not primarily real traffic volume. Fixed by checking `Event != ""`
first (real data pushes never carry `event`; acks/errors always do, with or
without `arg`) — a one-line change, `env.Event != "" || env.Arg == nil`.
`TestClassify_SubscribeAckIgnored` used to only document this shape
(`_ = ok`, no assertion); now asserts `ok == false`.

**OKX — also bumped the per-feed buffer 256→1024**, same fix and same
reasoning hyperliquid/bingx got 2026-07-17: a full 200-symbol shard on one
connection is real load (trades+funding+OI+books5+6 candle streams), and
the ack-flood fix alone doesn't guarantee the buffer never fills under
genuine peak traffic.

**Aster — `"decode kline failed","err":"aster: decode kline: json: cannot
unmarshal number into Go struct field .k.l of type string"`.** Same bug
class as the 2026-07-17 MEXC deal-id fix: Aster's kline low-price field
arrived as a JSON *number* instead of the string this repo's `klineMsg`
struct expected, and one bad-shaped field failed the whole message's
decode. Fixed by adding a local `flexStr` type (same pattern as mexc's) and
applying it to all four OHLC fields (`o`/`h`/`l`/`c`), not just the one
caught in the log — they're the same data shape from the same vendor, so
if one field is inconsistent about string-vs-number the others are equally
suspect.

Verified: `go build ./...`, `go vet ./...`, `gofmt -l .` clean; `go test
./internal/... -race -count=1` — every package green **except one known
pre-existing flake**: `internal/supervisor`'s `TestReconcileStartsStopsRestarts`
timed out waiting for a fake feed close in 2 of 4 `-race` runs (always passes
without `-race`, and without `-race -count=1` it's cached-green). Confirmed
via `git diff` that nothing in `internal/supervisor` changed today or in the
2026-07-17 round — this is a pre-existing timing-sensitive test, most likely
too tight a margin between its `waitFor` 2s deadline and `-race`'s slower
goroutine scheduling, not a real regression. Not fixed here (out of scope
for today's OKX/Aster bugs); worth a dedicated look if it keeps showing up.

Not yet verified: whether these three fixes actually eliminate the flood
on a real live run — John needs to run `go run ./cmd/market-data` again and
confirm no more OKX decode-failed/dropped-message bursts and no more Aster
kline-decode warnings.

## Real bugs found + fixed: seq-before-drop ordering, bybit/OKX mega-shard backpressure (2026-07-19)

John reported the Screener (sorted by volume desc) was overwhelmingly
kucoin rows with almost no binance/bybit/okx, and asked whether a VPN was
interfering. A fresh live run's logs told a different, fully-explainable
story — not network/VPN, our own consumer code:

**Root cause 1 — seq assigned before the drop check, in every venue's
`emit()`.** All 11 emit sites (binance ws.go/depth.go/oi.go, bybit, okx,
kucoin, mexc, bingx, aster ws.go/oi.go, hyperliquid) called `f.seq.Add(1)`
unconditionally while building the envelope, *before* the non-blocking
`select`/`default` that might drop it. A dropped message still consumed a
sequence number, so `Manager.checkSeq` (internal/conn/manager.go) saw a gap
among what actually arrived and misdiagnosed an ordinary backpressure drop
as a real "sequence anomaly" — logged and handled identically to genuine
lost-in-transit data, triggering `Resync()`. For bybit/OKX (see below),
`Resync()` resubscribes *every symbol on the shard*, adding SUBSCRIBE
traffic on top of an already-overloaded connection right when it's least
able to absorb it — a feedback loop that made bursts worse, not better.
Fixed everywhere: `Seq` is now only assigned to messages that actually
enqueue (checked via `len(f.msgs) >= cap(f.msgs)` before sending — safe
without a lock since `emit()` only ever runs on each feed's single
producer goroutine: the WS `readLoop`, or the REST `OIFeed`'s single poll
loop).

**Root cause 2 — bybit and OKX both had `MaxStreamsPerConn: 0` (uncapped),
collapsing their entire 200-symbol universe onto ONE connection.** Compare
KuCoin, which has zero drops in every live run so far: KuCoin's real
~100-topics/connection exchange limit forces `shardSize≈11`,
`shardCount≈19` — 19 independent connections, each with its own
`Manager.consume` goroutine synchronously publishing to Redis, so the
publish workload is naturally spread across 19 goroutines instead of
piling onto one. Bybit (`StreamsPerSymbol()=9`) and OKX
(`StreamsPerSymbol()=10`) don't have a comparable exchange-imposed
subscription-count limit, so `MaxStreamsPerConn` had been left at `0`
("uncapped") — correct as far as what each exchange itself allows, but it
meant ~1800-2000 multiplexed streams draining through a *single* consumer
goroutine that blocks on a Redis round-trip per message. Under real market
throughput that goroutine falls behind, `f.msgs` fills, and `emit()` starts
dropping — hundreds of drops/sec in today's log, which is also why
binance/bybit/OKX symbols were so sparse in the Screener: `instrument_state`
is populated purely from live WS ticks (no REST backfill,
`store/aggregator.go`), so a symbol whose trade/kline messages keep getting
dropped never gets a complete row.

Fixed by giving both venues a real, *self-imposed* `MaxStreamsPerConn`
(this is us choosing to shard for our own consumer throughput, not
something either exchange requires — verified via each exchange's real
documented connection limits before picking a number, 2026-07-19):
- **Bybit: `MaxStreamsPerConn = 100`** → `shardSize=11`, `shardCount≈19`
  (same order as KuCoin, deliberately — targets a similar per-connection
  message rate). Bybit's real limits are generous enough that 19
  connections is a non-issue: up to 1000 market-data connections per IP,
  no more than 500 new connections per 5-minute window.
- **OKX: `MaxStreamsPerConn = 500`** → `shardSize=50`, `shardCount≈4`.
  Kept smaller than bybit's fix on purpose: OKX's real, documented
  constraint is 3 new-connection-establishments/second per IP (a startup
  burst of 19 shards would risk tripping that; 4 comfortably won't). Any
  transiently-rejected dial still self-heals via `Manager`'s existing
  jittered backoff — same resilience stance every feed already has. The
  existing 4096-byte/message + 3-req/s *subscribe*-rate handling
  (`subscribeBatches`/`subscribeAll`, per-connection, verified 2026-07-17)
  is unaffected — smaller shards mean smaller SUBSCRIBE payloads too.
- Bybit's buffer also bumped 256→1024, matching OKX's existing 2026-07-18
  precedent, as defense-in-depth alongside the sharding fix (not a
  replacement for it).

**Also added, diagnostic-only, not a fix:** the Binance 1008 close
(`websocket: close 1008 (policy violation): Invalid request`) recurred on
today's run despite the 2026-07-17 `/market`/`/public` routing split, which
is confirmed byte-for-byte present and correct against Binance's real docs
(verified again 2026-07-19 — base URLs, routing rules, the "unrouted
connections only get Public data" behavior all match). Root cause not yet
found: two live leads researched but not confirmed — Binance's separate
"5 incoming messages/sec including subscribe commands" cap (our SUBSCRIBE
is one message, so this seems unlikely but isn't ruled out) and whether the
new routed `/market/ws`/`/public/ws` base still supports the classic
"dial bare, then SUBSCRIBE via message" pattern the same way the legacy
endpoint did (docs suggest yes, but not confirmed against this exact
combination). Can't reproduce from this sandbox — no outbound access to
Binance's real endpoints. Added `f.log.Info("subscribing", "symbols",
"params", ...)` right before the SUBSCRIBE write in both `WSFeed.Connect`
and `DepthFeed.Connect` (ws.go/depth.go) so the next live run gives
forensic detail correlatable with whatever close error follows, instead of
just the generic close reason. **Still open — flagged to John, not
guess-fixed.**

**Binance — 1008 root-caused + fixed (2026-07-22).** The diagnostic logging
above paid off. On a clean ~2-minute live run all eight venues reconciled and
`binance.ws.depth` connected fine at `params:96`, while `binance.ws` looped
forever on `1008 (policy violation): Invalid request` at `params:832`
(~100 symbols × 8 streams). Re-verified against Binance's live USDⓈ-M docs:
routing is correct (`aggTrade`/`markPrice`/`kline` all belong to `/market`,
`depth` to `/public` — our split matches the published Endpoint & Stream
Mapping), stream names are all well-formed, and 832 is comfortably under the
documented **1024 streams/connection** cap. The one variable that differs
between the failing feed and the working one is the **size of the single
SUBSCRIBE frame**: the 1024 limit is *cumulative across frames*, not a
per-frame limit, and Binance's gateway rejects one oversized SUBSCRIBE with a
1008 close even when the total is legal. The DepthFeed's single 96-param frame
on the same server family is the control that proves ≤96 params/frame is
known-good. (The earlier "5/sec incoming" lead was a red herring — we send one
message, and the discriminator is size, not rate.) Fixed by sending WSFeed's
subscription as **several small paced SUBSCRIBE frames** instead of one:
`chunkParams` (decode.go) splits the stream list into batches of
`maxParamsPerSubscribe` (80, under the proven-good 96), and
`WSFeed.subscribeChunked` (ws.go) writes each as its own SUBSCRIBE spaced by
`subscribeSpacing` (120 ms → ~8 frames/sec, under Binance's 10-msg/sec
incoming limit); Connect and Resync share the path. The diagnostic
`f.log.Info("subscribing", …)` now also logs `batches`. Unit-tested
(`TestChunkParams`): batches never exceed the cap, lose nothing, preserve
order, and the cap is asserted ≤96. **Note the correction to the 2026-07-19
entry above:** the recurring 1008 was never the routing split failing — that
split was correct all along — nor a shard-count problem (832 < 1024). It was
the oversized single subscribe frame, which no amount of correct routing or
legal total-stream budgeting addresses. `go build`/`go vet`/`go test ./...`
clean in the sandbox (Go 1.26). **Live-confirmed 2026-07-23: John reported
`binance.ws` now connects with no 1008 after the chunk fix.** The chunked/paced
SUBSCRIBE is the confirmed fix for the recurring Binance 1008.

Verified: `go build`/`go vet`/`gofmt -l` clean, `go test ./... -race
-count=1` green across every package (the one pre-existing flaky test,
`internal/supervisor`'s `TestReconcileStartsStopsRestarts`, is unchanged —
still ~50% flaky under `-race`, unrelated to any of today's changes per
`supervisor_test.go`'s own fake-venue test harness, which doesn't read
bybit/OKX's real adapter limits). Not yet re-verified on a real live run.

## P1.5e — venue 24h ticker (the "few coins / no Binance" root cause)

**Symptom (John, 2026-07-25):** the Screener showed ~35 rows, almost all
KuCoin, no Binance at all, with absurd `VOLUME 24H` figures (43, 106, 222,520)
and a blank `24H %` on most rows.

**Root cause — not a feed bug.** `instrument_state.volume_24h` and `change_24h`
were derived *exclusively* from **our own recorded candles**
(`Aggregator.recomputeOne` → `Postgres.Volume24h`, which sums 1h candles over
the last 24h), and `OnCandle` persists a bucket **only once it's `Final`**. So a
freshly started process has no 1h candle for a full hour, leaving both columns
`NULL` for every symbol. The screener's default `volume_24h > 0` filter can
never match `NULL` (nulls-never-match is deliberate — see docs/screener.md), so
nearly every symbol was filtered out *server-side*. Binance rows were dropped
before `consolidateByVenuePreference` ever ran, which is why the Binance
preference appeared not to work. The handful of surviving rows showed minutes
of one venue's partial window, not real 24h volume.

**Fix:** take 24h stats from each venue's own ticker, which is correct on the
**first message** instead of after an hour of uptime.

- `norm.Ticker` / `norm.KindTicker` / `TypeTicker` (mirrored in
  `@terminal/types`' `TickerPayload` + `MdChannel`, TS being the source of
  truth). `Change24h` is a **fraction** (-0.052), matching
  `instrument_state.change_*`; venues publishing a percent divide by 100 in
  their decoder (`pctToFraction`).
- `Aggregator.OnTicker` sets `price`/`volume_24h`/`change_24h`, preferring
  **quote volume** (USDT) over base volume so a volume sort stays comparable
  across symbols at wildly different price levels.
- `InstrumentState.venueVolume24h` / `venueChange24h` are **in-memory-only**
  flags (never columns, never persisted) telling `recomputeOne` not to
  overwrite an authoritative venue figure with a candle-derived one. Without
  the guard a recompute would blank `volume_24h` again and re-hide the symbol.
  Venues with no ticker still use the candle path unchanged.
- `exchange.VenueFeeder` is a new **optional** Adapter extension for feeds that
  are venue-wide singletons rather than per-shard. The all-market ticker
  already covers every symbol, so routing it through `Feeds()` would open one
  duplicate connection per shard; the supervisor starts `VenueFeeds()` exactly
  once per venue, under the venue context, unaffected by shard churn. Adapters
  that don't implement it are untouched (plain type assertion).

**Per-venue status:**

| Venue | Source | Status |
| --- | --- | --- |
| binance | `!ticker@arr` all-market stream, 1 stream total, venue-wide singleton (`TickerFeed`, ticker.go) | **done** |
| bybit | the `tickers.{sym}` topic we *already* subscribed — `volume24h`/`turnover24h`/`price24hPcnt` were being decoded and discarded; `price24hPcnt` is already a fraction, so no /100 | **done** |
| okx, kucoin, mexc, bingx, hyperliquid, aster | — | **not yet wired** |

The remaining six each need their own wire-format verification (several have no
all-market ws ticker and would want a REST 24h-tickers poller instead, like the
existing OI pollers). Deliberately left for a follow-up rather than guessed at —
CLAUDE.md's "every third-party feed is assumed unreliable" cuts both ways.
Until then those venues keep the candle-derived path, so their `volume_24h`
still fills in slowly. Binance carries the bulk of the universe and wins
`consolidateByVenuePreference` outright, so the user-visible effect is large.

Verified in sandbox (Go 1.26): `go build`/`go vet`/`gofmt -l` clean, `go test
./...` green across every package; `@terminal/types` + `@terminal/i18n` 72/72.
Binance decoder tests cover the array frame, the subscribe-ack (object) frame,
malformed entries, and percent→fraction.

**Live run 2026-07-26 — partly working, one real bug fixed, one open.** Volumes,
24h % and OI all came through correctly for Bybit (BTC at $1.38B 24h volume,
real percentages, populated OI), confirming the ticker path works end to end.
Two findings:

- **Binance kline decode bug, FIXED.** The log filled with `decode kline: json:
  cannot unmarshal number into Go struct field .k.l of type string` — Binance
  quotes OHLCV for most symbols but pushes a **bare JSON number** for some, and
  a single unquoted field failed the whole message, discarding every candle for
  that symbol. Fixed with the same `flexStr` string-or-number type
  `mexc/decode.go` already needed (kept as exact digits, never via float64).
  Applied to `tickerMsg` too as insurance: one `!ticker@arr` frame carries the
  entire venue, so one unquoted field there would cost the whole universe
  rather than one coin.
- **Binance rows still absent from the screener — OPEN.** The screener showed
  only Bybit. The generic feed logs can't distinguish "ticker feed never
  connected" from "connected but every message dropped downstream", so
  `TickerFeed` now logs its first frame (and every 300th) with the symbol count
  plus queue depth/capacity, and rate-limits a distinct
  `dropped ticker; consumer too slow` warning. Next live run should say which.
  Leading hypotheses, unconfirmed: (a) backpressure — one frame fans out to
  thousands of messages and the 8192 buffer plus per-symbol Postgres upserts may
  not keep up; (b) the feed isn't connecting at all. Not guess-fixed.

**Binance JSON case-folding collision — FIXED 2026-07-26 (second live run).**
Binance rows finally appeared (the ticker feed was working all along), which
exposed a worse bug: nearly every price rendered as `1,785,263,923,377`. That's
a **millisecond timestamp**, not a price. Cause: `encoding/json` matches an
exact struct tag first and then falls back to **case-insensitive** matching, and
Binance's 24hrTicker carries both `c` (last price) and `C` (statistics close
time). With no field tagged `C`, the `C` key folded onto `Last` (tagged `c`) and
— arriving later in the object — overwrote the price. Identical collision pairs
exist for `l`/`L` (low vs last-trade-id), `q`/`Q`, `o`/`O`, `p`/`P`.

The same class of bug was silently corrupting candles: inside the kline `k`
object, `V` (taker-buy base volume) and `Q` (taker-buy quote volume) arrive
*after* `v`/`q` (the totals), so they won the fold — **every stored candle's
volume was really just the taker-buy share**, which also understated the
candle-derived `Volume24h` that the six non-ticker venues still depend on.

Fix: declare **every** key Binance sends on both `tickerMsg` and `klineMsg`,
including ones we never read, so each uppercase key gets an exact match and can
never be folded onto its lowercase twin. This is precisely the trap
`classify()`'s doc comment at the top of decode.go already warned about — worth
re-reading before adding any new Binance struct. Regression tests use Binance's
real full field set *and* real key order (the order matters — the collision only
bites because the uppercase key comes second); both were confirmed to fail
against the pre-fix struct, reproducing `last = "1785263923377"` exactly.

## P1.5f — the symbol cap is ranked by volume, not alphabetically

With prices fixed, the next live screenshot showed funding and open interest
populated for `1000pepe/ake/bank/bnb/btc/bz/cl/coti/dexe/doge/eth` and blank for
everything after — `ewy`, `hype`, `intc`, `koru`, `mu`, `nvda`, `on`, `qqq`,
`sol`, `sox`, `xag`, `xau`, `xrp`, `zec`. That cutoff is exactly mid-alphabet,
and it's the tell: `applyCap` sorted the venue's instrument list
**alphabetically** and kept the first `MAX_SYMBOLS_PER_VENUE` (200).

Only capped symbols get the per-symbol feeds — funding rides `markPrice` on
`WSFeed`, open interest comes from the REST poller — while the all-market ticker
(P1.5e) covers *every* symbol. So price/volume/24h% were universe-wide but
funding/OI were reserved for whichever 200 coins happened to sort first:
`akeusdt` in, `xrpusdt` out.

Fixed by ranking before capping:

- `exchange.VolumeRanker` — a new **optional** adapter extension.
  `RankByVolume(ctx, symbols)` returns the list reordered most-important-first.
  Implemented for Binance over `GET /fapi/v1/ticker/24hr` (one request, weight
  40, every symbol's 24h quote volume), parsed as `decimal` — never float64.
- `applyCap` no longer sorts. It now keeps the first N **in the order given**,
  and the caller owns the ordering; it used to sort internally, which would have
  silently discarded any ranking passed to it. `sortedByName` is the
  deterministic default for venues without a ranker.
- Ranking failure is non-fatal — the supervisor logs and falls back to
  alphabetical, which is still deterministic and so doesn't churn the universe.
  Unranked symbols are appended, never dropped: ranking is a preference, not a
  filter.

Venues without a `VolumeRanker` keep the alphabetical cap; only Binance
implements it so far, same staged rollout as the ticker feed.

## Grows at

P1.6 (screener reads `instrument_state`), P1.7b (best-price correlates venues
via `Adapter.WireSymbol`/`ProvidedKinds`; also wants KuCoin's contract→base
qty normalization), P1.8 (charts read `candles`), P1.12 (alert engine reads
`md.*`), P1.5c (connection sharding reads `Adapter.Limits()`; runtime
lifecycle over the full universe), P2.1 (real order-book aggregation may want
the OKX checksum this doc scoped out, and could revisit per-symbol book Feed
granularity at higher venue counts), P2.2 (cross-venue spreads over the same
adapter seam).
