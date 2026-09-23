import { originOf } from '../../../lib/origin.js';

export function GET(request) {
  const origin = originOf(request);
  return Response.json({
    issuer: origin,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['worklog'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
  }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
