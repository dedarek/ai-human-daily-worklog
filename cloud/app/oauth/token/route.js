import { originOf } from '../../../lib/origin.js';
import { seal, sha256base64url, unseal } from '../../../lib/token.js';

const CHATGPT_CLIENT = 'https://chatgpt.com/oauth/client.json';

function tokenResponse(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}

export async function POST(request) {
  const origin = originOf(request);
  const form = await request.formData();
  const grant = String(form.get('grant_type') || '');
  const clientId = String(form.get('client_id') || '');
  const resource = String(form.get('resource') || `${origin}/mcp`);
  if (clientId !== CHATGPT_CLIENT || resource !== `${origin}/mcp`) return tokenResponse({ error: 'invalid_client' }, 400);

  try {
    if (grant === 'authorization_code') {
      const code = unseal(String(form.get('code') || ''));
      const verifier = String(form.get('code_verifier') || '');
      const redirectUri = String(form.get('redirect_uri') || '');
      if (code.kind !== 'code' || code.exp < Math.floor(Date.now() / 1000) || code.clientId !== clientId || code.redirectUri !== redirectUri || code.aud !== resource) {
        return tokenResponse({ error: 'invalid_grant' }, 400);
      }
      if (!verifier || sha256base64url(verifier) !== code.codeChallenge) {
        return tokenResponse({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      return tokenResponse({
        access_token: seal({ kind: 'access', session: code.session, aud: resource, scope: 'worklog', exp: now + 86400 }),
        token_type: 'Bearer',
        expires_in: 86400,
        scope: 'worklog',
        refresh_token: seal({ kind: 'refresh', session: code.session, aud: resource, scope: 'worklog', exp: now + 2592000 }),
      });
    }

    if (grant === 'refresh_token') {
      const refresh = unseal(String(form.get('refresh_token') || ''));
      if (refresh.kind !== 'refresh' || refresh.exp < Math.floor(Date.now() / 1000) || refresh.aud !== resource) {
        return tokenResponse({ error: 'invalid_grant' }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      return tokenResponse({
        access_token: seal({ kind: 'access', session: refresh.session, aud: resource, scope: 'worklog', exp: now + 86400 }),
        token_type: 'Bearer',
        expires_in: 86400,
        scope: 'worklog',
        refresh_token: seal({ ...refresh, exp: now + 2592000 }),
      });
    }

    return tokenResponse({ error: 'unsupported_grant_type' }, 400);
  } catch {
    return tokenResponse({ error: 'invalid_grant' }, 400);
  }
}
