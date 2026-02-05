import admin from 'firebase-admin';

let app = null;

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  const json = raw || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : null);
  if (!json) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON (or _BASE64)');
  return JSON.parse(json);
}

export function getAdminApp() {
  if (app) return app;
  if (admin.apps?.length) {
    app = admin.apps[0];
    return app;
  }
  const credential = admin.credential.cert(parseServiceAccount());
  app = admin.initializeApp({ credential });
  return app;
}

export function getDb() {
  getAdminApp();
  return admin.firestore();
}

export async function verifyBearer(req) {
  getAdminApp();
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) {
    const err = new Error('Missing Authorization bearer token');
    err.statusCode = 401;
    throw err;
  }
  const token = match[1];
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}
