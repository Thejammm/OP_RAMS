import crypto from 'node:crypto';
import { Router } from 'express';
import { query, one } from '../db.js';
import { hashPassword } from '../auth/passwords.js';
import { encryptPassword, decryptPassword } from '../auth/passwordView.js';
import { revokeAllSessionsForUser } from '../auth/sessions.js';
import { requireAuth, requireRole, asyncRoute } from '../auth/middleware.js';
import { createUserSchema, updateUserSchema } from '../validation/schemas.js';

const router = Router();

router.use(requireAuth, requireRole('admin'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Never select password_hash or password_enc here: the list only says whether
// a viewable copy exists. The password itself only comes from GET /users/:id/password.
router.get('/users', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, role, is_active, access_expires_at, created_at,
            (password_enc IS NOT NULL) AS password_stored
       FROM users ORDER BY created_at DESC`
  );
  res.json({ users: rows });
}));

// Admin only (router-level). Returns the stored copy, or null if there is none.
// Every look is recorded in password_views and the log (never the password).
router.get('/users/:id/password', asyncRoute(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  }
  const user = await one(`SELECT id, email, password_enc FROM users WHERE id = $1`, [req.params.id]);
  if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  const password = decryptPassword(user.password_enc, user.id);
  await query(
    `INSERT INTO password_views (admin_id, admin_email, user_id, user_email) VALUES ($1, $2, $3, $4)`,
    [req.user.id, req.user.email, user.id, user.email]
  );
  req.log?.info({ adminEmail: req.user.email, userEmail: user.email, stored: password !== null }, 'admin viewed a password');
  res.set('Cache-Control', 'no-store');
  res.json({ password });
}));

router.post('/users', asyncRoute(async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid input.' } });
  }
  const { email, password, role, accessExpiresAt } = parsed.data;
  const passwordHash = await hashPassword(password);
  // The id is made here so the viewable copy can be bound to it.
  const id = crypto.randomUUID();

  try {
    const user = await one(
      `INSERT INTO users (id, email, password_hash, role, access_expires_at, password_enc)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, role, is_active, access_expires_at, created_at,
                 (password_enc IS NOT NULL) AS password_stored`,
      [id, email, passwordHash, role, accessExpiresAt ?? null, encryptPassword(password, id)]
    );
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'That email already exists.' } });
    }
    throw err;
  }
}));

router.patch('/users/:id', asyncRoute(async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid input.' } });
  }
  const { role, isActive, accessExpiresAt, password } = parsed.data;

  // Build dynamic update carefully — column names are hardcoded, values are parameterized.
  const sets = [];
  const vals = [];
  if (role !== undefined)              { vals.push(role);              sets.push(`role = $${vals.length}`); }
  if (isActive !== undefined)          { vals.push(isActive);          sets.push(`is_active = $${vals.length}`); }
  if (accessExpiresAt !== undefined)   { vals.push(accessExpiresAt);   sets.push(`access_expires_at = $${vals.length}`); }
  if (password !== undefined) {
    if (!UUID_RE.test(req.params.id)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }
    const hash = await hashPassword(password);
    vals.push(hash);
    sets.push(`password_hash = $${vals.length}`);
    // The viewable copy is replaced with the hash. With no key set it becomes
    // NULL, so an old copy can never outlive the password it was made from.
    vals.push(encryptPassword(password, req.params.id));
    sets.push(`password_enc = $${vals.length}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Nothing to update.' } });
  }
  sets.push(`updated_at = now()`);

  vals.push(req.params.id);
  const sql = `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
               RETURNING id, email, role, is_active, access_expires_at, created_at,
                         (password_enc IS NOT NULL) AS password_stored`;
  const user = await one(sql, vals);
  if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  // If they were deactivated, or their password changed, kick them out immediately.
  if (isActive === false || password !== undefined) await revokeAllSessionsForUser(req.params.id);

  res.json({ user });
}));

router.post('/users/:id/revoke-sessions', asyncRoute(async (req, res) => {
  await revokeAllSessionsForUser(req.params.id);
  res.json({ ok: true });
}));

router.delete('/users/:id', asyncRoute(async (req, res) => {
  // Hard delete. The assessments table FK has ON DELETE CASCADE (migration 003),
  // so the user's saved RAMS records are removed atomically. This is intentional —
  // soft-delete blocked re-creating an account with the same email (UNIQUE
  // constraint on users.email kept the row around), and admins were getting
  // stuck when a user needed to be re-onboarded with the same address.
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: "You can't delete yourself." } });
  }
  // Revoke first so any in-flight requests from this user fail cleanly before
  // their row disappears (avoids transient FK errors in session lookups).
  await revokeAllSessionsForUser(req.params.id);
  const user = await one(
    `DELETE FROM users WHERE id = $1
     RETURNING id, email, role`,
    [req.params.id]
  );
  if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
  res.json({ user, deleted: true });
}));

export default router;
