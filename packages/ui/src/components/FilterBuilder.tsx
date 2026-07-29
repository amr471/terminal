'use client';

/**
 * Screener filter-tree editor (P1.7 UI, CLAUDE.md §6.1: "custom filter
 * builder... combinable with AND/OR groups"). Presentational and controlled
 * — `root`/`onChange` mirror ResizableColumns' own `definition`/`onChange`
 * pair. Every edit calls `onChange` synchronously via filterTree.ts's pure ops
 * (which take the *whole* root plus a path), so the true root is threaded down
 * through every nested editor as an explicit prop rather than each editor
 * trying to reconstruct "the current full definition" from just its own
 * subtree.
 *
 * ONE deliberate exception to "no local state": UnitInput keeps an uncommitted
 * draft string while the user types, because percent fields are stored as
 * fractions and converting on every keystroke would rewrite the box mid-type.
 * The draft is display-only and never escapes the input — the committed value
 * still flows through `onChange` exactly like every other edit.
 *
 * Every label is a caller-supplied, already-`t()`-resolved string or lookup
 * function — same convention CommandBar/TabBar/ResizableColumns already
 * established (packages/ui never imports @terminal/i18n's `t` itself).
 */
import { useState } from 'react';
import {
  EXCHANGES,
  SCREENER_FIELDS,
  CATEGORICAL_FIELDS,
  SCREENER_FIELD_UNITS,
  filterInputToDec,
  decToFilterInput,
} from '@terminal/types';
import type {
  CategoricalCondition,
  CategoricalField,
  FilterGroup,
  FilterNode,
  NumericCondition,
  NumericOp,
  ScreenerField,
} from '@terminal/types';
import {
  addChild,
  defaultCategoricalCondition,
  defaultGroup,
  defaultNumericCondition,
  removeNode,
  setGroupLogic,
  updateCondition,
  type NodePath,
} from '../filterTree.js';

const ASSET_CLASSES = ['crypto', 'stock'] as const;
const NUMERIC_OPS: readonly NumericOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between'];

export interface FilterBuilderProps {
  root: FilterGroup;
  onChange: (next: FilterGroup) => void;
  fieldLabel: (field: ScreenerField) => string;
  categoricalFieldLabel: (field: CategoricalField) => string;
  numericOpLabel: (op: NumericOp) => string;
  categoricalOpLabel: (op: 'in' | 'not_in') => string;
  andLabel: string;
  orLabel: string;
  addFilterLabel: string;
  addGroupLabel: string;
  removeLabel: string;
  /** Validation errors (validateFilterNode) surfaced by the caller, e.g. once
   * the budget is hit — this component doesn't enforce the budget itself. */
  errors?: string[];
}

