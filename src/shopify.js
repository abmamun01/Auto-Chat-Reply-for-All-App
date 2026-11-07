// Read-only connection verification. Never returns or persists an access token.
export class ShopifyConnectionError extends Error {
  constructor(code) { super(code); this.name = 'ShopifyConnectionError'; this.code = code; }
}

export async function checkShopifyConnection(env, fetcher = fetch) {
  const domain = env.SHOPIFY_STORE_DOMAIN;
  const version = env.SHOPIFY_API_VERSION || '2026-10';
  if (domain !== 'v1gfk7-q0.myshopify.com') throw new ShopifyConnectionError('unexpected_store_domain');
  if (!/^20\d{2}-(01|04|07|10)$/.test(version)) throw new ShopifyConnectionError('invalid_api_version');
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new ShopifyConnectionError('missing_credentials');

  const request = async (path, init, errorCode) => {
    let response;
    try {
      response = await fetcher(`https://${domain}${path}`, {
        ...init, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000)
      });
    } catch { throw new ShopifyConnectionError('network_unavailable'); }
    if (!response.ok) throw new ShopifyConnectionError(errorCode);
    try { return await response.json(); } catch { throw new ShopifyConnectionError('invalid_response'); }
  };

  // Shopify's client-credentials flow is for apps installed on stores in the
  // same organization. Ineligible or uninstalled apps fail without fallback.
  const auth = await request('/admin/oauth/access_token', {
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET}).toString()
  }, 'authentication_failed');
  if (typeof auth.access_token !== 'string' || !auth.access_token || !Number.isFinite(auth.expires_in) || auth.expires_in <= 0) {
    throw new ShopifyConnectionError('invalid_token_response');
  }
  const data = await request(`/admin/api/${version}/graphql.json`, {
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': auth.access_token},
    body: JSON.stringify({query: 'query FhitkuConnectionCheck { shop { id myshopifyDomain primaryDomain { url } } currentAppInstallation { accessScopes { handle } } }'})
  }, 'api_access_failed');
  if (data.errors?.length || !data.data?.shop || !Array.isArray(data.data.currentAppInstallation?.accessScopes)) {
    throw new ShopifyConnectionError('shop_query_failed');
  }
  const {shop, currentAppInstallation} = data.data;
  if (shop.myshopifyDomain !== domain || typeof shop.id !== 'string' || !shop.id.startsWith('gid://shopify/Shop/')) {
    throw new ShopifyConnectionError('store_identity_mismatch');
  }
  let storefront;
  try { storefront = new URL(shop.primaryDomain.url); } catch { throw new ShopifyConnectionError('invalid_storefront'); }
  if (storefront.protocol !== 'https:' || !['fhitku.com', 'www.fhitku.com'].includes(storefront.hostname) || storefront.port) {
    throw new ShopifyConnectionError('storefront_identity_mismatch');
  }
  const scopes = currentAppInstallation.accessScopes.map(s => s.handle).filter(s => typeof s === 'string');
  return {
    authenticated: true, shopDomain: domain, storefront: storefront.origin, apiVersion: version,
    grantedScopes: scopes, hasOrderWriteScope: scopes.includes('write_orders'), tokenExpiresInSeconds: auth.expires_in,
    orderPlacementVerified: false, ordersCreated: 0
  };
}
