// Very small in-memory rate limiter (best-effort). Suitable for MVP.

export function makeRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map();

  return function rateLimit(req, res, next) {
    const key = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count += 1;
    hits.set(key, entry);

    if (entry.count > max) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    next();
  };
}
