'use client';

/**
 * The real screener panel (P1.7 UI), replacing the placeholder text
 * TerminalWorkspace.tsx rendered for `kind === 'screener'` since P1.3.
 * Wires together: the saved-screens/presets picker (screensClient.ts,
 * services/api-gateway's `/screens` CRUD), the filter-tree editor
 * (@terminal/ui's FilterBuilder), the live virtualized table
 * (@terminal/ui's ScreenerTable, fed by useScreenerSubscription's WS
 * snapshot/delta stream), column visibility (persisted to `localStorage`,
 * same per-browser-preference scope call P1.4a's SecondaryClock made — see
 * docs/screener-ui.md), and CSV export.
 *
 * Scope call: the live subscription always sends an inline `definition`,
 * never `{screenId}` — every saved screen's definition is already in hand
 * from the `/screens` list, so subscribing by value means a sort-header
 * click (which needs to patch just `.sort`) never has to first "expand" a
 * screenId-based subscription into an editable definition. The `{screenId}`
 * variant the gateway also accepts (docs/screener.md) stays available for a
 * future caller that doesn't already hold the definition (Telegram mini-app?).
 *
 * Scope call: filter-tree edits (FilterBuilder) are staged in `pendingRoot`
 * and only take effect on "Apply" — re-subscribing on every keystroke would
 * replace the WS subscription (and re-send a full snapshot) per character
 * typed into a value box. Sort-header clicks bypass that gate and apply
 * immediately, matching a spreadsheet/Bloomberg-terminal expectation that
 * clicking a column header re-sorts right away.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EXCHANGES,
  consolidateByVenuePreference,
  isStockToken,
  validateFilterNode,
  type CategoricalField,
  type FilterGroup,
  type Locale,
  type NumericOp,
  type ScreenDefinition,
  type ScreenerRow,
  type ScreenerSortField,
} from '@terminal/types';
import {
  ALL_SCREENER_COLUMNS,
  DEFAULT_VISIBLE_COLUMNS,
  FilterBuilder,
  HealthBadge,
  ScreenerTable,
  defaultGroup,
  toggleColumn,
  type ScreenerColumnId,
} from '@terminal/ui';
import { t, type MessageKey } from '@terminal/i18n';
import { useScreenerSubscription } from '../lib/useScreenerSubscription';
import {
  createScreen,
  deleteScreen,
  listScreens,
  updateScreen,
  type SavedScreen,
} from '../lib/screensClient';
import { screenerExportFilename, screenerRowsToCsv } from '../lib/screenerExport';

const COLUMNS_STORAGE_KEY = 'terminal.screener.columns';

/** Venue-priority order (2026-07-26 request: "I want the user to select the
 * priority of the exchanges from which prices and values are displayed").
 * Per-browser like the column config — same scope call, not a server-side
 * ScreenDefinition concern, since this only decides which of the already-
 * fetched rows to DISPLAY per symbol. */
const VENUE_PRIORITY_STORAGE_KEY = 'terminal.screener.venuePriority';

/** Last screen the user had selected, restored on arrival (2026-07-26). Stores
 * only the id — the definition itself always comes fresh from the gateway, so a
 * preset that changes server-side is picked up rather than frozen per browser. */
const LAST_SCREEN_STORAGE_KEY = 'terminal.screener.lastScreenId';

function rememberScreen(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(LAST_SCREEN_STORAGE_KEY, id);
    else window.localStorage.removeItem(LAST_SCREEN_STORAGE_KEY);
  } catch {
    // Storage full/unavailable — restoring on next visit just won't happen.
  }
}

/** Reorders `list` by moving the item at `from` to index `to`, clamped.
 * Pure so the ordering rule is unit-testable away from React. */
export function moveVenue(list: readonly string[], from: number, to: number): string[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  if (item === undefined) return out;
  out.splice(target, 0, item);
  return out;
}

/** Repairs a stored order against the current EXCHANGES list: keeps the user's
 * sequence, drops venues that no longer exist, and appends any newly added
 * venue at the end rather than silently omitting it. */
