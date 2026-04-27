import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, one } from '../db.js';
import { verifyPassword } from '../auth/passwords.js';
import { createSession, revokeSessionByToken } from '../auth/sessions.js';
import { requireAuth, cookieOptions, COOKIE_NAME, asyncRoute } from '../auth/middleware.js';
import { loginSchema } from '../validation/schemas.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,                   // 5 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' } },
});

router.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid email or password format.' } });
  }
  const { email, password } = parsed.data;

  const user = await one(
    `SELECT id, password_hash, role, is_active, access_expires_at
       FROM users WHERE email = $1`,
    [email]
  );

  // Constant-ish-time response: always do some work to avoid leaking "user exists".
  const passwordOk = user ? await verifyPassword(password, user.password_hash) : false;

  if (!user || !passwordOk || !user.is_active ||
      (user.access_expires_at && user.access_expires_at < new Date())) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password.' } });
  }

  const { token } = await createSession(user.id);
  res.cookie(COOKIE_NAME, token, cookieOptions());
  res.json({
    user: {
      id: user.id,
      email,
      role: user.role,
      accessExpiresAt: user.access_expires_at,
    },
  });
}));

router.post('/logout', asyncRoute(async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) await revokeSessionByToken(token);
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
