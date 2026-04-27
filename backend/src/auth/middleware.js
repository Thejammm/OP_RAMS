import { verifySession } from './sessions.js';

export const COOKIE_NAME = 'sid';

export function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    // In prod, frontend (oprams.archerhs.co.uk) and backend (oprams-api.onrender.com)
    // are on different eTLD+1 — sameSite:'lax' would strip the cookie from every
    // cross-site fetch, looping the user back to login. 'none' + Secure fixes it.
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    // 7 days — matches session TTL.
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

/** Require a valid session. Attaches req.user. */
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    const result = await verifySession(token);
    if (!result) {
      res.clearCookie(COOKIE_NAME, cookieOptions());
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please log in.' } });
    }
    req.user = result.user;
    req.sessionId = result.sessionId;
    next();
  } catch (err) {
    next(err);
  }
}

/** Require a specific role. Must run after requireAuth. */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please log in.' } });
    }
    if (req.user.role !== role) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not allowed.' } });
    }
    next();
  };
}

/** Wraps async route handlers so thrown errors become JSON 500s instead of unhandled rejections. */
export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
