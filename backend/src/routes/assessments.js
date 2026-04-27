import { Router } from 'express';
import { query, one } from '../db.js';
import { requireAuth, asyncRoute } from '../auth/middleware.js';
import { assessmentSchema, updateAssessmentSchema } from '../validation/schemas.js';

const router = Router();

router.use(requireAuth);

/** List the current user's assessments (newest first). */
router.get('/', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, created_at, updated_at
       FROM assessments
      WHERE user_id = $1
      ORDER BY updated_at DESC`,
    [req.user.id]
  );
  res.json({ assessments: rows });
}));

/** Full load of one assessment (includes state). Scoped to user. */
router.get('/:id', asyncRoute(async (req, res) => {
  const a = await one(
    `SELECT id, name, state, created_at, updated_at
       FROM assessments
      WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!a) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  res.json({ assessment: a });
}));

/** Create a new assessment. */
router.post('/', asyncRoute(async (req, res) => {
  const parsed = assessmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid input.' } });
  }
  const { name, state } = parsed.data;
  const a = await one(
    `INSERT INTO assessments (user_id, name, state)
     VALUES ($1, $2, $3)
     RETURNING id, name, created_at, updated_at`,
    [req.user.id, name, state]
  );
  res.status(201).json({ assessment: a });
}));

/** Patch name and/or state. */
router.patch('/:id', asyncRoute(async (req, res) => {
  const parsed = updateAssessmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid input.' } });
  }
  const sets = [];
  const vals = [];
  if (parsed.data.name !== undefined)  { vals.push(parsed.data.name);  sets.push(`name = $${vals.length}`); }
  if (parsed.data.state !== undefined) { vals.push(parsed.data.state); sets.push(`state = $${vals.length}`); }
  if (sets.length === 0) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Nothing to update.' } });
  }
  sets.push(`updated_at = now()`);

  vals.push(req.params.id, req.user.id);
  const sql = `UPDATE assessments SET ${sets.join(', ')}
                WHERE id = $${vals.length - 1} AND user_id = $${vals.length}
                RETURNING id, name, created_at, updated_at`;
  const a = await one(sql, vals);
  if (!a) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  res.json({ assessment: a });
}));

/** Delete. */
router.delete('/:id', asyncRoute(async (req, res) => {
  const a = await one(
    `DELETE FROM assessments WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!a) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  res.json({ ok: true });
}));

export default router;
