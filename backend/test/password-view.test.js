/**
 * Admin password view and set (12 Nov 2026).
 * Requires a running Postgres with DATABASE_URL set and migrations applied (CI does both).
 * The key is made up here if the environment has none, so CI needs no secret.
 */
import crypto from 'node:crypto';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import request from 'supertest';
import { pool, query, one } from '../src/db.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { encryptPassword, decryptPassword } from '../src/auth/passwordView.js';
import app from '../src/index.js';

if (!process.env.PASSWORD_VIEW_KEY) process.env.PASSWORD_VIEW_KEY = crypto.randomBytes(32).toString('base64');

const ADMIN = { email: 'pv-admin@example.com', password: 'pv-admin-' + crypto.randomBytes(8).toString('hex') };
const PLAIN = { email: 'pv-user@example.com', password: 'pv-user-' + crypto.randomBytes(8).toString('hex') };
const OLDER = { email: 'pv-older@example.com', password: 'pv-older-' + crypto.randomBytes(8).toString('hex') };
const NEW_USER = { email: 'pv-new@example.com', password: 'pv-new-' + crypto.randomBytes(8).toString('hex') };
const EMAILS = [ADMIN, PLAIN, OLDER, NEW_USER].map((u) => u.email);

async function cleanup() {
  await query(`DELETE FROM password_views WHERE user_email = ANY($1) OR admin_email = ANY($1)`, [EMAILS]);
  await query(`DELETE FROM users WHERE email = ANY($1)`, [EMAILS]);
}

function cookieFrom(res) {
  const raw = res.headers['set-cookie']?.[0];
  return raw ? raw.split(';')[0] : '';
}
const login = (u) => request(app).post('/auth/login').send({ email: u.email, password: u.password });
const idOf = async (email) => (await one(`SELECT id FROM users WHERE email = $1`, [email])).id;
const views = async (email) => Number((await one(`SELECT count(*)::int AS n FROM password_views WHERE user_email = $1`, [email])).n);

let adminCookie = '';

