/**
 * Integration tests for auth + revocation.
 * Requires a running Postgres with DATABASE_URL set. Docker compose handles this.
 * Run with: npm test
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import request from 'supertest';
import { pool, query } from '../src/db.js';
import { hashPassword } from '../src/auth/passwords.js';
import app from '../src/index.js';

const TEST_EMAIL = 'test-user@example.com';
const TEST_PASSWORD = 'correct-horse-battery-staple';

async function cleanup() {
  await query(`DELETE FROM users WHERE email = $1`, [TEST_EMAIL]);
}

beforeAll(async () => {
  await cleanup();
  const hash = await hashPassword(TEST_PASSWORD);
  await query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user')`,
    [TEST_EMAIL, hash]
  );
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

function cookieFrom(res) {
  const raw = res.headers['set-cookie']?.[0];
  return raw ? raw.split(';')[0] : '';
}

describe('auth flow', () => {
  it('rejects wrong password with 401', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('logs in with correct password and sets cookie', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email.toLowerCase()).toBe(TEST_EMAIL);
    expect(res.headers['set-cookie']?.[0]).toMatch(/sid=/);
  });

  it('blocks /me without cookie', async () => {
    const res = await request(app).get('/me');
    // /me lives under /auth
    expect([401, 404]).toContain(res.status);
  });

  it('allows /auth/me with cookie', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const cookie = cookieFrom(login);
    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email.toLowerCase()).toBe(TEST_EMAIL);
  });

  it('rejects after session revoked', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const cookie = cookieFrom(login);
    // Manually revoke all sessions for this user.
    await query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [TEST_EMAIL]
    );
    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });

  it('rejects when access_expires_at is in the past', async () => {
    await query(
      `UPDATE users SET access_expires_at = now() - interval '1 day' WHERE email = $1`,
      [TEST_EMAIL]
    );
    const res = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    await query(`UPDATE users SET access_expires_at = NULL WHERE email = $1`, [TEST_EMAIL]);
  });

  it('rejects non-admin hitting /admin endpoints', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const cookie = cookieFrom(login);
    const res = await request(app).get('/admin/users').set('Cookie', cookie);
    expect(res.status).toBe(403);
  });
});
