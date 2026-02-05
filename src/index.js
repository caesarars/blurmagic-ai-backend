import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { verifyBearer, getDb } from './firebaseAdmin.js';
import { encryptText } from './crypto.js';
import { createTronAccount, fetchRecentUsdtTransfersTo, usdtToBaseUnits } from './tron.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const ALLOWED_ORIGINS = (process.env.CORS_ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!ALLOWED_ORIGINS.length) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

const PRICE_USDT = Number(process.env.PRO_PRICE_USDT || 10);
const MONTHLY_CREDITS = Number(process.env.PRO_MONTHLY_CREDITS || 1000);
const PERIOD_DAYS = Number(process.env.PRO_PERIOD_DAYS || 30);

function addDaysMs(ms, days) {
  return ms + days * 24 * 60 * 60 * 1000;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Create or get user TRON deposit address
app.post('/payments/tron/deposit', async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;

    const db = getDb();
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

    await userRef.set({
      tronDepositAddress: address,
      tronDepositPrivEnc,
      tronDepositCreatedAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });

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

// Claim payment (user-triggered) and grant credits
app.post('/payments/tron/claim', async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    const uid = decoded.uid;

    const txidHint = String(req.body?.txid || '').trim();

    const db = getDb();
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const user = userSnap.data() || {};

    const address = String(user.tronDepositAddress || '').trim();
    if (!address) return res.status(400).json({ error: 'No deposit address yet' });

    const expected = usdtToBaseUnits(PRICE_USDT);
    const transfers = await fetchRecentUsdtTransfersTo(address, 50);

    const match = transfers.find((t) => {
      if (txidHint && t.transaction_id !== txidHint) return false;
      return String(t.to || '').toLowerCase() === address.toLowerCase() && String(t.value || '') === expected;
    });

    if (!match) {
      await userRef.set({ tronLastCheckedAt: new Date(), updatedAt: new Date() }, { merge: true });
      return res.json({ ok: true, paid: false });
    }

    const txid = match.transaction_id;
    const paymentId = `trc20_${txid}`;
    const payRef = db.collection('payments').doc(paymentId);

    let didProcess = false;

    await db.runTransaction(async (tx) => {
      const paySnap = await tx.get(payRef);
      if (paySnap.exists) return;

      didProcess = true;
      const now = Date.now();
      const newPeriodEnd = addDaysMs(now, PERIOD_DAYS);

      tx.set(payRef, {
        uid,
        chain: 'TRC20',
        token: 'USDT',
        amountUsdt: PRICE_USDT,
        amountBaseUnits: expected,
        toAddress: address,
        fromAddress: match.from,
        txid,
        status: 'confirmed',
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true });

      tx.set(userRef, {
        plan: 'pro',
        subscriptionStatus: 'active',
        monthlyCreditsAllowance: MONTHLY_CREDITS,
        currentPeriodEnd: new Date(newPeriodEnd),
        lastGrantedPeriodEnd: new Date(newPeriodEnd),
        tronLastCheckedAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true });

      const current = Number(user.creditsBalance || 0);
      tx.set(userRef, {
        creditsBalance: current + MONTHLY_CREDITS,
      }, { merge: true });

      const ledgerRef = userRef.collection('credit_ledger').doc();
      tx.set(ledgerRef, {
        type: 'grant',
        amount: MONTHLY_CREDITS,
        reason: `usdt_trc20_monthly_${PRICE_USDT}`,
        createdAt: new Date(),
      });
    });

    return res.json({ ok: true, paid: true, processed: didProcess, txid });
  } catch (e) {
    console.error('claim error', e);
    res.status(500).json({ error: e?.message || 'Server error' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`blurmagic-backend listening on :${port}`);
});
