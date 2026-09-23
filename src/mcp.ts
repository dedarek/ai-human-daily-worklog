import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setupStore } from "./store.js";
import {
  beginFeishuAuthorization,
  captureManualNote,
  searchWorklog,
  setFeishuWikiTarget,
  syncAllManualNotes,
  updateManualNote,
} from "./manualNotes.js";

const server = new McpServer(
  { name: "worklog", version: "0.5.0" },
  {
    instructions:
      "Worklog is the user's personal memory and work archive. Use capture_note whenever the user asks to remember, save, log, keep, archive, or record something. Only content is required: do not force the user to choose a category, project, or tags. When context from the conversation is useful, summarize only the relevant context instead of copying the whole chat. Use search_notes to recall past notes or work evidence. Search before update_note if the target note ID is not already known.",
  },
);

const optionalText = (max: number) => z.string().trim().max(max).optional();

server.registerTool(
  "capture_note",
  {
    title: "Remember in Worklog",
    description:
      "Use this when the user wants to remember, save, keep, log, archive, or record something from the current conversation. This is intentionally flexible: content is the only required field. Infer project/type/tags only when obvious; never ask the user to classify a note just to save it.",
    inputSchema: {
      content: z.string().trim().min(1).max(8000).describe("A self-contained note containing what should be remembered."),
      context: optionalText(12000).describe("Optional concise context that will make the note understandable later. Do not paste the whole conversation."),
      project: optionalText(120).describe("Optional project or life area, only when clear from context."),
      kind: optionalText(60).describe("Optional free-form kind such as decision, idea, result, todo, learning, or life note."),
      tags: z.array(z.string().trim().min(1).max(50)).max(8).optional().describe("Optional lightweight tags; omit when they add no value."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async input => {
    const result = await captureManualNote(input);
    const sync = result.feishu.status === "synced"
      ? `并已同步到飞书：${result.feishu.url}`
      : `已本地保存；飞书状态：${result.feishu.status}`;
    return {
      structuredContent: result,
      content: [{ type: "text", text: `已记住（${result.note.id}）${sync}` }],
    };
  },
);

server.registerTool(
  "search_notes",
  {
    title: "Search Worklog",
    description:
      "Use this when the user wants to recall something previously saved in Worklog or find past work evidence, decisions, results, ideas, or notes.",
    inputSchema: {
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(20).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ query, limit }) => {
    const results = await searchWorklog(query, limit ?? 10);
    return {
      structuredContent: { query, results },
      content: [{ type: "text", text: results.length ? `找到 ${results.length} 条相关记录。` : "没有找到相关记录。" }],
    };
  },
);

server.registerTool(
  "update_note",
  {
    title: "Update a Worklog note",
    description:
      "Use this when the user wants to correct, extend, reclassify, or add follow-up information to a note already in Worklog. If the note ID is unknown, call search_notes first.",
    inputSchema: {
      id: z.string().trim().min(1).max(80),
      content: optionalText(8000),
      context: optionalText(12000),
      project: optionalText(120),
      kind: optionalText(60),
      tags: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ id, ...patch }) => {
    const result = await updateManualNote(id, patch);
    return {
      structuredContent: result,
      content: [{ type: "text", text: `已更新 ${id}；飞书状态：${result.feishu.status}` }],
    };
  },
);

server.registerTool(
  "connect_feishu",
  {
    title: "Connect Feishu",
    description:
      "Use this when Worklog reports that Feishu authorization is required. If authorization is needed, return the verification link to the user exactly as provided.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async () => {
    const result = await beginFeishuAuthorization();
    return {
      structuredContent: result,
      content: [{
        type: "text",
        text: result.status === "authorization_required"
          ? `请打开这个飞书授权链接完成验证：${result.verificationUrl}`
          : result.status === "ready" ? "飞书已经授权。" : `飞书还需要初始化：${result.error}`,
      }],
    };
  },
);

server.registerTool(
  "set_feishu_target",
  {
    title: "Set Feishu archive target",
    description:
      "Use this when the user provides the Feishu Wiki page that should contain Worklog notes. The page becomes the parent archive location.",
    inputSchema: { url: z.string().trim().min(1).max(1000) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ url }) => {
    const result = await setFeishuWikiTarget(url);
    return {
      structuredContent: result,
      content: [{ type: "text", text: `已绑定飞书知识库：${result.title}` }],
    };
  },
);

server.registerTool(
  "sync_notes_to_feishu",
  {
    title: "Sync Worklog notes to Feishu",
    description:
      "Use this after Feishu authorization or target setup to push locally saved Worklog notes to Feishu. Omit date to sync all note dates.",
    inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ date }) => {
    const results = await syncAllManualNotes(date);
    return {
      structuredContent: { results },
      content: [{ type: "text", text: `同步检查完成：${results.length} 个日期。` }],
    };
  },
);

await setupStore();
const transport = new StdioServerTransport();
await server.connect(transport);

