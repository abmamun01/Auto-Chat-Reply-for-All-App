import {DAY, decide, normalize} from './policy.js';

const encoder = new TextEncoder();
const MAX_BODY = 262144;
const RETENTION = 7 * DAY;
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
export const eventKey = e => `e:${JSON.stringify([e.platform, e.account, e.kind, e.id])}`;
const pauseKey = e => `p:${JSON.stringify([e.platform, e.account, e.actor])}`;
async function updateExisting(storage, key, value) {
  return storage.transaction(async tx => {
    if (!(await tx.get(key))) return false;
    await tx.put(key, value);
    return true;
  });
}

async function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  const aa = new Uint8Array(x), bb = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export async function verifySignature(raw, signature, secret) {
  if (!secret || !/^sha256=[a-fA-F0-9]{64}$/.test(signature || '')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g), h => parseInt(h, 16));
  return crypto.subtle.verify('HMAC', key, bytes, raw);
}

async function limitedBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new Error('too_large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('too_large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ok: true});
    if (url.pathname === '/webhook' && request.method === 'GET') {
      if (!env.META_VERIFY_TOKEN) return json({error: 'not_configured'}, 503);
      const challenge = url.searchParams.get('hub.challenge');
      if (url.searchParams.get('hub.mode') !== 'subscribe' || !challenge || challenge.length > 200 ||
          !(await equal(url.searchParams.get('hub.verify_token'), env.META_VERIFY_TOKEN))) return json({error: 'forbidden'}, 403);
      return new Response(challenge, {headers: {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'}});
    }
    const isAdmin = url.pathname === '/admin/events' || url.pathname === '/admin/takeover' || url.pathname === '/admin/delete';
    if (isAdmin && (!env.ADMIN_TOKEN || !(await equal(request.headers.get('Authorization'), `Bearer ${env.ADMIN_TOKEN}`)))) return json({error: 'forbidden'}, 403);
    if (!isAdmin && !(url.pathname === '/webhook' && request.method === 'POST')) return json({error: 'not_found'}, 404);
    if (!env.INBOX || (!isAdmin && !env.META_APP_SECRET)) return json({error: 'not_configured'}, 503);
    try {
      if (isAdmin) {
        if (url.pathname === '/admin/events' && request.method !== 'GET') return json({error: 'method'}, 405);
        if (url.pathname !== '/admin/events' && request.method !== 'POST') return json({error: 'method'}, 405);
        const raw = await limitedBody(request);
        return env.INBOX.get(env.INBOX.idFromName('fhitku')).fetch(new Request(`https://inbox${url.pathname}${url.search}`, {
          method: request.method, ...(request.method !== 'GET' ? {body: raw} : {})
        }));
      }
      const raw = await limitedBody(request);
      if (!(await verifySignature(raw, request.headers.get('X-Hub-Signature-256'), env.META_APP_SECRET))) return json({error: 'forbidden'}, 403);
      const events = normalize(JSON.parse(new TextDecoder().decode(raw)), env);
      if (!events.length) return json({accepted: 0});
      // Await durable storage acknowledgement. No detached work that can vanish after HTTP 200.
      return await env.INBOX.get(env.INBOX.idFromName('fhitku')).fetch(new Request('https://inbox/ingest', {
        method: 'POST', body: JSON.stringify(events)
      }));
    } catch (error) {
      if (error.message === 'too_large') return json({error: 'too_large'}, 413);
      if (error instanceof SyntaxError || error.message === 'batch_limit') return json({error: 'invalid_payload'}, 400);
      // Storage failures get a retry from Meta; no customer data or secrets in logs/errors.
      return json({error: 'temporarily_unavailable'}, 503);
    }
  }
};

export class Inbox {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.running = null; }

  async fetch(request) {
    const url = new URL(request.url);
    const storage = this.ctx.storage;
    if (url.pathname === '/ingest') {
      const events = await request.json();
      await storage.transaction(async tx => {
        const count = (await tx.list({prefix: 'e:', limit: 1001})).size;
        let added = 0;
        for (const e of events) {
          const key = eventKey(e);
          if (await tx.get(key)) continue;
          if (count + ++added > 1000) throw new Error('capacity');
          // Human echo pauses immediately, unless it is a known message sent by this worker.
          if (e.human && !(await tx.get(`sent:${e.id}`))) await tx.put(pauseKey(e), {reason: 'human_activity'});
          const decision = decide(e);
          if (decision.pause && !e.human) await tx.put(pauseKey(e), {reason: decision.reason});
          await tx.put(key, {event: e, status: 'pending', receivedAt: Date.now()});
        }
        // Replacing a later cleanup alarm also wakes queued messages quickly.
        await tx.setAlarm(Date.now() + 100);
      });
      return json({accepted: events.length});
    }
    if (url.pathname === '/admin/events') {
      const cursor = url.searchParams.get('cursor');
      const rows = await storage.list({prefix: 'e:', limit: 100, ...(cursor ? {startAfter: cursor} : {})});
      const visible = [...rows].filter(([, v]) => Date.now() - v.receivedAt < RETENTION);
      return json({events: visible.map(([key, v]) => ({key, ...v})), next: rows.size === 100 ? [...rows.keys()].at(-1) : null});
    }
    if (url.pathname === '/admin/takeover' || url.pathname === '/admin/delete') {
      let body;
      try { body = await request.json(); } catch { return json({error: 'invalid_json'}, 400); }
      const {platform, account, actor} = body;
      if (!['facebook', 'instagram'].includes(platform) || account !== (platform === 'facebook' ? this.env.FACEBOOK_PAGE_ID : this.env.INSTAGRAM_ACCOUNT_ID) ||
        typeof actor !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(actor)) return json({error: 'invalid_scope'}, 400);
      await storage.transaction(async tx => {
        if (url.pathname === '/admin/delete') {
          await tx.put(pauseKey(body), {reason: 'deleted'});
          for (const [key, v] of await tx.list({prefix: 'e:', limit: 1000})) {
            if (v.event.platform === platform && v.event.account === account && v.event.actor === actor) await tx.delete(key);
          }
        } else if (body.paused === true) await tx.put(pauseKey(body), {reason: 'operator'});
        else if (body.paused === false && body.consentVerified === true) await tx.delete(pauseKey(body));
        else throw new Error('consent_required');
      }).catch(error => { if (error.message === 'consent_required') return null; throw error; });
      if (url.pathname === '/admin/takeover' && body.paused !== true && !(body.paused === false && body.consentVerified === true)) return json({error: 'consent_required'}, 400);
      return json({ok: true});
    }
    return json({error: 'not_found'}, 404);
  }

  async alarm() {
    // CF may retry alarms. Persist 'sending' before HTTP so ambiguous sends never auto-retry.
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  async drain() {
    const storage = this.ctx.storage;
    let processed = 0;
    for (const [key, row] of await storage.list({prefix: 'e:', limit: 1000})) {
      if (Date.now() - row.receivedAt >= RETENTION) { await storage.delete(key); continue; }
      if (row.status === 'sending') {
        await updateExisting(storage, key, {...row, status: 'uncertain', reason: 'interrupted_send'}); continue;
      }
      if (row.status !== 'pending') continue;
      if (processed++ >= 5) continue;
      const e = row.event;
      const d = decide(e);
      let reason = d.reason;
      let status = 'human';
      let shouldSend = !!d.reply && !e.human && !d.pause;
      if (await storage.get(pauseKey(e))) { shouldSend = false; reason = 'takeover'; }
      if (Date.now() - e.at >= DAY || e.at > Date.now() + 60000) { shouldSend = false; reason = 'window_expired'; }
      if (this.env.REPLIES_ENABLED !== 'true' || (e.kind === 'comment' && this.env.COMMENTS_ENABLED !== 'true')) {
        shouldSend = false; status = 'draft';
      }
      const update = {...row, reason, draft: d.reply || null, status};
      if (!shouldSend) { await updateExisting(storage, key, update); continue; }
      // Recheck after claim: operator takeover affects all queued future messages.
      if (!(await updateExisting(storage, key, {...update, status: 'sending'}))) continue;
      if (await storage.get(pauseKey(e))) { await updateExisting(storage, key, {...update, status: 'human', reason: 'takeover'}); continue; }
      try {
        const result = await sendMeta(e, d.reply, this.env);
        if (result.message_id || result.id) await storage.put(`sent:${result.message_id || result.id}`, {at: Date.now()});
        await updateExisting(storage, key, {...update, status: 'sent'});
        if (d.pauseAfter) await storage.put(pauseKey(e), {reason: 'order_details_pending'});
      } catch {
        // Never retry a network timeout: Meta may already have delivered the message.
        await updateExisting(storage, key, {...update, status: 'uncertain', reason: 'send_failed_or_unknown'});
        await storage.put(pauseKey(e), {reason: 'send_failed_or_unknown'});
      }
    }
    for (const [key, value] of await storage.list({prefix: 'sent:', limit: 1000})) {
      if (Date.now() - value.at >= RETENTION) await storage.delete(key);
    }
    // Ingestion may have added messages while a Meta request was in flight.
    // Check and rearm atomically so cleanup never overwrites an ingestion wake-up.
    await storage.transaction(async tx => {
      const rows = await tx.list({prefix: 'e:', limit: 1000});
      const pending = [...rows.values()].some(row => row.status === 'pending');
      await tx.setAlarm(Date.now() + (pending ? 100 : 3600000));
    });
  }
}

export async function sendMeta(e, text, env, fetcher = fetch) {
  const token = e.platform === 'facebook' ? env.FACEBOOK_PAGE_TOKEN : env.INSTAGRAM_PAGE_TOKEN;
  if (!token || !/^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || '')) throw new Error('not_configured');
  let path, body;
  if (e.kind === 'dm') {
    path = `${encodeURIComponent(e.account)}/messages`;
    body = {recipient: {id: e.actor}, message: {text}, ...(e.platform === 'facebook' ? {messaging_type: 'RESPONSE'} : {})};
  } else {
    if (e.id === '.' || e.id === '..') throw new Error('invalid_id');
    path = `${encodeURIComponent(e.id)}/${e.platform === 'facebook' ? 'comments' : 'replies'}`;
    body = {message: text};
  }
  const response = await fetcher(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${path}`, {
    method: 'POST', headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error'
  });
  if (!response.ok) throw new Error('meta_error');
  const result = await response.json();
  if (!result.message_id && !result.id) throw new Error('unknown_result');
  return result;
}
