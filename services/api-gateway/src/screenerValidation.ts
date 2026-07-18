/**
 * Full-definition validation for the screener (P1.6). @terminal/types'
 * validateFilterNode covers the filter tree (depth/node budgets); this adds the
 * outer ScreenDefinition envelope checks (version, sort field, limit) so every
 * definition is fully validated before it is stored or executed — especially
 * LLM-produced ones (GW-2005).
 */
import { validateFilterNode, SCREENER_FIELDS, type ScreenDefinition } from '@terminal/types';

const MAX_SCREEN_LIMIT = 1000;

export type DefinitionCheck =
  | { ok: true; definition: ScreenDefinition }
  | { ok: false; detail: string };

export function validateScreenDefinition(value: unknown): DefinitionCheck {
  if (typeof value !== 'object' || value === null) return { ok: false, detail: 'definition must be an object' };
  const d = value as Record<string, unknown>;
  if (d.version !== 1) return { ok: false, detail: 'definition.version must be 1' };

  const treeErrors = validateFilterNode(d.root);
  if (treeErrors.length > 0) return { ok: false, detail: treeErrors[0] ?? 'invalid filter' };
  // Root must be a group (a bare condition has no and/or semantics for the UI).
  if ((d.root as Record<string, unknown>).kind !== 'group')
    return { ok: false, detail: 'definition.root must be a group' };

  if (d.sort !== undefined) {
    const s = d.sort as Record<string, unknown>;
    if (!(SCREENER_FIELDS as readonly string[]).includes(s.field as string))
      return { ok: false, detail: `sort.field must be a screener field` };
    if (s.dir !== 'asc' && s.dir !== 'desc') return { ok: false, detail: 'sort.dir must be asc|desc' };
  }
  if (d.limit !== undefined) {
    if (typeof d.limit !== 'number' || !Number.isInteger(d.limit) || d.limit < 1 || d.limit > MAX_SCREEN_LIMIT)
      return { ok: false, detail: `limit must be an integer in [1, ${MAX_SCREEN_LIMIT}]` };
  }
  return { ok: true, definition: value as ScreenDefinition };
}

export function isValidScreenName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 100;
}
