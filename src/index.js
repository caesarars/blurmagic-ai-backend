import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { verifyBearer, getDb } from './firebaseAdmin.js';
import { encryptText } from './crypto.js';
import { createTronAccount, fetchRecentUsdtTransfersTo, usdtToBaseUnits } from './tron.js';
import { getMerchantAddress, verifyUsdtBep20Transfer } from './bep20.js';
import { makeRateLimiter } from './rateLimit.js';
import { consumeCredits, ensureUserDoc, getEntitlements } from './entitlements.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(makeRateLimiter({ windowMs: 60_000, max: 120 }));

const ALLOWED_ORIGINS = (process.env.CORS_ALLOW_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!ALLOWED_ORIGINS.length) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

const PRICE_USDT = Number(process.env.PRO_PRICE_USDT || 10);
const MONTHLY_CREDITS = Number(process.env.PRO_MONTHLY_CREDITS || 1000);
const PERIOD_DAYS = Number(process.env.PRO_PERIOD_DAYS || 30);

function addDaysMs(ms, days) {
  return ms + days * 24 * 60 * 60 * 1000;
}

function toMillisMaybe(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

function requireAdmin(req) {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret) throw new Error('Missing ADMIN_API_SECRET');
  const provided = (req.headers['x-admin-secret'] || '').toString();
  if (!provided || provided !== secret) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Entitlements (plan/credits)
app.get('/entitlements', async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;
    const db = getDb();
    const ent = await getEntitlements(db, uid);
    return res.json(ent);
  } catch (e) {
    console.error('entitlements error', e);
    res.status(401).json({ error: e?.message || 'Unauthorized' });
  }
});

// Consume credits (for processing)
app.post('/consume-credit', async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;
    const count = Number(req.body?.count ?? 1);
    const reason = String(req.body?.reason || 'process_image');
    const db = getDb();
    const ent = await consumeCredits(db, uid, count, reason);
    return res.json(ent);
  } catch (e) {
    const status = e?.statusCode || 400;
    res.status(status).json({ error: e?.message || 'Bad request' });
  }
});

// Create or get user TRON deposit address
app.post('/payments/tron/deposit', async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;

    const db = getDb();
    await ensureUserDoc(db, uid);

    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();
    const data = snap.data() || {};

    if (data.tronDepositAddress && data.tronDepositPrivEnc) {
      return res.json({
        ok: true,
        address: data.tronDepositAddress,
        chain: 'TRC20',
        token: 'USDT',
        priceUsdt: PRICE_USDT,
        credits: MONTHLY_CREDITS,
      });
    }

    const { address, privateKey } = await createTronAccount();
    const tronDepositPrivEnc = encryptText(privateKey);

    await userRef.set(
      {
        tronDepositAddress: address,
        tronDepositPrivEnc,
        tronDepositCreatedAt: new Date(),
        updatedAt: new Date(),
      },
      { merge: true }
    );

    return res.json({
      ok: true,
      address,
      chain: 'TRC20',
      token: 'USDT',
      priceUsdt: PRICE_USDT,
      credits: MONTHLY_CREDITS,
    });
  } catch (e) {
    console.error('deposit error', e);
    res.status(500).json({ error: e?.message || 'Server error' });
  }
});

// Claim payment (user-triggered) and grant credits (BEP20 USDT)
app.post('/payments/bep20/claim', async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;

    const txid = String(req.body?.txid || '').trim();
    if (!txid) return res.status(400).json({ error: 'Missing txid' });

    const merchant = getMerchantAddress();

    const db = getDb();
    await ensureUserDoc(db, uid);

    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const user = userSnap.data() || {};

    const check = await verifyUsdtBep20Transfer({ txid, toAddress: merchant, amountUsdt: PRICE_USDT });
    if (!check.found) {
      return res.json({ ok: true, paid: false, reason: check.reason || 'not_found' });
    }

    const paymentId = `bep20_${txid}`;
    const payRef = db.collection('payments').doc(paymentId);

    let didProcess = false;

    await db.runTransaction(async (tx) => {
      const paySnap = await tx.get(payRef);
      if (paySnap.exists) return;

      didProcess = true;

      const now = Date.now();
      const prevEnd = toMillisMaybe(user.currentPeriodEnd);
      const base = Math.max(now, prevEnd || 0);
      const newPeriodEnd = addDaysMs(base, PERIOD_DAYS);

      tx.set(
        payRef,
        {
          uid,
          chain: 'BEP20',
          token: 'USDT',
          amountUsdt: PRICE_USDT,
          toAddress: merchant,
          fromAddress: check.from || null,
          txid,
          status: 'confirmed',
          blockNumber: check.blockNumber || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { merge: true }
      );

      tx.set(
        userRef,
        {
          plan: 'pro',
          subscriptionStatus: 'active',
          monthlyCreditsAllowance: MONTHLY_CREDITS,
          currentPeriodEnd: new Date(newPeriodEnd),
          lastGrantedPeriodEnd: new Date(newPeriodEnd),
          updatedAt: new Date(),
        },
        { merge: true }
      );

      const current = Number(user.creditsBalance || 0);
      tx.set(
        userRef,
        {
          creditsBalance: current + MONTHLY_CREDITS,
        },
        { merge: true }
      );

      const ledgerRef = userRef.collection('credit_ledger').doc();
      tx.set(ledgerRef, {
        type: 'grant',
        amount: MONTHLY_CREDITS,
        reason: `usdt_bep20_monthly_${PRICE_USDT}`,
        createdAt: new Date(),
      });
    });

    return res.json({ ok: true, paid: true, processed: didProcess, txid });
  } catch (e) {
    console.error('bep20 claim error', e);
    res.status(500).json({ error: e?.message || 'Server error' });
  }
});

// Admin cron sync placeholder (optional): validate env + connectivity
app.post('/cron/ping', async (req, res) => {
  try {
    requireAdmin(req);
    return res.json({ ok: true, ts: new Date().toISOString() });
  } catch (e) {
    return res.status(e?.statusCode || 401).json({ error: e?.message || 'Unauthorized' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`blurmagic-backend listening on :${port}`);
});
