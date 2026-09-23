import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { authChallenge, authContext, sessionFromRequest, withAuthContext } from '../../lib/auth-context.js';
import { captureNote, searchNotes, updateNote } from '../../lib/feishu.js';
import { originOf } from '../../lib/origin.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

const securitySchemes = [{ type: 'oauth2', scopes: ['worklog'] }];
const optionalText = (max) => z.string().trim().max(max).optional();

function requireSession() {
  const ctx = authContext();
  if (ctx.session) return { session: ctx.session };
  return {
    error: {
      isError: true,
      content: [{ type: 'text', text: '请先连接 Worklog 到飞书。' }],
      _meta: { 'mcp/www_authenticate': [authChallenge(ctx.origin)] },
    },
  };
}

const handler = createMcpHandler((server) => {
  server.registerTool(
    'capture_note',
    {
      title: 'Remember in Worklog',
      description: 'Use when the user asks to remember, save, keep, log, archive, or record something from the current conversation. Content is the only required field. Infer project, kind, and tags only when obvious; never force the user to classify a note just to save it.',
      inputSchema: z.object({
        content: z.string().trim().min(1).max(8000).describe('Self-contained note to remember.'),
        context: optionalText(12000).describe('Optional concise context needed to understand the note later. Never paste the whole conversation.'),
        project: optionalText(120).describe('Optional project or life area, only when clear.'),
        kind: optionalText(60).describe('Optional free-form kind such as decision, idea, result, todo, learning, or life note.'),
        tags: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
      }).strict(),
      securitySchemes,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const auth = requireSession();
      if (auth.error) return auth.error;
      try {
        const result = await captureNote(auth.session, input);
        return {
          structuredContent: result,
          content: [{ type: 'text', text: `已记住（${result.noteId}）。已写入飞书 Worklog。` }],
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `记录失败：${error.message}` }] };
      }
    }
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search Worklog',
      description: 'Use when the user wants to recall something previously saved in Worklog or find past work evidence, decisions, results, ideas, todos, or notes.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(20).optional(),
      }).strict(),
      securitySchemes,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const auth = requireSession();
      if (auth.error) return auth.error;
      try {
        const results = await searchNotes(auth.session, query, limit ?? 10);
        return {
          structuredContent: { query, results },
          content: [{ type: 'text', text: results.length ? `找到 ${results.length} 条相关记录。` : '没有找到相关记录。' }],
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `搜索失败：${error.message}` }] };
      }
    }
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update Worklog note',
      description: 'Use when the user wants to correct, extend, reclassify, or add follow-up information to a Worklog note. If the record ID is unknown, call search_notes first.',
      inputSchema: z.object({
        id: z.string().trim().min(1).max(120).describe('Feishu record ID returned by capture_note or search_notes.'),
        content: optionalText(8000),
        context: optionalText(12000),
        project: optionalText(120),
        kind: optionalText(60),
        tags: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
      }).strict(),
      securitySchemes,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, ...patch }) => {
      const auth = requireSession();
      if (auth.error) return auth.error;
      try {
        const result = await updateNote(auth.session, id, patch);
        return {
          structuredContent: result,
          content: [{ type: 'text', text: `已更新 ${id}。` }],
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `更新失败：${error.message}` }] };
      }
    }
  );

  server.registerTool(
    'profile',
    {
      title: 'Worklog profile',
      description: 'Return the Feishu identity connected to this Worklog account.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        nickname: z.string().optional(),
      }).strict(),
      securitySchemes,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'openai/profile': true },
    },
    async () => {
      const auth = requireSession();
      if (auth.error) return auth.error;
      const profile = {
        id: auth.session.openId || auth.session.baseToken,
        name: 'Feishu Worklog',
        nickname: 'Worklog',
      };
      return {
        structuredContent: profile,
        content: [{ type: 'text', text: JSON.stringify(profile) }],
      };
    }
  );
}, {}, {
  basePath: '/mcp',
  maxDuration: 60,
  verboseLogs: false,
});

async function run(request) {
  const origin = originOf(request);
  const session = sessionFromRequest(request, origin);
  return withAuthContext({ origin, session }, () => handler(request));
}

export { run as GET, run as POST, run as DELETE };
