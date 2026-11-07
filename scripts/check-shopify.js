import {checkShopifyConnection, ShopifyConnectionError} from '../src/shopify.js';

try {
  const result = await checkShopifyConnection({
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN || 'v1gfk7-q0.myshopify.com',
    SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || '2026-10',
    SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({verified: false, error: error instanceof ShopifyConnectionError ? error.code : 'connection_check_failed'}) + '\n');
  process.exitCode = 1;
}
