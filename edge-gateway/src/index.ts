// Private provider gateway. The existing Pixlings Node server remains the client.
interface Limiter { limit(input: { key: string }): Promise<{ success: boolean }> }
interface Env {
  GATEWAY_TOKEN?: string; SERPAPI_API_KEY?: string; GEMINI_API_KEY?: string;
  GEMINI_ENDPOINT?: string; GEMINI_MODEL?: string;
  SERP_LIMIT: Limiter; GEMINI_LIMIT: Limiter;
}
type Fetcher = typeof fetch;
type Json = Record<string, unknown>;
const MIB = 1024 * 1024;
const SEARCHES = new Set(['restaurant','taco truck','boba tea','bakery','cafe','coffee shop','board game cafe','bar','bookstore','farmers market','park','trail','scenic viewpoint','botanical garden','lake','museum','art gallery','mural','library','music venue']);
class GatewayError extends Error { readonly status: number; readonly code: string; constructor(status: number, code: string) { super(code); this.status = status; this.code = code; } }
function object(x: unknown): x is Json { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function response(status: number, data: unknown, id: string): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-ID': id, ...(status === 429 ? {'Retry-After':'60'} : {}) } });
}
async function readLimited(input: Request | Response, max: number): Promise<string> {
  const length = input.headers.get('content-length');
  if (length && Number(length) > max) throw new GatewayError(413, 'body_too_large');
  if (!input.body) return '';
  const reader = input.body.getReader(); const decoder = new TextDecoder();
  let total = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel(); throw new GatewayError(413, 'body_too_large'); }
      text += decoder.decode(value, {stream:true});
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
async function readJson(input: Request | Response, max: number): Promise<unknown> {
  const text = await readLimited(input, max);
  try { return JSON.parse(text); } catch { throw new GatewayError(400, 'invalid_json'); }
}
async function authorized(request: Request, token: string): Promise<boolean> {
  const supplied = request.headers.get('authorization') || '';
  if (!supplied.startsWith('Bearer ') || supplied.length > 512) return false;
  const bytes = new TextEncoder();
  const [a,b] = await Promise.all([crypto.subtle.digest('SHA-256',bytes.encode(supplied.slice(7))), crypto.subtle.digest('SHA-256',bytes.encode(token))]);
  const left = new Uint8Array(a), right = new Uint8Array(b); let diff = 0;
  for (let i=0;i<left.length;i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
function placesRequest(body: unknown, key: string): URL {
  if (!object(body) || typeof body.q !== 'string' || !SEARCHES.has(body.q) || typeof body.lat !== 'number' || typeof body.lng !== 'number' || !Number.isFinite(body.lat) || !Number.isFinite(body.lng) || Math.abs(body.lat)>90 || Math.abs(body.lng)>180) throw new GatewayError(400,'invalid_location_search');
  const u = new URL('https://serpapi.com/search.json');
  u.search = new URLSearchParams({engine:'google_maps',type:'search',q:body.q,ll:`@${body.lat},${body.lng},15z`,hl:'en',api_key:key}).toString();
  return u;
}
function geminiRequest(body: unknown): Json {
  if (!object(body) || !Array.isArray(body.contents) || body.contents.length !== 1) throw new GatewayError(400,'invalid_generation_request');
  const content = body.contents[0];
  if (!object(content) || content.role !== 'user' || !Array.isArray(content.parts) || content.parts.length < 1 || content.parts.length > 2) throw new GatewayError(400,'invalid_generation_request');
  let images = 0, texts = 0;
  const parts = content.parts.map((p: unknown) => {
    if (!object(p)) throw new GatewayError(400,'invalid_part');
    if (typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 100000 && !('inlineData' in p)) { texts++; return {text:p.text}; }
    const image = p.inlineData;
    if (object(image) && !('text' in p) && typeof image.mimeType === 'string' && ['image/jpeg','image/png','image/webp'].includes(image.mimeType) && typeof image.data === 'string' && image.data.length > 0 && image.data.length <= 12*MIB && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data) && image.data.length % 4 === 0) { images++; return {inlineData:{mimeType:image.mimeType,data:image.data}}; }
    throw new GatewayError(400,'invalid_part');
  });
  if (texts !== 1 || images > 1) throw new GatewayError(400,'invalid_parts');
  const config = body.generationConfig;
  if (!object(config) || config.responseMimeType !== 'application/json' || typeof config.temperature !== 'number' || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 1) throw new GatewayError(400,'invalid_generation_config');
  return {contents:[{role:'user',parts}],generationConfig:{responseMimeType:'application/json',temperature:config.temperature}};
}
function geminiUrl(env: Env, key: string): URL {
  const endpoint = env.GEMINI_ENDPOINT || (key.startsWith('AQ.')?'vertex':'studio');
  if (endpoint !== 'studio' && endpoint !== 'vertex') throw new GatewayError(503,'configuration_error');
  const model = env.GEMINI_MODEL || (endpoint === 'vertex'?'gemini-3-flash-preview':'gemini-2.5-flash');
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new GatewayError(503,'configuration_error');
  const url = new URL(endpoint === 'vertex' ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent` : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  url.searchParams.set('key',key); return url;
}
async function upstream(fetcher: Fetcher, url: URL, options: RequestInit, ms: number): Promise<unknown> {
  const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(),ms);
  try {
    const r = await fetcher(url,{...options,signal:controller.signal,redirect:'error',cache:'no-store'});
    if (!r.ok) { if (r.body) await r.body.cancel(); throw new GatewayError(r.status===429?429:502,r.status===429?'provider_rate_limited':'provider_error'); }
    let data: unknown;
    try { data = await readJson(r, 4*MIB); } catch(e) { if (controller.signal.aborted) throw e; throw new GatewayError(502,'invalid_provider_response'); }
    if (!object(data)) throw new GatewayError(502,'invalid_provider_response');
    return data;
  } catch (e) { if (controller.signal.aborted) throw new GatewayError(504,'provider_timeout'); if (e instanceof GatewayError) throw e; throw new GatewayError(502,'provider_unavailable'); }
  finally { clearTimeout(timer); }
}
export function createGateway(fetcher: Fetcher = fetch, timeouts = {serp:15000,gemini:30000}, logger: (entry: Json)=>void = e=>console.log(JSON.stringify(e))) {
  return {async fetch(request: Request, env: Env): Promise<Response> {
    const id = crypto.randomUUID(), start = Date.now();
    const path = new URL(request.url).pathname;
    const route = path === '/v1/places' ? 'places' : path === '/v1/generate' ? 'generate' : 'unknown';
    let status = 500, code = 'internal_error';
    try {
      if (path === '/health' && request.method === 'GET') { status=200; code='ok'; return response(200,{ok:true},id); }
      if (route === 'unknown') throw new GatewayError(404,'not_found');
      if (request.method !== 'POST') throw new GatewayError(405,'method_not_allowed');
      if (!env.GATEWAY_TOKEN || env.GATEWAY_TOKEN.length < 32) throw new GatewayError(503,'configuration_error');
      if (!await authorized(request,env.GATEWAY_TOKEN)) throw new GatewayError(401,'unauthorized');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new GatewayError(415,'unsupported_media_type');
      const body = await readJson(request, route==='places'?4096:14*MIB);
      const key = route==='places'?env.SERPAPI_API_KEY:env.GEMINI_API_KEY;
      if (!key) throw new GatewayError(503,'provider_not_configured');
      const url = route==='places'?placesRequest(body,key):geminiUrl(env,key);
      const payload = route==='generate'?geminiRequest(body):null;
      const limiter = route==='places'?env.SERP_LIMIT:env.GEMINI_LIMIT;
      if (!limiter) throw new GatewayError(503,'configuration_error');
      if (!(await limiter.limit({key:'pixlings-backend'})).success) throw new GatewayError(429,'rate_limited');
      const result = await upstream(fetcher,url,payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{method:'GET'},route==='places'?timeouts.serp:timeouts.gemini);
      status=200; code='ok'; return response(200,result,id);
    } catch (e) { const err = e instanceof GatewayError?e:new GatewayError(503,'gateway_unavailable'); status=err.status; code=err.code; return response(status,{ok:false,error:code},id); }
    finally { logger({event:'provider_gateway',request_id:id,route,status,code,duration_ms:Date.now()-start}); }
  }};
}
export default createGateway();
