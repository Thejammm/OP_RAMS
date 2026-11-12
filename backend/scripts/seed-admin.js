import 'dotenv/config';
import crypto from 'node:crypto';
import { pool, one } from '../src/db.js';
import { hashPassword } from '../src/auth/passwords.js';
import { encryptPassword } from '../src/auth/passwordView.js';

async function run() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env before running seed.');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const existing = await one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    // Idempotently make the admin's login match ADMIN_EMAIL / ADMIN_PASSWORD.
    // This is the recovery path: set a fresh ADMIN_PASSWORD in the host env and
    // redeploy to get back in if the admin password is ever lost. It also
    // re-activates the account and clears any access expiry.
    // The admin's viewable copy follows ADMIN_PASSWORD too, like every other
    // place a password is set (NULL when PASSWORD_VIEW_KEY is not set).
    await pool.query(
      `UPDATE users
          SET password_hash = $2, password_enc = $3, role = 'admin', is_active = true,
              access_expires_at = NULL, updated_at = now()
        WHERE email = $1`,
      [email, hash, encryptPassword(password, existing.id)]
    );
    console.log(`admin password reset to match ADMIN_PASSWORD: ${email}`);
    await pool.end();
    return;
  }

  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, password_enc) VALUES ($1, $2, $3, 'admin', $4)`,
    [id, email, hash, encryptPassword(password, id)]
  );
  console.log(`admin created: ${email}`);
  console.log('IMPORTANT: log in and change this password immediately.');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
