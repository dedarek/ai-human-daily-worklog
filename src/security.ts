import type { NextFunction, Request, Response } from "express";

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function localAuthority(value: string | undefined) {
  if (!value) return false;
  try { return localHosts.has(new URL(`http://${value}`).hostname); }
  catch { return false; }
}

function localOrigin(value: string | undefined) {
  if (!value) return true;
  try { return localHosts.has(new URL(value).hostname); }
  catch { return false; }
}

export function localSecurity(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");

  if (!localAuthority(req.headers.host) || !localOrigin(req.headers.origin)) {
    return res.status(403).json({ error: "请求来源不受信任。" });
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    if (req.get("X-Worklog-Request") !== "1") return res.status(403).json({ error: "缺少 Worklog 请求标记。" });
    if (!req.is("application/json")) return res.status(415).json({ error: "仅接受 application/json 请求。" });
  }
  next();
}

export function jsonErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message = error instanceof SyntaxError ? "请求 JSON 格式无效。" : "本地服务处理请求失败。";
  if (!res.headersSent) res.status(error instanceof SyntaxError ? 400 : 500).json({ error: message });
}
