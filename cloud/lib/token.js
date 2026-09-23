import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DEPLOYMENT_KEY } from './generated-key.js';

const key = createHash('sha256').update(DEPLOYMENT_KEY).digest();
const encode = (buf) => Buffer.from(buf).toString('base64url');
const decode = (txt) => Buffer.from(txt, 'base64url');

export function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return [encode(iv), encode(cipher.getAuthTag()), encode(encrypted)].join('.');
}

export function unseal(token) {
  if (typeof token !== 'string') throw new Error('invalid_token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid_token');
  const [iv, tag, encrypted] = parts.map(decode);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
}

export function sha256base64url(value) {
  return createHash('sha256').update(value).digest('base64url');
}