export function FilterBuilder({ root, onChange, errors = [], ...shared }: FilterBuilderProps) {
  return (
    <div className="t-filter">
      <GroupEditor group={root} path={[]} isRoot root={root} onChange={onChange} {...shared} />
      {errors.length > 0 && (
        <ul className="t-filter__errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SharedProps {
  /** The full definition tree — every filterTree.ts op is `(root, path, ...)`. */
  root: FilterGroup;
  onChange: (next: FilterGroup) => void;
  fieldLabel: (field: ScreenerField) => string;
  categoricalFieldLabel: (field: CategoricalField) => string;
  numericOpLabel: (op: NumericOp) => string;
  categoricalOpLabel: (op: 'in' | 'not_in') => string;
  andLabel: string;
  orLabel: string;
  addFilterLabel: string;
  addGroupLabel: string;
  removeLabel: string;
}

function GroupEditor({
  group,
  path,
  isRoot = false,
  root,
  onChange,
  ...shared
}: SharedProps & { group: FilterGroup; path: NodePath; isRoot?: boolean }) {
  const { andLabel, orLabel, addFilterLabel, addGroupLabel, removeLabel } = shared;

  return (
    <div className={`t-filter__group${isRoot ? ' t-filter__group--root' : ''}`}>
      <div className="t-filter__group-header">
        <div className="t-filter__logic" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={group.logic === 'and'}
            className={`t-filter__logic-btn${group.logic === 'and' ? ' t-filter__logic-btn--active' : ''}`}
            onClick={() => onChange(setGroupLogic(root, path, 'and'))}
          >
            {andLabel}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={group.logic === 'or'}
            className={`t-filter__logic-btn${group.logic === 'or' ? ' t-filter__logic-btn--active' : ''}`}
            onClick={() => onChange(setGroupLogic(root, path, 'or'))}
          >
            {orLabel}
          </button>
        </div>
        {!isRoot && (
          <button
            type="button"
            className="t-filter__remove"
            aria-label={removeLabel}
            onClick={() => onChange(removeNode(root, path))}
          >
            ×
          </button>
        )}
      </div>

      <div className="t-filter__children">
        {group.children.map((child, index) => (
          <NodeEditor
            key={index}
            node={child}
            path={[...path, index]}
            root={root}
            onChange={onChange}
            {...shared}
          />
        ))}
      </div>

      <div className="t-filter__group-actions">
        <button
          type="button"
          className="t-filter__add"
          onClick={() => onChange(addChild(root, path, defaultNumericCondition('volume_24h')))}
        >
          + {addFilterLabel}
        </button>
        <button
          type="button"
          className="t-filter__add"
          onClick={() =>
            onChange(addChild(root, path, defaultGroup(group.logic === 'and' ? 'or' : 'and')))
          }
        >
          + {addGroupLabel}
        </button>
      </div>
    </div>
  );
}

function NodeEditor({
  node,
  path,
  root,
  onChange,
  ...shared
}: SharedProps & { node: FilterNode; path: NodePath }) {
  if (node.kind === 'group') {
    return <GroupEditor group={node} path={path} root={root} onChange={onChange} {...shared} />;
  }
  if (node.kind === 'numeric') {
    return (
      <NumericEditor condition={node} path={path} root={root} onChange={onChange} {...shared} />
    );
  }
  return (
    <CategoricalEditor condition={node} path={path} root={root} onChange={onChange} {...shared} />
  );
}

function NumericEditor({
  condition,
  path,
  root,
  onChange,
  fieldLabel,
  numericOpLabel,
  removeLabel,
}: SharedProps & { condition: NumericCondition; path: NodePath }) {
  const isBetween = condition.op === 'between';
  const [low, high] = isBetween ? (condition.value as [string, string]) : ['', ''];
  const unit = SCREENER_FIELD_UNITS[condition.field];

  return (
    <div className="t-filter__condition">
      <select
        className="t-filter__select"
        value={condition.field}
        onChange={(e) =>
          onChange(updateCondition(root, path, { field: e.target.value as ScreenerField }))
        }
      >
        {SCREENER_FIELDS.map((f) => (
          <option key={f} value={f}>
            {fieldLabel(f)}
          </option>
        ))}
      </select>
      <select
        className="t-filter__select"
        value={condition.op}
        onChange={(e) => {
          const op = e.target.value as NumericOp;
          onChange(
            updateCondition(root, path, {
              op,
              value:
                op === 'between'
                  ? ['0', '0']
                  : typeof condition.value === 'string'
                    ? condition.value
                    : '0',
            }),
          );
        }}
      >
        {NUMERIC_OPS.map((op) => (
          <option key={op} value={op}>
            {numericOpLabel(op)}
          </option>
        ))}
      </select>
      {isBetween ? (
        <>
          <UnitInput
            unit={unit}
            value={low}
            onCommit={(v) => onChange(updateCondition(root, path, { value: [v, high] }))}
          />
          <UnitInput
            unit={unit}
            value={high}
            onCommit={(v) => onChange(updateCondition(root, path, { value: [low, v] }))}
          />
        </>
      ) : (
        <UnitInput
          unit={unit}
          value={typeof condition.value === 'string' ? condition.value : ''}
          onCommit={(v) => onChange(updateCondition(root, path, { value: v }))}
        />
      )}
      <button
        type="button"
        className="t-filter__remove"
        aria-label={removeLabel}
        onClick={() => onChange(removeNode(root, path))}
      >
        ×
      </button>
    </div>
  );
}

/**
 * A numeric filter value typed in the field's own unit.
 *
 * Percent fields are STORED as fractions (0.10 = 10%), so a raw text input let
 * a trader type "10" for 10% and silently get 1000% — a filter matching
 * nothing, with nothing on screen to explain it. This edits a local draft in
 * display units and commits the converted Dec on blur or Enter; converting on
 * every keystroke would fight the user mid-type ("10" passing through "1").
 *
 * An unparseable draft is simply not committed — the last good value stands,
 * rather than writing junk into the definition.
 */
function UnitInput({
  unit,
  value,
  onCommit,
}: {
  unit: 'percent' | 'money' | 'plain';
  value: string;
  onCommit: (next: string) => void;
}) {
  const display = value === '' ? '' : decToFilterInput(value, unit);
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    if (draft === null) return;
    const next = filterInputToDec(draft, unit);
    setDraft(null);
    if (next !== null && next !== value) onCommit(next);
  };

  return (
    <span className="t-filter__value-wrap">
      <input
        className="t-filter__value t-num"
        inputMode="decimal"
        // Shows the shape the field expects, so the unit is discoverable
        // without a legend: "%" for fractions, "100M" for money.
        placeholder={unit === 'percent' ? '%' : unit === 'money' ? '100M' : ''}
        value={draft ?? display}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      {unit === 'percent' && <span className="t-filter__unit">%</span>}
    </span>
  );
}

const CATEGORICAL_OPTIONS: Record<CategoricalField, readonly string[]> = {
  exchange: EXCHANGES,
  asset_class: ASSET_CLASSES,
};

function CategoricalEditor({
  condition,
  path,
  root,
  onChange,
  categoricalFieldLabel,
  categoricalOpLabel,
  removeLabel,
}: SharedProps & { condition: CategoricalCondition; path: NodePath }) {
  return (
    <div className="t-filter__condition">
      <select
        className="t-filter__select"
        value={condition.field}
        onChange={(e) => {
          const field = e.target.value as CategoricalField;
          onChange(updateCondition(root, path, { field, values: [] }));
        }}
      >
        {CATEGORICAL_FIELDS.map((f) => (
          <option key={f} value={f}>
            {categoricalFieldLabel(f)}
          </option>
        ))}
      </select>
      <select
        className="t-filter__select"
        value={condition.op}
        onChange={(e) =>
          onChange(updateCondition(root, path, { op: e.target.value as 'in' | 'not_in' }))
        }
      >
        <option value="in">{categoricalOpLabel('in')}</option>
        <option value="not_in">{categoricalOpLabel('not_in')}</option>
      </select>
      <select
        className="t-filter__select t-filter__select--multi"
        multiple
        value={[...condition.values]}
        onChange={(e) =>
          onChange(
            updateCondition(root, path, {
              values: Array.from(e.target.selectedOptions, (o) => o.value),
            }),
          )
        }
      >
        {CATEGORICAL_OPTIONS[condition.field].map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="t-filter__remove"
        aria-label={removeLabel}
        onClick={() => onChange(removeNode(root, path))}
      >
        ×
      </button>
    </div>
  );
}

// Re-exported so ScreenerPanel can offer a starting condition of the same
// shape this builder itself uses for "+ Add filter" (avoids a second,
// possibly-drifting definition of "what a fresh condition looks like").
export { defaultCategoricalCondition, defaultNumericCondition, defaultGroup };
