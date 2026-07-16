import { describe, it, expect, afterEach } from 'vitest';
import { startTestServer, extractCookie } from './helpers/testServer.js';

let ctx;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

async function login(baseUrl, email, password) {
  return fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

describe('POST /auth/login', () => {
  it('returns 200 + Set-Cookie + user info on correct credentials', async () => {
    ctx = await startTestServer();
    ctx.authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });

    const res = await login(ctx.baseUrl, 'a@example.com', 'longpassword');
    expect(res.status).toBe(200);
    expect(extractCookie(res)).toMatch(/^sid=/);
    expect(await res.json()).toEqual({ mustChangePassword: true, tenantId: 't1', isSuperadmin: false });
  });

  it('returns 401 (not 200) on a wrong password, no cookie set', async () => {
    ctx = await startTestServer();
    ctx.authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });

    const res = await login(ctx.baseUrl, 'a@example.com', 'wrong-password');
    expect(res.status).toBe(401);
    expect(extractCookie(res)).toBeNull();
  });

  it('returns the identical 401 for an unknown email', async () => {
    ctx = await startTestServer();
    const res = await login(ctx.baseUrl, 'nobody@example.com', 'whatever12');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid email or password' });
  });

  it('rate-limits repeated failures for the same email', async () => {
    ctx = await startTestServer({ configOverrides: { loginRateLimitMax: 2, loginRateLimitWindowMinutes: 15 } });
    ctx.authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });

    await login(ctx.baseUrl, 'a@example.com', 'wrong');
    await login(ctx.baseUrl, 'a@example.com', 'wrong');
    const third = await login(ctx.baseUrl, 'a@example.com', 'wrong');
    expect(third.status).toBe(429);

    // even the correct password is blocked once the limit is hit
    const fourth = await login(ctx.baseUrl, 'a@example.com', 'longpassword');
    expect(fourth.status).toBe(429);
  });
});

describe('must_change_password gate', () => {
  it('lets /auth/change-password through despite the gate, and clears it on success', async () => {
    ctx = await startTestServer();
    ctx.authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
    const loginRes = await login(ctx.baseUrl, 'a@example.com', 'original-pw');
    const cookie = extractCookie(loginRes);

    // change-password is reachable despite must_change_password
    const changeRes = await fetch(`${ctx.baseUrl}/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPassword: 'original-pw', newPassword: 'brand-new-pw' }),
    });
    expect(changeRes.status).toBe(200);

    // logging in again now reflects mustChangePassword: false
    const secondLogin = await login(ctx.baseUrl, 'a@example.com', 'brand-new-pw');
    expect((await secondLogin.json()).mustChangePassword).toBe(false);
  });

  it('also lets /auth/logout through despite the gate', async () => {
    ctx = await startTestServer();
    ctx.authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
    const loginRes = await login(ctx.baseUrl, 'a@example.com', 'original-pw');
    const cookie = extractCookie(loginRes);

    const logoutRes = await fetch(`${ctx.baseUrl}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    expect(logoutRes.status).toBe(200);
  });
});

describe('POST /auth/logout', () => {
  it('invalidates the session so a subsequent authenticated call fails', async () => {
    ctx = await startTestServer();
    const user = ctx.authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
    ctx.authStore.changePassword(user.id, { currentPassword: 'original-pw', newPassword: 'brand-new-pw' });
    const loginRes = await login(ctx.baseUrl, 'a@example.com', 'brand-new-pw');
    const cookie = extractCookie(loginRes);

    const logoutRes = await fetch(`${ctx.baseUrl}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    expect(logoutRes.status).toBe(200);

    const afterLogout = await fetch(`${ctx.baseUrl}/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPassword: 'brand-new-pw', newPassword: 'another-pw12' }),
    });
    expect(afterLogout.status).toBe(401);
  });
});
