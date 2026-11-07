import test from 'node:test';
import assert from 'node:assert/strict';
import {checkShopifyConnection} from '../src/shopify.js';

const env = {SHOPIFY_STORE_DOMAIN: 'v1gfk7-q0.myshopify.com', SHOPIFY_CLIENT_ID: 'synthetic-client', SHOPIFY_CLIENT_SECRET: 'synthetic-secret'};
const response = (scopes = ['read_products', 'write_orders']) => ({data: {
  shop: {id: 'gid://shopify/Shop/123', myshopifyDomain: env.SHOPIFY_STORE_DOMAIN, primaryDomain: {url: 'https://fhitku.com'}},
  currentAppInstallation: {accessScopes: scopes.map(handle => ({handle}))}
}});
const auth = () => Response.json({access_token: 'synthetic-access-token', expires_in: 86399});

test('authenticates on exact store, makes only a read-only query, and returns no token', async () => {
  const calls = [];
  const result = await checkShopifyConnection(env, async (url, init) => {
    calls.push({url, init}); return calls.length === 1 ? auth() : Response.json(response());
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://v1gfk7-q0.myshopify.com/admin/oauth/access_token');
  assert.equal(new URLSearchParams(calls[0].init.body).get('grant_type'), 'client_credentials');
  assert.equal(calls[1].init.headers['X-Shopify-Access-Token'], 'synthetic-access-token');
  assert.match(JSON.parse(calls[1].init.body).query, /^query /);
  assert.equal(result.authenticated, true); assert.equal(result.hasOrderWriteScope, true);
  assert.equal(result.orderPlacementVerified, false); assert.equal(result.ordersCreated, 0);
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
  for (const c of calls) { assert.equal(c.init.redirect, 'error'); assert.ok(c.init.signal); assert.doesNotMatch(c.url, /synthetic/); }
});
test('missing configuration and an unexpected hostname make no network requests', async () => {
  let calls = 0; const fetcher = () => { calls++; throw new Error(); };
  for (const config of [{...env, SHOPIFY_CLIENT_SECRET: ''}, {...env, SHOPIFY_STORE_DOMAIN: 'other.myshopify.com'}, {...env, SHOPIFY_API_VERSION: '../bad'}]) {
    await assert.rejects(checkShopifyConnection(config, fetcher));
  }
  assert.equal(calls, 0);
});
test('network and authentication errors are sanitized', async () => {
  await assert.rejects(checkShopifyConnection(env, async () => { throw new Error('synthetic-secret'); }), {message: 'network_unavailable'});
  await assert.rejects(checkShopifyConnection(env, async () => new Response('synthetic-secret', {status: 401})), {message: 'authentication_failed'});
});
test('permission checks distinguish a theme-only app from an order integration', async () => {
  let n = 0;
  const result = await checkShopifyConnection(env, async () => ++n === 1 ? auth() : Response.json(response(['write_themes'])));
  assert.equal(result.hasOrderWriteScope, false); assert.equal(result.orderPlacementVerified, false);
});
test('rejects invalid tokens, GraphQL errors and store identity mismatches', async () => {
  await assert.rejects(checkShopifyConnection(env, async () => Response.json({access_token: 'test'})), {message: 'invalid_token_response'});
  for (const mutate of [
    d => { d.errors = [{message: 'private-server-detail'}]; },
    d => { d.data.shop.myshopifyDomain = 'different.myshopify.com'; },
    d => { d.data.shop.primaryDomain.url = 'https://different.example'; },
    d => { d.data.shop.primaryDomain.url = 'https://fhitku.com:8443'; }
  ]) {
    let n = 0; const d = response(); mutate(d);
    await assert.rejects(checkShopifyConnection(env, async () => ++n === 1 ? auth() : Response.json(d)));
  }
});