beforeAll(async () => {
  await cleanup();
  // An admin and an ordinary user, plus a user set up before this change (no copy stored).
  await query(`INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')`, [ADMIN.email, await hashPassword(ADMIN.password)]);
  await query(`INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user')`, [PLAIN.email, await hashPassword(PLAIN.password)]);
  await query(`INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user')`, [OLDER.email, await hashPassword(OLDER.password)]);
  adminCookie = cookieFrom(await login(ADMIN));
  expect(adminCookie).toMatch(/sid=/);
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('admin password view and set', () => {
  it('a user set up before the change still signs in and has no copy', async () => {
    expect((await login(OLDER)).status).toBe(200);
    const res = await request(app).get(`/admin/users/${await idOf(OLDER.email)}/password`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.password).toBeNull();
  });

  it('creating a user stores the hash for sign-in and an encrypted copy', async () => {
    const res = await request(app).post('/admin/users').set('Cookie', adminCookie)
      .send({ email: NEW_USER.email, password: NEW_USER.password, role: 'user' });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(NEW_USER.password);
    expect(Object.keys(res.body.user).filter((k) => /password_(hash|enc)/.test(k))).toEqual([]);
    expect(res.body.user.password_stored).toBe(true);
    const row = await one(`SELECT password_hash, password_enc FROM users WHERE email = $1`, [NEW_USER.email]);
    expect(await verifyPassword(NEW_USER.password, row.password_hash)).toBe(true);
    expect(row.password_enc).toMatch(/^v1:/);
    expect(row.password_enc).not.toContain(NEW_USER.password);
    expect((await login(NEW_USER)).status).toBe(200);
  });

  it('the users list never carries a password, a hash or a copy', async () => {
    const res = await request(app).get('/admin/users').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const u of [ADMIN, PLAIN, OLDER, NEW_USER]) expect(text).not.toContain(u.password);
    expect(text).not.toMatch(/password_hash|password_enc|"v1:|\$2[aby]\$/);
    const byEmail = Object.fromEntries(res.body.users.map((u) => [u.email, u]));
    expect(byEmail[NEW_USER.email].password_stored).toBe(true);
    expect(byEmail[OLDER.email].password_stored).toBe(false);
  });

  it('the admin can view a stored password, and each view is recorded', async () => {
    const before = await views(NEW_USER.email);
    const res = await request(app).get(`/admin/users/${await idOf(NEW_USER.email)}/password`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.password).toBe(NEW_USER.password);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await views(NEW_USER.email)).toBe(before + 1);
    const v = await one(`SELECT admin_email FROM password_views WHERE user_email = $1 ORDER BY viewed_at DESC LIMIT 1`, [NEW_USER.email]);
    expect(String(v.admin_email).toLowerCase()).toBe(ADMIN.email);
  });

  it('a non-admin gets 403 and nobody signed in gets 401, and neither is recorded', async () => {
    const id = await idOf(NEW_USER.email);
    const before = await views(NEW_USER.email);
    const userCookie = cookieFrom(await login(PLAIN));
    expect((await request(app).get(`/admin/users/${id}/password`).set('Cookie', userCookie)).status).toBe(403);
    expect((await request(app).get(`/admin/users/${id}/password`)).status).toBe(401);
    expect(await views(NEW_USER.email)).toBe(before);
  });

  it('an id that is not a user gives 404, not a server error', async () => {
    expect((await request(app).get('/admin/users/not-a-uuid/password').set('Cookie', adminCookie)).status).toBe(404);
    expect((await request(app).get(`/admin/users/${crypto.randomUUID()}/password`).set('Cookie', adminCookie)).status).toBe(404);
  });

  it('setting a password: too short is refused', async () => {
    const res = await request(app).patch(`/admin/users/${await idOf(OLDER.email)}`).set('Cookie', adminCookie)
      .send({ password: 'short-pw' });
    expect(res.status).toBe(400);
  });

  it('setting a password replaces hash and copy and signs the user out everywhere', async () => {
    const userCookie = cookieFrom(await login(OLDER));
    expect((await request(app).get('/auth/me').set('Cookie', userCookie)).status).toBe(200);
    const fresh = 'pv-reset-' + crypto.randomBytes(8).toString('hex');
    const res = await request(app).patch(`/admin/users/${await idOf(OLDER.email)}`).set('Cookie', adminCookie)
      .send({ password: fresh });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(fresh);
    expect(res.body.user.password_stored).toBe(true);
    expect((await request(app).get('/auth/me').set('Cookie', userCookie)).status).toBe(401);
    expect((await login(OLDER)).status).toBe(401);
    expect((await login({ email: OLDER.email, password: fresh })).status).toBe(200);
    const view = await request(app).get(`/admin/users/${await idOf(OLDER.email)}/password`).set('Cookie', adminCookie);
    expect(view.body.password).toBe(fresh);
    OLDER.password = fresh;
  });

  it('a copy only opens for its own user and with the right key', async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const enc = encryptPassword('some-password-123', a);
    expect(decryptPassword(enc, a)).toBe('some-password-123');
    expect(decryptPassword(enc, a.toUpperCase())).toBe('some-password-123');
    expect(decryptPassword(enc, b)).toBeNull();
    expect(decryptPassword(enc.slice(0, -4) + 'AAAA', a)).toBeNull();
    expect(decryptPassword('rubbish', a)).toBeNull();
    const keep = process.env.PASSWORD_VIEW_KEY;
    process.env.PASSWORD_VIEW_KEY = crypto.randomBytes(32).toString('base64');
    expect(decryptPassword(enc, a)).toBeNull();
    process.env.PASSWORD_VIEW_KEY = keep;
  });

  it('with no key set, users can still be created and sign in, but no copy is kept', async () => {
    const keep = process.env.PASSWORD_VIEW_KEY;
    delete process.env.PASSWORD_VIEW_KEY;
    try {
      const fresh = 'pv-nokey-' + crypto.randomBytes(8).toString('hex');
      const res = await request(app).patch(`/admin/users/${await idOf(OLDER.email)}`).set('Cookie', adminCookie)
        .send({ password: fresh });
      expect(res.status).toBe(200);
      expect(res.body.user.password_stored).toBe(false);
      expect((await login({ email: OLDER.email, password: fresh })).status).toBe(200);
    } finally {
      process.env.PASSWORD_VIEW_KEY = keep;
    }
  });
});
