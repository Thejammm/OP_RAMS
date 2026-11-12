import crypto from 'node:crypto';

// Admin-viewable copy of a password (Simon's decision, 12 Nov 2026).
// Sign-in never uses this: it checks the bcrypt hash only (passwords.js).
// The copy is AES-256-GCM with a key that lives only in the PASSWORD_VIEW_KEY
// environment variable (32 random bytes, base64), never in the repo or the
// database. The user's id is bound in as associated data, so a copy moved onto
// another user's row will not decrypt.

const VERSION = 'v1';

function key() {
  const raw = (process.env.PASSWORD_VIEW_KEY || '').trim();
  if (!raw) return null;
  const k = Buffer.from(raw, 'base64');
  return k.length === 32 ? k : null;
}

const aad = (userId) => Buffer.from(String(userId).toLowerCase(), 'utf8');

/** 'enabled' | 'missing' | 'invalid' (for the start-up log line). */
export function passwordViewStatus() {
  if (!(process.env.PASSWORD_VIEW_KEY || '').trim()) return 'missing';
  return key() ? 'enabled' : 'invalid';
}

/** The encrypted copy for users.password_enc, or null when no valid key is set. */
export function encryptPassword(plaintext, userId) {
  const k = key();
  if (!k) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv, { authTagLength: 16 });
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/** The password, or null if there is no copy, no key, or the copy does not decrypt. */
export function decryptPassword(stored, userId) {
  const k = key();
  if (!stored || !k) return null;
  try {
    const [v, iv, tag, ct] = String(stored).split(':');
    if (v !== VERSION || !iv || !tag || ct === undefined) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
