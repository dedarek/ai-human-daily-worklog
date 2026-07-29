import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { localSecurity } from "../src/security.js";

test("local API rejects cross-origin and unmarked writes", async () => {
  const app = express(); app.disable("x-powered-by"); app.use(localSecurity); app.use(express.json());
  app.post("/api/change", (_request, response) => response.json({ ok: true }));
  app.get("/api/status", (_request, response) => response.json({ ok: true }));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
    const base = `http://127.0.0.1:${address.port}`;
    const normal = await fetch(`${base}/api/status`);
    assert.equal(normal.status, 200); assert.match(normal.headers.get("content-security-policy") || "", /default-src 'self'/); assert.equal(normal.headers.get("x-powered-by"), null);
    assert.equal((await fetch(`${base}/api/change`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/change`, { method: "POST", headers: { "Content-Type": "application/json", "X-Worklog-Request": "1", Origin: "https://attacker.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/change`, { method: "POST", headers: { "Content-Type": "application/json", "X-Worklog-Request": "1" }, body: "{}" })).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
