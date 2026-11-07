import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

test('real Workers runtime persists signed webhook, deduplicates, and produces a disabled draft', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({workers: [{name: 'test', modules: [
    {type: 'ESModule', path: 'src/worker.js'}, {type: 'ESModule', path: 'src/policy.js'}
  ], compatibilityDate: '2026-11-06',
    durableObjects: {INBOX: {className: 'Inbox', useSQLite: true}},
    bindings: {META_APP_SECRET: 'local-secret', META_VERIFY_TOKEN: 'local-verify', ADMIN_TOKEN: 'local-admin', FACEBOOK_PAGE_ID: 'page-test', REPLIES_ENABLED: 'false'}}]}));
  try {
    assert.equal((await mf.dispatchFetch('https://local/health')).status, 200);
    const body = JSON.stringify({object: 'page', entry: [{id: 'page-test', messaging: [{sender: {id: 'person'}, recipient: {id: 'page-test'}, timestamp: Date.now(), message: {mid: 'runtime-1', text: 'price koto?'}}]}]});
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('local-secret'), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const signature = 'sha256=' + [...new Uint8Array(mac)].map(x => x.toString(16).padStart(2, '0')).join('');
    for (let i = 0; i < 2; i++) {
      const response = await mf.dispatchFetch('https://local/webhook', {method: 'POST', body, headers: {'X-Hub-Signature-256': signature}});
      assert.equal(response.status, 200, await response.text());
    }
    let rows;
    for (let i = 0; i < 30; i++) {
      rows = await (await mf.dispatchFetch('https://local/admin/events', {headers: {Authorization: 'Bearer local-admin'}})).json();
      if (rows.events[0]?.status === 'draft') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(rows.events.length, 1); assert.equal(rows.events[0].status, 'draft');
    assert.match(rows.events[0].draft, /https:\/\/fhitku.com/);
    assert.equal((await mf.dispatchFetch('https://local/admin/events')).status, 403);
  } finally { await mf.dispose(); }
});
