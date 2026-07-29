import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { callModel } from "../src/llm.js";
import { defaults } from "../src/store.js";

async function withModelServer(handler: Parameters<typeof createServer>[0], run: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("Anthropic-compatible requests use the cross-platform fetch transport", async () => {
  await withModelServer((request, response) => {
    assert.equal(request.url, "/v1/messages");
    assert.equal(request.headers["x-api-key"], "test-key");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ content: [{ type: "text", text: "anthropic ok" }] }));
  }, async baseUrl => {
    const output = await callModel("hello", { ...defaults, llmProtocol: "anthropic", llmBaseUrl: baseUrl }, { llmApiKey: "test-key" });
    assert.equal(output, "anthropic ok");
  });
});

test("OpenAI-compatible streaming responses are assembled", async () => {
  await withModelServer((request, response) => {
    assert.equal(request.url, "/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-key");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"open"}}]}\n\ndata: {"choices":[{"delta":{"content":"ai ok"}}]}\n\ndata: [DONE]\n\n');
  }, async baseUrl => {
    const output = await callModel("hello", { ...defaults, llmProtocol: "openai", llmBaseUrl: baseUrl }, { llmApiKey: "test-key" });
    assert.equal(output, "openai ok");
  });
});
