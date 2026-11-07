# Fhitku reply worker

Cloudflare Workers backend for Facebook and Instagram customer-reply webhooks.
Prepared for deployment; no account is connected and both reply switches default
to false. Deploying this code alone does not activate customer replies.

## Browser deployment

In Cloudflare Workers & Pages, create a Worker by importing this GitHub repository.
Use the repository root, Worker name `fhitku-reply`, no build command, and deploy
command `npx wrangler deploy`. Keep the account on Workers Free.
Wrangler config includes a SQLite Durable Object migration. Review the deployment
screen and its permissions before approving the first deployment.

After deployment, add production secrets through the Worker settings:
`META_APP_SECRET`, `META_VERIFY_TOKEN`, `ADMIN_TOKEN`, `FACEBOOK_PAGE_TOKEN`,
and `INSTAGRAM_PAGE_TOKEN`. Fill allowlisted Page/account IDs and verify a current
Meta Graph API version. Never add production secrets to repository files.

The callback path is `/webhook`; `/health` is liveness only. Test signed events in
draft mode, complete Meta's required permissions/review, and review the drafts
before enabling `REPLIES_ENABLED` and then `COMMENTS_ENABLED`. App webhooks must
not replace callbacks serving unrelated integrations.

## Included behavior

- Verifies raw webhook signatures and durably stores/deduplicates accepted events.
- Uses Banglish templates directing price questions to https://fhitku.com.
- Keeps order details private and never invents an order, payment or shipment.
- Leaves collaboration requests silent and routes uncertainty to human review.
- Supports protected operator review, pause, consent-based resume and deletion.
- Stops uncertain sends from blindly retrying and observes response windows.

This starter uses no paid AI API. Free-tier quotas, latency and platform
availability limit operation. Unknown wording requires a human. Full Shopify order
creation, automatic spreadsheet writes and email notifications are not implemented.
The Shopify checker is read-only and is not connected to customer replies.

## Local checks

Use Node 22 or later. Run `npm ci`, `npm test`, and `npm run check`.
`npm run check:shopify` checks the existing app only when its credentials are
provided through process environment settings. It never creates an order.

The Workers runtime test uses the compatibility adapter exposed by the pinned
Miniflare version. Keep the lockfile and rerun tests before upgrades.
