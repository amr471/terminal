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

## Grows at

P1.6 (screener reads `instrument_state`), P1.7b (best-price correlates venues
via `Adapter.WireSymbol`/`ProvidedKinds`; also wants KuCoin's contract→base
qty normalization), P1.8 (charts read `candles`), P1.12 (alert engine reads
`md.*`), P1.5c (connection sharding reads `Adapter.Limits()`; runtime
lifecycle over the full universe), P2.1 (real order-book aggregation may want
the OKX checksum this doc scoped out, and could revisit per-symbol book Feed
granularity at higher venue counts), P2.2 (cross-venue spreads over the same
adapter seam).
