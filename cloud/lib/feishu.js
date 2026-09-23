import { randomUUID } from 'node:crypto';

const ACCOUNTS = 'https://accounts.feishu.cn';
const OPEN = 'https://open.feishu.cn';
const REGISTRATION = `${ACCOUNTS}/oauth/v1/app/registration`;
const TOKEN = `${ACCOUNTS}/oauth/v3/token`;
const API = `${OPEN}/open-apis`;

function stringAt(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = stringAt(child, keys, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

async function readJSON(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Feishu returned non-JSON HTTP ${response.status}`); }
  if (!response.ok || body.error || (typeof body.code === 'number' && body.code !== 0)) {
    const message = body.error_description || body.msg || body.error || `HTTP ${response.status}`;
    const error = new Error(`Feishu API: ${message}`);
    error.details = body;
    throw error;
  }
  return body;
}

async function api(path, token, { method = 'GET', body, query } = {}) {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await readJSON(response);
  return envelope.data ?? envelope;
}

export async function beginPersonalAgentRegistration() {
  const form = new URLSearchParams({
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id tenant_brand',
  });
  const response = await fetch(REGISTRATION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = await readJSON(response);
  const userCode = body.user_code;
  if (!body.device_code || !userCode) throw new Error('Feishu app registration did not return a device code.');
  return {
    deviceCode: body.device_code,
    interval: Math.max(2, Number(body.interval) || 5),
    expiresIn: Number(body.expire_in || body.expires_in) || 600,
    verificationUrl: `${OPEN}/page/cli?user_code=${encodeURIComponent(userCode)}&from=cli`,
  };
}

export async function pollPersonalAgentRegistration(deviceCode) {
  const form = new URLSearchParams({ action: 'poll', device_code: deviceCode });
  const response = await fetch(REGISTRATION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Feishu registration returned non-JSON HTTP ${response.status}`); }
  if (body.error === 'authorization_pending' || body.error === 'slow_down') {
    return { status: 'pending', slowDown: body.error === 'slow_down' };
  }
  if (body.error === 'access_denied') return { status: 'denied' };
  if (body.error === 'expired_token' || body.error === 'invalid_grant') return { status: 'expired' };
  if (!response.ok || body.error) throw new Error(body.error_description || body.error || `HTTP ${response.status}`);
  if (!body.client_id || !body.client_secret) return { status: 'pending' };
  return {
    status: 'ready',
    appId: body.client_id,
    appSecret: body.client_secret,
    openId: body.user_info?.open_id || '',
    brand: body.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu',
  };
}

export async function tenantToken(appId, appSecret) {
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appSecret,
  });
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = await readJSON(response);
  const token = body.access_token;
  if (!token) throw new Error('Feishu did not return a tenant access token.');
  return token;
}

const NOTE_FIELDS = [
  { name: 'Note ID', type: 'text' },
  { name: 'Content', type: 'text' },
  { name: 'Context', type: 'text' },
  { name: 'Project', type: 'text' },
  { name: 'Kind', type: 'text' },
  { name: 'Tags', type: 'text' },
  { name: 'Created At', type: 'text' },
  { name: 'Updated At', type: 'text' },
];

export async function createWorklogStore({ appId, appSecret, openId }) {
  const token = await tenantToken(appId, appSecret);
  const createdBase = await api('/base/v3/bases', token, {
    method: 'POST',
    body: { name: 'Worklog', time_zone: 'Asia/Shanghai' },
  });
  const baseToken = stringAt(createdBase, ['app_token', 'base_token']);
  if (!baseToken) throw new Error('Feishu Base creation returned no app_token.');

  const createdTable = await api(`/base/v3/bases/${encodeURIComponent(baseToken)}/tables`, token, {
    method: 'POST',
    body: { name: 'Notes', fields: NOTE_FIELDS },
  });
  const tableId = stringAt(createdTable, ['table_id', 'id']);
  if (!tableId) throw new Error('Feishu table creation returned no table_id.');

  if (openId) {
    await api(`/drive/v1/permissions/${encodeURIComponent(baseToken)}/members`, token, {
      method: 'POST',
      query: { need_notification: false, type: 'bitable' },
      body: { member_type: 'openid', member_id: openId, perm: 'full_access', type: 'user' },
    }).catch(() => null);
  }

  const returnedUrl = stringAt(createdBase, ['url']);
  return {
    baseToken,
    tableId,
    baseUrl: returnedUrl || `https://www.feishu.cn/base/${baseToken}`,
  };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return '';
  return [...new Set(tags.map(v => String(v).trim()).filter(Boolean))].slice(0, 8).join(', ');
}

function noteFields(input, existing = {}) {
  const now = new Date().toISOString();
  const fields = { ...existing };
  if ('content' in input) fields.Content = input.content?.trim() || '';
  if ('context' in input) fields.Context = input.context?.trim() || '';
  if ('project' in input) fields.Project = input.project?.trim() || '';
  if ('kind' in input) fields.Kind = input.kind?.trim() || '';
  if ('tags' in input) fields.Tags = normalizeTags(input.tags);
  fields['Updated At'] = now;
  return fields;
}

export async function captureNote(session, input) {
  const token = await tenantToken(session.appId, session.appSecret);
  const noteId = `note-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const fields = noteFields(input, { 'Note ID': noteId, 'Created At': now });
  const data = await api(`/base/v3/bases/${encodeURIComponent(session.baseToken)}/tables/${encodeURIComponent(session.tableId)}/records`, token, {
    method: 'POST', body: { fields },
  });
  const recordId = stringAt(data, ['record_id', 'id']);
  return { id: recordId || noteId, noteId, fields, baseUrl: session.baseUrl };
}

function recordsFrom(data) {
  const candidates = [data?.items, data?.records, data?.data?.items, data?.data?.records];
  return candidates.find(Array.isArray) || [];
}

export async function searchNotes(session, query, limit = 10) {
  const token = await tenantToken(session.appId, session.appSecret);
  const data = await api(`/base/v3/bases/${encodeURIComponent(session.baseToken)}/tables/${encodeURIComponent(session.tableId)}/records/search`, token, {
    method: 'POST',
    body: {
      keyword: query.trim(),
      search_fields: ['Content', 'Context', 'Project', 'Kind', 'Tags', 'Note ID'],
      offset: 0,
      limit: Math.min(20, Math.max(1, limit)),
    },
  });
  return recordsFrom(data).map(record => ({
    id: record.record_id || record.id,
    fields: record.fields || {},
    baseUrl: session.baseUrl,
  }));
}

export async function updateNote(session, recordId, patch) {
  const token = await tenantToken(session.appId, session.appSecret);
  const fields = noteFields(patch);
  const data = await api(`/base/v3/bases/${encodeURIComponent(session.baseToken)}/tables/${encodeURIComponent(session.tableId)}/records/${encodeURIComponent(recordId)}`, token, {
    method: 'PATCH', body: { fields },
  });
  return { id: stringAt(data, ['record_id', 'id']) || recordId, fields, baseUrl: session.baseUrl };
}
