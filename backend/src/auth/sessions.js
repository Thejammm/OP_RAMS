import crypto from 'node:crypto';
import { query, one } from '../db.js';

const SESSION_TTL_DAYS = 7;       // sliding window
const ABSOLUTE_MAX_DAYS = 30;     // hard cap from creation

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function randomToken() {
  // 32 bytes => 43-char base64url — unguessable
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a session for a user. Returns { token } — the raw token that becomes the cookie.
 * Only the hash is stored.
 */
export async function createSession(userId) {
  const token = randomToken();
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );

  return { token, expiresAt };
}

/**
 * Verify a token. Returns { user, session } if valid, null otherwise.
 * Enforces: session not revoked, not expired, not past absolute cap,
 * user active, access_expires_at not past.
 */
export async function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = sha256(token);

  const row = await one(
    `SELECT
        s.id           AS session_id,
        s.created_at   AS session_created_at,
        s.expires_at   AS session_expires_at,
        u.id           AS user_id,
        u.email        AS email,
        u.role         AS role,
        u.is_active    AS is_active,
        u.access_expires_at AS access_expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()`,
    [tokenHash]
  );

  if (!row) return null;
  if (!row.is_active) return null;
  if (row.access_expires_at && row.access_expires_at < new Date()) return null;

  // Absolute cap: even a sliding session can't exceed ABSOLUTE_MAX_DAYS from creation.
  const absoluteDeadline = new Date(
    row.session_created_at.getTime() + ABSOLUTE_MAX_DAYS * 24 * 60 * 60 * 1000
  );
  if (absoluteDeadline < new Date()) return null;

  // Slide the window forward (cap at absoluteDeadline).
  const newExpiry = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const effectiveExpiry = newExpiry > absoluteDeadline ? absoluteDeadline : newExpiry;
  await query(
    `UPDATE sessions SET expires_at = $1, last_used_at = now() WHERE id = $2`,
    [effectiveExpiry, row.session_id]
  );

  return {
    user: {
      id: row.user_id,
      email: row.email,
      role: row.role,
      accessExpiresAt: row.access_expires_at,
    },
    sessionId: row.session_id,
  };
}

/** Revoke a single session by its raw token. */
export async function revokeSessionByToken(token) {
  if (!token) return;
  await query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [sha256(token)]);
}

/** Revoke every active session for a user. Used for "kick them out now". */
export async function revokeAllSessionsForUser(userId) {
  await query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}
