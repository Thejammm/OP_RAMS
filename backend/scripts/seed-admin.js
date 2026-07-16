import 'dotenv/config';
import { pool, one } from '../src/db.js';
import { hashPassword } from '../src/auth/passwords.js';

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
    await pool.query(
      `UPDATE users
          SET password_hash = $2, role = 'admin', is_active = true,
              access_expires_at = NULL, updated_at = now()
        WHERE email = $1`,
      [email, hash]
    );
    console.log(`admin password reset to match ADMIN_PASSWORD: ${email}`);
    await pool.end();
    return;
  }

  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')`,
    [email, hash]
  );
  console.log(`admin created: ${email}`);
  console.log('IMPORTANT: log in and change this password immediately.');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
