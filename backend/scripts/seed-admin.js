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

  const existing = await one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    console.log(`admin already exists: ${email}`);
    await pool.end();
    return;
  }

  const hash = await hashPassword(password);
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
