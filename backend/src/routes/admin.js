import { Router } from 'express';
import { query, one } from '../db.js';
import { hashPassword } from '../auth/passwords.js';
import { revokeAllSessionsForUser } from '../auth/sessions.js';
import { requireAuth, requireRole, asyncRoute } from '../auth/middleware.js';
import { createUserSchema, updateUserSchema } from '../validation/schemas.js';

const router = Router();

router.use(requireAuth, requireRole('admin'));

router.get('/users', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, role, is_active, access_expires_at, created_at
       FROM users ORDER BY created_at DESC`
  );
  res.json({ users: rows });
}));

router.post('/users', asyncRoute(async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid input.' } });
  }
  const { email, password, role, accessExpiresAt } = parsed.data;
  const passwordHash = await hashPassword(password);

  try {
    const user = await one(
      `INSERT INTO users (email, password_hash, role, access_expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, is_active, access_expires_at, created_at`,
      [email, passwordHash, role, accessExpiresAt ?? null]
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
    const hash = await hashPassword(password);
    vals.push(hash);
    sets.push(`password_hash = $${vals.length}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Nothing to update.' } });
  }
  sets.push(`updated_at = now()`);

  vals.push(req.params.id);
  const sql = `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
               RETURNING id, email, role, is_active, access_expires_at, created_at`;
  const user = await one(sql, vals);
  if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });

  // If they were deactivated, kick them out immediately.
  if (isActive === false) await revokeAllSessionsForUser(req.params.id);

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
