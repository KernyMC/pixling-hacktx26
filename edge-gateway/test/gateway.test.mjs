import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/index.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const client = require('../../server/edge-gateway.js');
const TOKEN = 'test-token-not-a-real-secret-1234567890';
const env = (overrides = {}) => ({GATEWAY_TOKEN:TOKEN,SERPAPI_API_KEY:'fake-serp',GEMINI_API_KEY:'fake-gemini',SERP_LIMIT:{limit:async()=>({success:true})},GEMINI_LIMIT:{limit:async()=>({success:true})},...overrides});
const places = {q:'restaurant',lat:30.28,lng:-97.74};
const generation = {contents:[{role:'user',parts:[{text:'quest prompt'}]}],generationConfig:{temperature:0.4,responseMimeType:'application/json'}};
const req = (route,body,headers={})=>new Request('https://gateway.test'+route,{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
function fixture(fetcher=async()=>Response.json({local_results:[]}),timeouts={serp:1000,gemini:1000}) {
  const logs=[]; return {gateway:createGateway(fetcher,timeouts,e=>logs.push(e)),logs};
}
test('places forwards only a fixed provider URL with server credential',async()=>{
  let calls=0; const {gateway,logs}=fixture(async (url,opts)=>{calls++;assert.equal(url.hostname,'serpapi.com');assert.equal(url.searchParams.get('q'),'restaurant');assert.equal(url.searchParams.get('api_key'),'fake-serp');assert.equal(opts.redirect,'error');return Response.json({local_results:[{title:'A cafe'}]});});
  const r=await gateway.fetch(req('/v1/places',places),env());assert.equal(r.status,200);assert.equal((await r.json()).local_results[0].title,'A cafe');assert.equal(calls,1);assert.equal(r.headers.get('cache-control'),'no-store');assert.ok(r.headers.get('x-request-id'));assert.equal(logs[0].status,200);assert.ok(!JSON.stringify(logs).includes('fake-serp'));assert.ok(!JSON.stringify(logs).includes('30.28'));
});
test('Gemini sends fixed model and sanitized payload without user secrets',async()=>{
  const {gateway,logs}=fixture(async(url,opts)=>{assert.equal(url.hostname,'generativelanguage.googleapis.com');assert.equal(url.searchParams.get('key'),'fake-gemini');assert.deepEqual(JSON.parse(opts.body),generation);return Response.json({candidates:[{content:{parts:[{text:'{}'}]}}]});});
  const r=await gateway.fetch(req('/v1/generate',{...generation,model:'untrusted',other:'ignored'}),env());assert.equal(r.status,200);assert.equal((await r.json()).candidates.length,1);assert.ok(!JSON.stringify(logs).includes('quest prompt'));
});
test('Gemini accepts the image shape used by Pixlings',async()=>{
  const image={inlineData:{mimeType:'image/png',data:'YWJj'}}; const body={...generation,contents:[{role:'user',parts:[{text:'proof'},image]}]};
  const {gateway}=fixture(async(url,opts)=>{assert.deepEqual(JSON.parse(opts.body).contents[0].parts[1],image);return Response.json({candidates:[]});});assert.equal((await gateway.fetch(req('/v1/generate',body),env())).status,200);
});
test('rejects unauthorized, missing secret, wrong route/method/content type',async()=>{
  const {gateway}=fixture(async()=>{assert.fail('unexpected upstream call');});
  assert.equal((await gateway.fetch(req('/v1/places',places,{Authorization:'Bearer wrong'}),env())).status,401);
  assert.equal((await gateway.fetch(req('/v1/places',places),env({GATEWAY_TOKEN:undefined}))).status,503);
  assert.equal((await gateway.fetch(req('/proxy',places),env())).status,404);
  assert.equal((await gateway.fetch(new Request('https://gateway.test/v1/places'),env())).status,405);
  assert.equal((await gateway.fetch(req('/v1/places',places,{'Content-Type':'text/plain'}),env())).status,415);
});
test('rejects invalid JSON, invalid coordinates, unsupported search and oversized body',async()=>{
  const {gateway}=fixture(async()=>{assert.fail('unexpected upstream call');});
  for(const body of ['{', {...places,lat:91},{...places,q:'arbitrary query'}, {...places,lat:'30.28'}]) assert.equal((await gateway.fetch(req('/v1/places',body),env())).status,400);
  assert.equal((await gateway.fetch(req('/v1/places','x'.repeat(5000)),env())).status,413);
});
test('rejects malformed generation content',async()=>{
  const {gateway}=fixture(async()=>{assert.fail('unexpected upstream call');});
  for(const body of [{}, {...generation,contents:[{role:'system',parts:[{text:'bad'}]}]}, {...generation,contents:[{role:'user',parts:[{inlineData:{mimeType:'image/svg+xml',data:'YWJj'}}]}]}, {...generation,generationConfig:{temperature:2,responseMimeType:'application/json'}}]) assert.equal((await gateway.fetch(req('/v1/generate',body),env())).status,400);
});
test('rate limiting fails closed before provider call',async()=>{
  const {gateway}=fixture(async()=>{assert.fail('unexpected upstream call');});const r=await gateway.fetch(req('/v1/places',places),env({SERP_LIMIT:{limit:async()=>({success:false})}}));assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');assert.equal((await r.json()).error,'rate_limited');
  assert.equal((await gateway.fetch(req('/v1/places',places),env({SERP_LIMIT:undefined}))).status,503);
});
test('maps provider failures without leaking error bodies',async()=>{
  for(const [upstream,status] of [[429,429],[401,502],[500,502]]) {const {gateway,logs}=fixture(async()=>new Response('secret upstream failure',{status:upstream}));const r=await gateway.fetch(req('/v1/places',places),env());assert.equal(r.status,status);assert.ok(!(await r.text()).includes('secret'));assert.ok(!JSON.stringify(logs).includes('secret'));}
  const {gateway}=fixture(async()=>new Response('not JSON'));assert.equal((await gateway.fetch(req('/v1/places',places),env())).status,502);
});
test('aborts a stalled provider call',async()=>{
  const {gateway}=fixture(async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})),{serp:10,gemini:10});const r=await gateway.fetch(req('/v1/places',places),env());assert.equal(r.status,504);assert.equal((await r.json()).error,'provider_timeout');
});
test('Node client is opt-in, sends server authentication, rejects unsafe configuration',async()=>{
  assert.equal(client.enabled({}),false);
  const config={PIXLINGS_GATEWAY_URL:'https://gateway.test',PIXLINGS_GATEWAY_TOKEN:TOKEN};
  const result=await client.call('/v1/places',places,async(url,opts,ms)=>{assert.equal(url,'https://gateway.test/v1/places');assert.equal(opts.headers.Authorization,'Bearer '+TOKEN);assert.equal(opts.redirect,'error');assert.equal(ms,16000);assert.deepEqual(JSON.parse(opts.body),places);return Response.json({ok:true});},16000,config);assert.equal(result.status,200);
  await assert.rejects(client.call('/v1/places',places,fetch,1000,{...config,PIXLINGS_GATEWAY_URL:'http://remote.test'}));
  await assert.rejects(client.call('/v1/places',places,fetch,1000,{...config,PIXLINGS_GATEWAY_TOKEN:'short'}));
  await assert.rejects(client.call('/unknown',places,fetch,1000,config));
});
test('Node client and Worker interoperate with unchanged provider response shape',async()=>{
  const {gateway}=fixture(async()=>Response.json({local_results:[{title:'Cafe'}]}));
  const config={PIXLINGS_GATEWAY_URL:'https://gateway.test',PIXLINGS_GATEWAY_TOKEN:TOKEN};
  const r=await client.call('/v1/places',places,(url,options)=>gateway.fetch(new Request(url,options),env()),20000,config);
  assert.equal(r.status,200);assert.equal((await r.json()).local_results[0].title,'Cafe');
});
