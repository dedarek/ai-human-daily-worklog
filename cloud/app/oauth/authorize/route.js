import { beginPersonalAgentRegistration } from '../../../lib/feishu.js';
import { originOf } from '../../../lib/origin.js';
import { seal } from '../../../lib/token.js';

const CHATGPT_CLIENT = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

export async function GET(request) {
  const origin = originOf(request);
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id') || '';
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  const state = url.searchParams.get('state') || '';
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const method = url.searchParams.get('code_challenge_method') || '';
  const resource = url.searchParams.get('resource') || '';
  const scope = url.searchParams.get('scope') || 'worklog';

  const valid =
    clientId === CHATGPT_CLIENT &&
    redirectUri === CHATGPT_REDIRECT &&
    Boolean(state) &&
    Boolean(codeChallenge) &&
    method === 'S256' &&
    resource === `${origin}/mcp`;

  if (!valid) return new Response('Invalid OAuth request.', { status: 400 });

  let registration;
  try {
    registration = await beginPersonalAgentRegistration();
  } catch (error) {
    return new Response(`Unable to start Feishu setup: ${escapeHTML(error.message)}`, { status: 502 });
  }

  const setup = seal({
    kind: 'setup',
    deviceCode: registration.deviceCode,
    clientId,
    redirectUri,
    state,
    codeChallenge,
    resource,
    scope,
    exp: Math.floor(Date.now() / 1000) + registration.expiresIn,
  });

  const verificationUrl = escapeHTML(registration.verificationUrl);
  const setupJs = JSON.stringify(setup);

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接 Worklog 到飞书</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f6f5f2;color:#1b1b1b;margin:0}
.card{max-width:620px;margin:8vh auto;background:#fff;padding:34px;border-radius:20px;box-shadow:0 12px 40px #0001}
.logo{font-size:28px;font-weight:800}
.sub{color:#666;line-height:1.6;margin:12px 0 26px}
.btn{display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 20px;border-radius:12px;font-weight:700}
.status{margin-top:24px;padding:14px 16px;background:#f5f5f5;border-radius:12px;color:#555}
.small{font-size:13px;color:#888;margin-top:16px}
</style>
</head>
<body>
<main class="card">
<div class="logo">Worklog × 飞书</div>
<div class="sub">只需要这一次授权。完成后，ChatGPT 里的 @Worklog 会直接把记录写进你的飞书 Worklog 多维表格，不依赖任何电脑或服务器。</div>
<a id="open" class="btn" href="${verificationUrl}" target="_blank" rel="noopener">连接飞书</a>
<div id="status" class="status">等待飞书授权…</div>
<div class="small">授权完成后这个页面会自动返回 ChatGPT。</div>
</main>
<script>
const setup=${setupJs};
let stopped=false;
async function poll(){
  if(stopped)return;
  try{
    const r=await fetch('/oauth/poll?setup='+encodeURIComponent(setup),{cache:'no-store'});
    const j=await r.json();
    if(j.done&&j.redirect){
      stopped=true;
      document.getElementById('status').textContent='已连接，正在返回 ChatGPT…';
      location.href=j.redirect;
      return;
    }
    if(j.error){
      stopped=true;
      document.getElementById('status').textContent=j.error;
      return;
    }
    document.getElementById('status').textContent=j.message||'等待飞书授权…';
    setTimeout(poll,(j.interval||3)*1000);
  }catch(e){
    setTimeout(poll,3000);
  }
}
poll();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
