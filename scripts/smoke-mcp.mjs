import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dataDir = await mkdtemp(join(tmpdir(), "worklog-mcp-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp.js"],
  env: { ...process.env, WORKLOG_DATA_DIR: dataDir, WORKLOG_DISABLE_BACKGROUND: "1" },
});
const client = new Client({ name: "worklog-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["capture_note", "search_notes", "update_note", "connect_feishu", "set_feishu_target", "sync_notes_to_feishu"]) {
    assert(names.includes(name), `missing tool: ${name}`);
  }

  const captured = await client.callTool({
    name: "capture_note",
    arguments: {
      content: "Authorization head is useful in Agent Security evaluations.",
      project: "Agent Security",
      kind: "decision",
    },
  });
  const captureText = JSON.stringify(captured);
  const id = captureText.match(/note-[0-9a-f]{8}/)?.[0];
  assert(id, "capture_note did not return a note id");

  const searched = await client.callTool({
    name: "search_notes",
    arguments: { query: "Authorization head" },
  });
  assert(JSON.stringify(searched).includes(id), "search_notes did not find captured note");

  await client.callTool({
    name: "update_note",
    arguments: {
      id,
      content: "Authorization head is useful and should be evaluated separately.",
    },
  });
  const raw = JSON.parse(await readFile(join(dataDir, "manual-notes.json"), "utf8"));
  assert.equal(raw[0].content, "Authorization head is useful and should be evaluated separately.");
  console.log("✓ Worklog MCP capture/search/update smoke test passed");
} finally {
  await client.close();
}

