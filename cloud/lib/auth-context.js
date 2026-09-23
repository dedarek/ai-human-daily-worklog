import { AsyncLocalStorage } from 'node:async_hooks';
import { unseal } from './token.js';

const storage = new AsyncLocalStorage();
export const withAuthContext = (value, fn) => storage.run(value, fn);
export const authContext = () => storage.getStore() || { origin: '', session: null };

export function sessionFromRequest(request, origin) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    const token = unseal(match[1]);
    if (token.kind !== 'access') return null;
    if (!token.exp || token.exp < Math.floor(Date.now() / 1000)) return null;
    if (token.aud !== `${origin}/mcp`) return null;
    if (!String(token.scope || '').split(/\s+/).includes('worklog')) return null;
    return token.session || null;
  } catch {
    return null;
  }
}

export function authChallenge(origin, error = 'invalid_token', description = 'Connect Worklog to continue') {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="${error}", error_description="${description}"`;
}
