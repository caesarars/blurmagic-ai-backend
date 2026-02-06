const FREE_DAILY_LIMIT = 5;

function utcDateKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function ensureUserDoc(db, uid) {
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (snap.exists) return;
  await ref.set(
    {
      plan: 'free',
      creditsBalance: 0,
      monthlyCreditsAllowance: 0,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      lastGrantedPeriodEnd: null,
      dailyCreditsUsed: 0,
      lastDailyResetDate: utcDateKey(),
      tronDepositAddress: null,
      tronDepositPrivEnc: null,
      tronDepositCreatedAt: null,
      tronLastCheckedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { merge: true }
  );
}

function toMillisMaybe(v) {
  if (!v) return null;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

export async function getEntitlements(db, uid) {
  await ensureUserDoc(db, uid);
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const data = snap.data() || {};

  const rawPlan = String(data.plan || 'free');
  const creditsBalance = Number(data.creditsBalance || 0);
  const subscriptionStatus = data.subscriptionStatus ?? null;
  const currentPeriodEnd = toMillisMaybe(data.currentPeriodEnd);

  const nowMs = Date.now();
  const isExpired = !!(currentPeriodEnd && nowMs > currentPeriodEnd);

  // If subscription is expired and user has no remaining paid credits, treat as free for gating.
  const plan = isExpired && creditsBalance <= 0 ? 'free' : rawPlan;

  const today = utcDateKey();
  const lastDailyResetDate = String(data.lastDailyResetDate || '');
  const dailyCreditsUsedRaw = Number(data.dailyCreditsUsed || 0);
  const dailyCreditsUsed = lastDailyResetDate === today ? dailyCreditsUsedRaw : 0;

  if (plan === 'free') {
    const remaining = Math.max(0, FREE_DAILY_LIMIT - dailyCreditsUsed);
    return {
      plan,
      canUse: remaining > 0,
      remaining,
      limit: FREE_DAILY_LIMIT,
      creditsBalance,
      dailyCreditsUsed,
      dailyLimit: FREE_DAILY_LIMIT,
      subscriptionStatus,
      currentPeriodEnd,
      subscriptionExpired: isExpired,
    };
  }

  const remaining = Math.max(0, creditsBalance);
  return {
    plan,
    canUse: remaining > 0,
    remaining,
    limit: remaining,
    creditsBalance,
    dailyCreditsUsed,
    dailyLimit: FREE_DAILY_LIMIT,
    subscriptionStatus,
    currentPeriodEnd,
    subscriptionExpired: isExpired,
  };
}

export async function consumeCredits(db, uid, count, reason) {
  if (!Number.isFinite(count) || count <= 0) throw Object.assign(new Error('Invalid count'), { statusCode: 400 });

  const userRef = db.collection('users').doc(uid);
  const ledgerRef = userRef.collection('credit_ledger').doc();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.data() || {};
    const plan = String(data.plan || 'free');

    if (plan === 'free') {
      const today = utcDateKey();
      const lastDailyResetDate = String(data.lastDailyResetDate || '');
      const dailyCreditsUsed = Number(data.dailyCreditsUsed || 0);
      const effectiveUsed = lastDailyResetDate === today ? dailyCreditsUsed : 0;
      const remaining = FREE_DAILY_LIMIT - effectiveUsed;
      if (remaining < count) throw Object.assign(new Error('Insufficient daily credits'), { statusCode: 402, code: 'insufficient_credits' });
      tx.set(userRef, { dailyCreditsUsed: effectiveUsed + count, lastDailyResetDate: today, updatedAt: new Date() }, { merge: true });
      tx.set(ledgerRef, { type: 'spend', amount: count, reason: reason || 'process_image', createdAt: new Date() });
      return;
    }

    const creditsBalance = Number(data.creditsBalance || 0);
    if (creditsBalance < count) throw Object.assign(new Error('Insufficient credits'), { statusCode: 402, code: 'insufficient_credits' });
    tx.set(userRef, { creditsBalance: creditsBalance - count, updatedAt: new Date() }, { merge: true });
    tx.set(ledgerRef, { type: 'spend', amount: count, reason: reason || 'process_image', createdAt: new Date() });
  });

  return getEntitlements(db, uid);
}

export async function grantCredits(db, uid, amount, reason) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const userRef = db.collection('users').doc(uid);
  const ledgerRef = userRef.collection('credit_ledger').doc();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.data() || {};
    const current = Number(data.creditsBalance || 0);
    tx.set(userRef, { creditsBalance: current + amount, updatedAt: new Date() }, { merge: true });
    tx.set(ledgerRef, { type: 'grant', amount, reason: reason || 'grant', createdAt: new Date() });
  });
}

export { utcDateKey };