export function reconcileVenuePriority(stored: readonly unknown[]): string[] {
  const known = new Set<string>(EXCHANGES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of stored) {
    if (typeof v === 'string' && known.has(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (const v of EXCHANGES) if (!seen.has(v)) out.push(v);
  return out;
}

function defaultDefinition(): ScreenDefinition {
  return { version: 1, root: defaultGroup(), sort: { field: 'volume_24h', dir: 'desc' } };
}

/** ANDs an `exchange in [exchange]` leaf onto `root` as a sibling of the
 * whole existing tree (wrapped, not merged into root's own children) — this
 * composes correctly regardless of whether root's own top-level logic is
 * AND or OR, since the exchange constraint always applies on top of
 * whatever the user already built, never inside it. Used only to build the
 * definition sent to the live subscription; the user's own `pendingRoot`/
 * `definition` (and FilterBuilder) are never touched by this, so switching
 * the quick-pick exchange never marks the screen dirty or affects Save. */
function withExchangeFilter(root: FilterGroup, exchange: string): FilterGroup {
  return {
    kind: 'group',
    logic: 'and',
    children: [root, { kind: 'categorical', field: 'exchange', op: 'in', values: [exchange] }],
  };
}

const COLUMN_LABEL_KEY: Record<ScreenerColumnId, MessageKey> = {
  symbol: 'screener.column.symbol',
  exchange: 'screener.field.exchange',
  price: 'screener.field.price',
  change_1h: 'screener.field.change_1h',
  change_24h: 'screener.field.change_24h',
  change_7d: 'screener.field.change_7d',
  volume_24h: 'screener.field.volume_24h',
  market_cap: 'screener.field.market_cap',
  open_interest: 'screener.field.open_interest',
  funding_rate: 'screener.field.funding_rate',
  volatility_24h: 'screener.field.volatility_24h',
  spread: 'screener.field.spread',
};

const CATEGORICAL_FIELD_KEY: Record<CategoricalField, MessageKey> = {
  exchange: 'screener.field.exchange',
  asset_class: 'screener.field.asset_class',
};

const NUMERIC_OP_KEY: Record<NumericOp, MessageKey> = {
  gt: 'screener.op.gt',
  gte: 'screener.op.gte',
  lt: 'screener.op.lt',
  lte: 'screener.op.lte',
  eq: 'screener.op.eq',
  neq: 'screener.op.neq',
  between: 'screener.op.between',
};

/** Built-in preset ids (services/api-gateway/src/screens.ts) get localized
 * copy; a user's own saved screens keep their free-text name as-is. */
const PRESET_LABEL_KEY: Record<string, MessageKey> = {
  'preset:high-volume-losers': 'screener.preset.high_volume_losers',
  'preset:negative-funding': 'screener.preset.negative_funding',
  'preset:unusual-oi': 'screener.preset.unusual_oi',
};

function screenLabel(locale: Locale, screen: SavedScreen): string {
  const key = PRESET_LABEL_KEY[screen.id];
  return key ? t(locale, key) : screen.name;
}

function isValidColumnId(value: unknown): value is ScreenerColumnId {
  return typeof value === 'string' && (ALL_SCREENER_COLUMNS as readonly string[]).includes(value);
}

export interface ScreenerPanelProps {
  locale: Locale;
}

export function ScreenerPanel({ locale }: ScreenerPanelProps) {
  const [screens, setScreens] = useState<SavedScreen[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [definition, setDefinition] = useState<ScreenDefinition>(defaultDefinition);
  const [pendingRoot, setPendingRoot] = useState<FilterGroup>(() => definition.root);
  const [dirty, setDirty] = useState(false);
  const [columns, setColumns] = useState<ScreenerColumnId[]>(() => [...DEFAULT_VISIBLE_COLUMNS]);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  /** User-chosen venue priority (2026-07-26). Index 0 wins outright for any
   * symbol it lists; the rest is the tie-break order behind the highest-volume
   * rule. Defaults to EXCHANGES (Binance first) — the previous hardcoded
   * behavior, so an untouched install is unchanged. */
  const [venuePriority, setVenuePriority] = useState<string[]>(() => [...EXCHANGES]);
  const [showVenuePriority, setShowVenuePriority] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  /** Quick-pick "show all coins on this exchange" (2026-07-17 request) — a
   * separate, additive constraint layered on top of the actual filter tree,
   * not a value inside it. '' means no constraint (every venue). */
  const [exchangeFilter, setExchangeFilter] = useState('');
  /** Coins-vs-stocks quick filter (2026-07-19 request) — a client-side
   * `isStockToken` heuristic, not a server-side filter-tree constraint,
   * since `asset_class` is still hardcoded "crypto" everywhere server-side
   * (see isStockToken's doc comment, @terminal/types). '' = no filter. */
  const [assetClassFilter, setAssetClassFilter] = useState<'' | 'coin' | 'stock'>('');
  const initializedRef = useRef(false);

  /** Built-in presets only — user-saved screens stay in the dropdown so the
   * chip row stays a bounded, glanceable set. */
  const presetScreens = useMemo(() => screens.filter((s) => s.isPreset), [screens]);

  const effectiveDefinition = useMemo<ScreenDefinition>(
    () =>
      exchangeFilter
        ? { ...definition, root: withExchangeFilter(definition.root, exchangeFilter) }
        : definition,
    [definition, exchangeFilter],
  );
  const { rows, status } = useScreenerSubscription({ definition: effectiveDefinition });
  const errors = useMemo(() => validateFilterNode(pendingRoot), [pendingRoot]);

  /** What's actually shown/exported/counted — 2026-07-19: one row per
   * symbol, Binance preferred (falls back to whichever other venue lists
   * it), plus the coins-vs-stocks quick filter. `rows` itself (the raw
   * per-(exchange,symbol) subscription output) is untouched — the
   * underlying Screener data model stays the discovery-use-case one row
   * per pair (docs/screener.md); this is a display-layer transform only,
   * so it never affects what's stored in a saved screen's definition.
   * Filter before consolidate: cheaper (smaller set to dedupe), and order
   * doesn't change the result either way since the two operations are
   * independent (consolidateByVenuePreference preserves relative order). */
  const displayRows = useMemo<ScreenerRow[]>(() => {
    const filtered =
      assetClassFilter === ''
        ? rows
        : rows.filter((r) => isStockToken(r.symbol) === (assetClassFilter === 'stock'));
    return consolidateByVenuePreference(filtered, venuePriority);
  }, [rows, assetClassFilter, venuePriority]);

  // Load saved screens + presets once, then restore the screen the user had
  // open last (2026-07-26 request: "when a person visits the site, they
  // immediately get to the new filter" — resolved as: land on the screen you
  // were last using, with the editor already open and editable). Falls back to
  // the first preset when there's no remembered screen or it no longer exists
  // (deleted, or a preset id that changed), so first paint is never the
  // trivial "volume > 0" default. Never clobbers a faster user action
  // (New/manual select), guarded by initializedRef.
  useEffect(() => {
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(LAST_SCREEN_STORAGE_KEY);
    } catch {
      // Storage unavailable — fall through to the first preset.
    }
    listScreens()
      .then((list) => {
        setScreens(list);
        const restored = remembered ? list.find((s) => s.id === remembered) : undefined;
        const target = restored ?? list[0];
        if (!initializedRef.current && target) {
          initializedRef.current = true;
          setSelectedId(target.id);
          setDefinition(target.definition);
          setPendingRoot(target.definition.root);
        }
      })
      .catch(() => {
        // No saved screens available (offline, or the gateway isn't up yet)
        // — the trivial default definition still renders a live, if broad,
        // screen. Nothing further to surface here.
      });
  }, []);

  // Column visibility (P1.7 UI, CLAUDE.md §6.1 "column config") persists
  // per-browser, same localStorage scope call P1.4a's secondary clock made
  // (docs/terminal-shell.md) — read lazily so first client render matches
  // the server-rendered shell before localStorage is consulted.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
      if (!stored) return;
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isValidColumnId)) {
        setColumns(parsed);
      }
    } catch {
      // Corrupt or unavailable storage — the in-memory default stands.
    }
  }, []);

  function persistColumns(next: ScreenerColumnId[]): void {
    setColumns(next);
    try {
      window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full/unavailable — still updates for this session.
    }
  }

  // Venue priority, same lazy-read + per-browser persistence as the columns
  // above. Reconciled against EXCHANGES so a venue added or removed since the
  // order was saved doesn't corrupt it (see reconcileVenuePriority).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VENUE_PRIORITY_STORAGE_KEY);
      if (!stored) return;
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) setVenuePriority(reconcileVenuePriority(parsed));
    } catch {
      // Corrupt or unavailable storage — the EXCHANGES default stands.
    }
  }, []);

  function persistVenuePriority(next: string[]): void {
    setVenuePriority(next);
    try {
      window.localStorage.setItem(VENUE_PRIORITY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full/unavailable — still updates for this session.
    }
  }

  function handleNew(): void {
    initializedRef.current = true;
    const fresh = defaultDefinition();
    setSelectedId(null);
    rememberScreen(null); // a fresh filter is what to restore next visit
    setDefinition(fresh);
    setPendingRoot(fresh.root);
    setDirty(false);
  }

  function selectScreen(id: string): void {
    if (!id) {
      handleNew();
      return;
    }
    const screen = screens.find((s) => s.id === id);
    if (!screen) return;
    initializedRef.current = true;
    setSelectedId(id);
    rememberScreen(id);
    setDefinition(screen.definition);
    setPendingRoot(screen.definition.root);
    setDirty(false);
  }

  function handleApply(): void {
    if (errors.length > 0) return;
    setDefinition((prev) => ({ ...prev, root: pendingRoot }));
    setDirty(false);
  }

  function handleSort(field: ScreenerSortField): void {
    setDefinition((prev) => ({
      ...prev,
      sort: { field, dir: prev.sort?.field === field && prev.sort.dir === 'desc' ? 'asc' : 'desc' },
    }));
  }

  const selectedScreen = screens.find((s) => s.id === selectedId) ?? null;
  const canOverwrite = !!selectedScreen && !selectedScreen.isPreset;

  async function handleSave(): Promise<void> {
    if (errors.length > 0) return;
    if (canOverwrite && selectedScreen) {
      const updated = await updateScreen(selectedScreen.id, {
        definition: { ...definition, root: pendingRoot },
      });
      setScreens((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setDefinition(updated.definition);
      setPendingRoot(updated.definition.root);
      setDirty(false);
      return;
    }
    setSaveAsName('');
    setSaveAsOpen(true);
  }

  async function confirmSaveAs(): Promise<void> {
    const name = saveAsName.trim();
    if (!name) return;
    const created = await createScreen(name, { ...definition, root: pendingRoot });
    setScreens((prev) => [...prev, created]);
    initializedRef.current = true;
    setSelectedId(created.id);
    rememberScreen(created.id);
    setDefinition(created.definition);
    setPendingRoot(created.definition.root);
    setDirty(false);
    setSaveAsOpen(false);
  }

  async function handleDelete(): Promise<void> {
    if (!canOverwrite || !selectedScreen) return;
    if (!window.confirm(t(locale, 'screener.delete_confirm'))) return;
    await deleteScreen(selectedScreen.id);
    setScreens((prev) => prev.filter((s) => s.id !== selectedScreen.id));
    handleNew();
  }

  function handleExport(): void {
    const csv = screenerRowsToCsv(
      displayRows,
      columns,
      (id) => t(locale, COLUMN_LABEL_KEY[id]),
      t(locale, 'screener.export.watermark', { url: window.location.origin }),
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = screenerExportFilename(new Date());
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const healthState = status === 'live' ? 'LIVE' : status === 'error' ? 'DOWN' : 'DEGRADED';
  const healthLabel =
    status === 'live'
      ? t(locale, 'screener.status.live')
      : status === 'error'
        ? t(locale, 'data.feed_down')
        : t(locale, 'data.loading');

  return (
    <div className="t-screener">
      <div className="t-screener__toolbar">
        <select
          className="t-screener__picker"
          aria-label={t(locale, 'screener.my_screens_label')}
          value={selectedId ?? ''}
          onChange={(e) => selectScreen(e.target.value)}
        >
          <option value="">{t(locale, 'screener.new_screen')}</option>
          {screens.map((s) => (
            <option key={s.id} value={s.id}>
              {screenLabel(locale, s)}
            </option>
          ))}
        </select>
        <select
          className="t-screener__picker"
          aria-label={t(locale, 'screener.field.exchange')}
          value={exchangeFilter}
          onChange={(e) => setExchangeFilter(e.target.value)}
        >
          <option value="">{t(locale, 'screener.exchange_filter.all')}</option>
          {EXCHANGES.map((ex) => (
            <option key={ex} value={ex}>
              {ex}
            </option>
          ))}
        </select>
        <select
          className="t-screener__picker"
          aria-label={t(locale, 'screener.asset_class_filter.label')}
          value={assetClassFilter}
          onChange={(e) => setAssetClassFilter(e.target.value as '' | 'coin' | 'stock')}
        >
          <option value="">{t(locale, 'screener.asset_class_filter.all')}</option>
          <option value="coin">{t(locale, 'screener.asset_class_filter.coin')}</option>
          <option value="stock">{t(locale, 'screener.asset_class_filter.stock')}</option>
        </select>
        <button type="button" className="t-screener__btn" onClick={handleNew}>
          {t(locale, 'screener.new_screen')}
        </button>
        <button
          type="button"
          className="t-screener__btn"
          onClick={() => void handleSave()}
          disabled={errors.length > 0}
        >
          {canOverwrite ? t(locale, 'screener.save') : t(locale, 'screener.save_as')}
        </button>
        <button
          type="button"
          className="t-screener__btn"
          onClick={() => void handleDelete()}
          disabled={!canOverwrite}
        >
          {t(locale, 'screener.delete')}
        </button>
        <button
          type="button"
          className="t-screener__btn"
          onClick={handleExport}
          disabled={displayRows.length === 0}
        >
          {t(locale, 'screener.export')}
        </button>
        <button
          type="button"
          className="t-screener__btn"
          onClick={() => setShowColumnPicker((v) => !v)}
        >
          {t(locale, 'screener.columns_config')}
        </button>
        <button
          type="button"
          className="t-screener__btn"
          onClick={() => setShowVenuePriority((v) => !v)}
        >
          {t(locale, 'screener.venue_priority')}
        </button>
        <HealthBadge state={healthState} label={healthLabel} />
      </div>

      {showColumnPicker && (
        <div
          className="t-screener__columns-picker"
          role="group"
          aria-label={t(locale, 'screener.columns_config_label')}
        >
          {ALL_SCREENER_COLUMNS.map((id) => (
            <label key={id} className="t-screener__column-toggle">
              <input
                type="checkbox"
                checked={columns.includes(id)}
                onChange={() => persistColumns(toggleColumn(columns, id))}
              />
              {t(locale, COLUMN_LABEL_KEY[id])}
            </label>
          ))}
        </div>
      )}

      {/* One-click presets (2026-07-26). Presets were only reachable through
          the screens dropdown; as chips they're a single click, which is the
          point of a preset. User-saved screens stay in the dropdown — mixing
          them in here would make the row unbounded. */}
      {presetScreens.length > 0 && (
        <div
          className="t-screener__presets"
          role="group"
          aria-label={t(locale, 'screener.presets_label')}
        >
          {presetScreens.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`t-screener__preset-chip${selectedId === p.id ? ' is-active' : ''}`}
              aria-pressed={selectedId === p.id}
              onClick={() => selectScreen(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {showVenuePriority && (
        <div
          className="t-screener__venue-priority"
          role="group"
          aria-label={t(locale, 'screener.venue_priority_label')}
        >
          <p className="t-screener__venue-priority-hint">
            {t(locale, 'screener.venue_priority_hint')}
          </p>
          <ol className="t-screener__venue-list">
            {venuePriority.map((venue, i) => (
              <li key={venue} className="t-screener__venue-row">
                <span className="t-screener__venue-rank t-num">{i + 1}</span>
                <span className="t-screener__venue-name">{venue}</span>
                <button
                  type="button"
                  className="t-screener__btn"
                  disabled={i === 0}
                  aria-label={`${t(locale, 'screener.venue_move_up')}: ${venue}`}
                  onClick={() => persistVenuePriority(moveVenue(venuePriority, i, i - 1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="t-screener__btn"
                  disabled={i === venuePriority.length - 1}
                  aria-label={`${t(locale, 'screener.venue_move_down')}: ${venue}`}
                  onClick={() => persistVenuePriority(moveVenue(venuePriority, i, i + 1))}
                >
                  ↓
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="t-screener__btn"
            onClick={() => persistVenuePriority([...EXCHANGES])}
          >
            {t(locale, 'screener.venue_priority_reset')}
          </button>
        </div>
      )}

      {saveAsOpen && (
        <div className="t-screener__save-as">
          <input
            className="t-filter__value"
            autoFocus
            value={saveAsName}
            placeholder={t(locale, 'screener.save_as.placeholder')}
            onChange={(e) => setSaveAsName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmSaveAs();
              if (e.key === 'Escape') setSaveAsOpen(false);
            }}
          />
          <button type="button" className="t-screener__btn" onClick={() => void confirmSaveAs()}>
            {t(locale, 'screener.save_as.confirm')}
          </button>
          <button type="button" className="t-screener__btn" onClick={() => setSaveAsOpen(false)}>
            {t(locale, 'screener.save_as.cancel')}
          </button>
        </div>
      )}

      <FilterBuilder
        root={pendingRoot}
        onChange={(next) => {
          setPendingRoot(next);
          setDirty(true);
        }}
        fieldLabel={(field) => t(locale, COLUMN_LABEL_KEY[field])}
        categoricalFieldLabel={(field) => t(locale, CATEGORICAL_FIELD_KEY[field])}
        numericOpLabel={(op) => t(locale, NUMERIC_OP_KEY[op])}
        categoricalOpLabel={(op) =>
          t(locale, op === 'in' ? 'screener.op.in' : 'screener.op.not_in')
        }
        andLabel={t(locale, 'screener.filter.and')}
        orLabel={t(locale, 'screener.filter.or')}
        addFilterLabel={t(locale, 'screener.filter.add')}
        addGroupLabel={t(locale, 'screener.filter.add_group')}
        removeLabel={t(locale, 'screener.filter.remove')}
        errors={errors}
      />
      <div className="t-screener__apply-row">
        <button
          type="button"
          className="t-screener__btn t-screener__btn--primary"
          onClick={handleApply}
          disabled={!dirty || errors.length > 0}
        >
          {t(locale, 'screener.apply')}
        </button>
      </div>

      <div className="t-screener__table-wrap">
        <ScreenerTable
          rows={displayRows}
          columns={columns}
          columnLabel={(id) => t(locale, COLUMN_LABEL_KEY[id])}
          locale={locale}
          {...(definition.sort ? { sort: definition.sort } : {})}
          onSortChange={handleSort}
          emptyLabel={t(locale, 'data.empty')}
          onSymbolClick={(symbol) => {
            // Opens a real new browser tab, not a new internal workspace
            // tab (P1.3a's tab strip) — this is a lightweight, session-gated
            // detail view, not a saved layout. See docs/best-price.md.
            window.open(`/${locale}/terminal/symbol/${encodeURIComponent(symbol)}`, '_blank');
          }}
        />
      </div>
    </div>
  );
}
