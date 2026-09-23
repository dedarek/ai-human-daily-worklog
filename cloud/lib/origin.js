export function originOf(request) {
  const forwarded = request.headers.get('x-forwarded-host');
  const host = forwarded || request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  if (!host) return new URL(request.url).origin;
  return `${proto}://${host}`;
}
