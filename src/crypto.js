import crypto from 'node:crypto';

function requireSecret() {
  const secret = process.env.TRON_KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error('Missing TRON_KEY_ENCRYPTION_SECRET');
  return secret;
}

function keyFromSecret(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptText(plain) {
  const key = keyFromSecret(requireSecret());
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}
