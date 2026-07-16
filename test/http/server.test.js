import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers/testServer.js';

const FIXTURE_DIST_PATH = fileURLToPath(new URL('./fixtures/client-dist-fixture', import.meta.url));

let ctx;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

describe('production static/SPA wiring', () => {
  it('serves the SPA shell for an unmatched GET when isProduction', async () => {
    ctx = await startTestServer({ configOverrides: { isProduction: true }, clientDistPath: FIXTURE_DIST_PATH });
    const res = await fetch(`${ctx.baseUrl}/some/deep/dashboard/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('dashboard-shell-fixture');
  });

  it('still returns the JSON 404 for an unmatched /api path, not the SPA shell', async () => {
    ctx = await startTestServer({ configOverrides: { isProduction: true }, clientDistPath: FIXTURE_DIST_PATH });
    const res = await fetch(`${ctx.baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('still returns the JSON 404 for an unmatched /auth path, not the SPA shell', async () => {
    ctx = await startTestServer({ configOverrides: { isProduction: true }, clientDistPath: FIXTURE_DIST_PATH });
    const res = await fetch(`${ctx.baseUrl}/auth/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('does not serve the SPA shell when not in production', async () => {
    ctx = await startTestServer({ configOverrides: { isProduction: false }, clientDistPath: FIXTURE_DIST_PATH });
    const res = await fetch(`${ctx.baseUrl}/some/deep/dashboard/route`);
    expect(res.status).toBe(404);
  });
});
