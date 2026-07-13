/**
 * /layouts/tabs (P1.3a) against the real local Postgres+Redis, exercised
 * through the actual Fastify app via app.inject(). Skips gracefully when
 * the local stack isn't up — see app.test.ts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaultLayoutDefinition, type TerminalTabSummary } from '@terminal/types';
import { buildApp } from './app.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { closeSubscriber } from './pubsub.js';

async function servicesReachable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

const reachable = await servicesReachable();
if (!reachable) {
  console.warn('[layoutRoutes.test.ts] local Postgres/Redis not reachable — skipping.');
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  assert.ok(raw, 'expected a Set-Cookie header');
  const value = raw.split(';')[0];
  assert.ok(value);
  return value;
}

async function signUpAndGetCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const email = `layout-test-${randomUUID()}@example.invalid`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'a-reasonably-long-password' },
  });
  assert.equal(signup.statusCode, 201);
  return extractSessionCookie(signup.headers['set-cookie']);
}

async function getTabs(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
): Promise<TerminalTabSummary[]> {
  const res = await app.inject({ method: 'GET', url: '/layouts/tabs', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  return (JSON.parse(res.body) as { tabs: TerminalTabSummary[] }).tabs;
}

test(
  'GET /layouts/tabs without a session is rejected (GW-2002)',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/layouts/tabs' });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error.code, 'GW-2002');
    await app.close();
  },
);

test(
  'GET /layouts/tabs lazily provisions one active "Main" tab for a brand-new user',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);

    const tabs = await getTabs(app, cookie);
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0]!.title, 'Main');
    assert.equal(tabs[0]!.isActive, true);
    assert.deepEqual(tabs[0]!.definition, defaultLayoutDefinition());

    await app.close();
  },
);

test(
  'POST /layouts/tabs creates and activates a new tab, deactivating the previous one',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);
    await getTabs(app, cookie); // provisions the first ("Main") tab

    const post = await app.inject({
      method: 'POST',
      url: '/layouts/tabs',
      headers: { cookie },
      payload: { title: 'Scalping' },
    });
    assert.equal(post.statusCode, 201);
    const created = (JSON.parse(post.body) as { tab: TerminalTabSummary }).tab;
    assert.equal(created.title, 'Scalping');
    assert.equal(created.isActive, true);

    const tabs = await getTabs(app, cookie);
    assert.equal(tabs.length, 2);
    assert.equal(tabs.filter((t) => t.isActive).length, 1);
    assert.equal(tabs.find((t) => t.id === created.id)?.isActive, true);

    await app.close();
  },
);

test(
  'POST /layouts/tabs rejects a missing/blank title (GW-2008)',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);

    const missing = await app.inject({
      method: 'POST',
      url: '/layouts/tabs',
      headers: { cookie },
      payload: {},
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(JSON.parse(missing.body).error.code, 'GW-2008');

    const blank = await app.inject({
      method: 'POST',
      url: '/layouts/tabs',
      headers: { cookie },
      payload: { title: '   ' },
    });
    assert.equal(blank.statusCode, 400);
    assert.equal(JSON.parse(blank.body).error.code, 'GW-2008');

    await app.close();
  },
);

test(
  'POST /layouts/tabs rejects a malformed definition (GW-2010)',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'POST',
      url: '/layouts/tabs',
      headers: { cookie },
      payload: { title: 'Bad', definition: { version: 1, columns: [] } },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, 'GW-2010');

    await app.close();
  },
);

test(
  'PUT /layouts/tabs/:id renames the tab and/or updates its definition',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);
    const [main] = await getTabs(app, cookie);

    const renamed = await app.inject({
      method: 'PUT',
      url: `/layouts/tabs/${main!.id}`,
      headers: { cookie },
      payload: { title: 'Renamed' },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal((JSON.parse(renamed.body) as { tab: TerminalTabSummary }).tab.title, 'Renamed');

    const newDefinition = {
      version: 1 as const,
      columns: [{ size: 1, panels: [{ kind: 'news' as const, size: 1 }] }],
    };
    const redefined = await app.inject({
      method: 'PUT',
      url: `/layouts/tabs/${main!.id}`,
      headers: { cookie },
      payload: { definition: newDefinition },
    });
    assert.equal(redefined.statusCode, 200);
    const redefinedBody = JSON.parse(redefined.body) as { tab: TerminalTabSummary };
    assert.deepEqual(redefinedBody.tab.definition, newDefinition);
    assert.equal(redefinedBody.tab.title, 'Renamed'); // untouched by the definition-only PUT

    await app.close();
  },
);

test(
  'PUT /layouts/tabs/:id rejects an empty patch and a malformed definition',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);
    const [main] = await getTabs(app, cookie);

    const empty = await app.inject({
      method: 'PUT',
      url: `/layouts/tabs/${main!.id}`,
      headers: { cookie },
      payload: {},
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(JSON.parse(empty.body).error.code, 'GW-2008');

    const bad = await app.inject({
      method: 'PUT',
      url: `/layouts/tabs/${main!.id}`,
      headers: { cookie },
      payload: { definition: { version: 1, columns: [] } },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).error.code, 'GW-2010');

    await app.close();
  },
);

test(
  'PUT /layouts/tabs/:id 404s for a tab that does not exist (GW-2012)',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/layouts/tabs/${randomUUID()}`,
      headers: { cookie },
      payload: { title: 'Ghost' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error.code, 'GW-2012');

    await app.close();
  },
);

test(
  'PUT /layouts/tabs/:id/activate switches which tab is active',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);
    const [main] = await getTabs(app, cookie);
    const post = await app.inject({
      method: 'POST',
      url: '/layouts/tabs',
      headers: { cookie },
      payload: { title: 'Second' },
    });
    const second = (JSON.parse(post.body) as { tab: TerminalTabSummary }).tab; // created active

    const activate = await app.inject({
      method: 'PUT',
      url: `/layouts/tabs/${main!.id}/activate`,
      headers: { cookie },
    });
    assert.equal(activate.statusCode, 200);

    const tabs = await getTabs(app, cookie);
    assert.equal(tabs.find((t) => t.id === main!.id)?.isActive, true);
    assert.equal(tabs.find((t) => t.id === second.id)?.isActive, false);

    await app.close();
  },
);

test(
  'PUT /layouts/tabs/:id/activate 404s for an unknown tab (GW-2012)',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/layouts/tabs/${randomUUID()}/activate`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error.code, 'GW-2012');

    await app.close();
  },
);

test('PUT /layouts/tabs/reorder persists a new tab order', { skip: !reachable }, async () => {
  const app = await buildApp();
  const cookie = await signUpAndGetCookie(app);
  const [main] = await getTabs(app, cookie);
  const post = await app.inject({
    method: 'POST',
    url: '/layouts/tabs',
    headers: { cookie },
    payload: { title: 'Second' },
  });
  const second = (JSON.parse(post.body) as { tab: TerminalTabSummary }).tab;

  const reorder = await app.inject({
    method: 'PUT',
    url: '/layouts/tabs/reorder',
    headers: { cookie },
    payload: { order: [second.id, main!.id] },
  });
  assert.equal(reorder.statusCode, 200);

  const tabs = await getTabs(app, cookie);
  assert.deepEqual(
    tabs.map((t) => t.id),
    [second.id, main!.id],
  );

  await app.close();
});

test(
  'PUT /layouts/tabs/reorder rejects an order that is not exactly the user’s tab set (GW-2008)',
  {
    skip: !reachable,
  },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);
    const [main] = await getTabs(app, cookie);

    const missingOne = await app.inject({
      method: 'PUT',
      url: '/layouts/tabs/reorder',
      headers: { cookie },
      payload: { order: [] },
    });
    assert.equal(missingOne.statusCode, 400);
    assert.equal(JSON.parse(missingOne.body).error.code, 'GW-2008');

    const foreignId = await app.inject({
      method: 'PUT',
      url: '/layouts/tabs/reorder',
      headers: { cookie },
      payload: { order: [main!.id, randomUUID()] },
    });
    assert.equal(foreignId.statusCode, 400);
    assert.equal(JSON.parse(foreignId.body).error.code, 'GW-2008');

    await app.close();
  },
);

test(
  'DELETE /layouts/tabs/:id closes a tab and, if it was active, activates another',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);
    const [main] = await getTabs(app, cookie);
    const post = await app.inject({
      method: 'POST',
      url: '/layouts/tabs',
      headers: { cookie },
      payload: { title: 'Second' },
    });
    const second = (JSON.parse(post.body) as { tab: TerminalTabSummary }).tab; // created active

    const del = await app.inject({
      method: 'DELETE',
      url: `/layouts/tabs/${second.id}`,
      headers: { cookie },
    });
    assert.equal(del.statusCode, 200);
    const delBody = JSON.parse(del.body) as { ok: boolean; activeTabId?: string };
    assert.equal(delBody.ok, true);
    assert.equal(delBody.activeTabId, main!.id);

    const tabs = await getTabs(app, cookie);
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0]!.isActive, true);

    await app.close();
  },
);

test(
  'DELETE /layouts/tabs/:id refuses to close the user’s last tab (GW-2011)',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);
    const [main] = await getTabs(app, cookie);

    const res = await app.inject({
      method: 'DELETE',
      url: `/layouts/tabs/${main!.id}`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, 'GW-2011');

    await app.close();
  },
);

test(
  'DELETE /layouts/tabs/:id 404s for an unknown tab (GW-2012)',
  { skip: !reachable },
  async () => {
    const app = await buildApp();
    const cookie = await signUpAndGetCookie(app);

    const res = await app.inject({
      method: 'DELETE',
      url: `/layouts/tabs/${randomUUID()}`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error.code, 'GW-2012');

    await app.close();
  },
);

test(
  '/layouts/tabs mutations without a session are rejected (GW-2002)',
  { skip: !reachable },
  async () => {
    const app = await buildApp();

    const post = await app.inject({
      method: 'POST',
      url: '/layouts/tabs',
      payload: { title: 'X' },
    });
    assert.equal(post.statusCode, 401);
    assert.equal(JSON.parse(post.body).error.code, 'GW-2002');

    const del = await app.inject({ method: 'DELETE', url: `/layouts/tabs/${randomUUID()}` });
    assert.equal(del.statusCode, 401);
    assert.equal(JSON.parse(del.body).error.code, 'GW-2002');

    await app.close();
  },
);

after(async () => {
  if (reachable) {
    await pool.query(`DELETE FROM users WHERE email LIKE 'layout-test-%@example.invalid'`);
  }
  await pool.end().catch(() => undefined);
  closeSubscriber();
  redis.disconnect();
});
