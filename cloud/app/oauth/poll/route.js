import { createWorklogStore, pollPersonalAgentRegistration } from '../../../lib/feishu.js';
import { originOf } from '../../../lib/origin.js';
import { seal, unseal } from '../../../lib/token.js';

export async function GET(request) {
  const origin = originOf(request);
  const url = new URL(request.url);

  try {
    const flow = unseal(url.searchParams.get('setup'));
    if (flow.kind !== 'setup' || flow.exp < Math.floor(Date.now() / 1000)) {
      return Response.json({ error: '授权已过期，请重新连接 Worklog。' }, { status: 400 });
    }

    const result = await pollPersonalAgentRegistration(flow.deviceCode);
    if (result.status === 'pending') {
      return Response.json(
        { done: false, interval: result.slowDown ? 7 : 3, message: '等待飞书授权…' },
        { status: 202, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (result.status === 'denied') {
      return Response.json({ error: '你取消了飞书授权。' }, { status: 400 });
    }
    if (result.status === 'expired') {
      return Response.json({ error: '飞书授权已过期，请重新连接。' }, { status: 400 });
    }

    const store = await createWorklogStore(result);
    const session = {
      brand: result.brand,
      appId: result.appId,
      appSecret: result.appSecret,
      openId: result.openId,
      baseToken: store.baseToken,
      tableId: store.tableId,
      baseUrl: store.baseUrl,
    };

    const code = seal({
      kind: 'code',
      session,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      codeChallenge: flow.codeChallenge,
      aud: flow.resource,
      scope: flow.scope,
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    const redirect = new URL(flow.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', flow.state);
    redirect.searchParams.set('iss', origin);

    return Response.json(
      { done: true, redirect: redirect.toString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return Response.json(
      { error: `Worklog setup failed: ${error.message}` },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
