import { originOf } from '../../../lib/origin.js';

export function GET(request) {
  const origin = originOf(request);
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ['worklog'],
    resource_documentation: `${origin}/`,
  }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
