// Order relay: receives WooCommerce "Order updated" webhooks and starts the
// WooCommerce → Salesforce sync on GitHub Actions right away.
// Hosted on Vercel (Root Directory: relay). No npm dependencies.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   WC_WEBHOOK_SECRET  the Secret typed into the WooCommerce webhook
//   GITHUB_TOKEN       fine-grained token for Segaadam/WooSFAgent, Contents: Read and write

import { createHmac, timingSafeEqual } from 'node:crypto';

const REPO = 'Segaadam/WooSFAgent';
const EVENT_TYPE = 'woo-order'; // must match repository_dispatch types in main.yml

// Only paid orders are synced.
const PAID_STATUSES = ['processing', 'completed'];

// Order fields the sync itself writes. If an order already has one, it has been
// synced (or has failed and will be retried by the hourly backup run), so the
// update that the sync's own write causes does not start yet another run.
const SYNC_KEYS = ['sf_asset_created', 'sf_store_synced', 'sf_sync_attempts', 'sf_store_sync_attempts'];

const reply = (status, message) => new Response(message, { status, headers: { 'Content-Type': 'text/plain' } });

function validSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request) {
  const rawBody = await request.text();

  // WooCommerce sends "webhook_id=N" once when the webhook is saved, to check the URL.
  if (/^webhook_id=\d+$/.test(rawBody.trim())) return reply(200, 'ping ok');

  if (!validSignature(rawBody, request.headers.get('x-wc-webhook-signature'), process.env.WC_WEBHOOK_SECRET)) {
    return reply(401, 'invalid signature');
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return reply(400, 'invalid JSON');
  }

  const keys = new Set((order.meta_data || []).map((m) => m.key));
  if (!PAID_STATUSES.includes(order.status)) return reply(200, `skipped: status ${order.status}`);
  if (SYNC_KEYS.some((k) => keys.has(k))) return reply(200, 'skipped: already handled by the sync');

  const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'woo-order-relay',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: EVENT_TYPE, client_payload: { order: order.id } }),
  });

  if (res.status !== 204) {
    const text = (await res.text()).slice(0, 300);
    console.error(`GitHub dispatch failed for order ${order.id}: ${res.status} ${text}`);
    return reply(502, `GitHub dispatch failed: ${res.status}`);
  }
  console.log(`Started sync for order ${order.id}`);
  return reply(200, `sync started for order ${order.id}`);
}

// A browser visit to the URL just confirms the relay is up.
export function GET() {
  return reply(200, 'WooCommerce order relay is running');
}
