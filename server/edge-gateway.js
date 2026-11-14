'use strict';
// Server-only client; never send the gateway token to the frontend.
function config(env = process.env) {
  const base = (env.PIXLINGS_GATEWAY_URL || '').trim();
  if (!base) return null;
  const token = (env.PIXLINGS_GATEWAY_TOKEN || '').trim();
  if (token.length < 32) throw new Error('PIXLINGS_GATEWAY_TOKEN must be at least 32 characters');
  const url = new URL(base);
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PIXLINGS_GATEWAY_URL must be an HTTPS origin (HTTP localhost allowed)');
  return {origin:url.origin,token};
}
function enabled(env = process.env) { return Boolean((env.PIXLINGS_GATEWAY_URL || '').trim()); }
async function call(route, payload, fetchWithTimeout, ms, env = process.env) {
  const c = config(env);
  if (!c) throw new Error('Gateway is not configured');
  if (!['/v1/places','/v1/generate'].includes(route)) throw new Error('Unknown gateway route');
  return fetchWithTimeout(c.origin + route, {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${c.token}`},body:JSON.stringify(payload),redirect:'error'},ms);
}
module.exports = {enabled, call};
