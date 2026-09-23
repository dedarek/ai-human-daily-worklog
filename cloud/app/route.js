export function GET(request) {
  const origin = new URL(request.url).origin;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Worklog</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f6f5f2;color:#171717;margin:0}.c{max-width:720px;margin:12vh auto;padding:38px;background:white;border-radius:22px;box-shadow:0 12px 45px #0001}h1{font-size:34px;margin:0 0 12px}p{line-height:1.7;color:#5b5b5b}code{background:#f1f1f1;padding:3px 7px;border-radius:6px}</style></head><body><main class="c"><h1>Worklog</h1><p>你的 ChatGPT → 飞书个人工作记忆插件。</p><p>连接后可以直接说：<code>@Worklog 记一下这个</code>、<code>@Worklog 我之前怎么想的？</code>。</p><p>MCP endpoint: <code>${origin}/mcp</code></p></main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
