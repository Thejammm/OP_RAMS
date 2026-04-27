import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
});

/**
 * Run a parameterized query. Always use $1, $2 placeholders — never concatenate.
 * @param {string} text
 * @param {unknown[]} [params]
 */
export function query(text, params) {
  return pool.query(text, params);
}

/** Convenience: get a single row or null. */
export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}
