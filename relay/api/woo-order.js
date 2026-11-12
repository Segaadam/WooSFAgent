// Order relay: receives WooCommerce "Order updated" webhooks and starts, right away on GitHub Actions:
//   1. the WooCommerce → Salesforce sync (Segaadam/WooSFAgent), and
//   2. the BFA → Knowledge Link enrollment (Segaadam/BFA-LMS-Enroll), for orders containing a BFA package.
// Hosted on Vercel (Root Directory: relay). No npm dependencies.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
// WC_WEBHOOK_SECRET the Secret typed into the WooCommerce webhook
// GITHUB_TOKEN fine-grained token with Contents: Read and write on
//              Segaadam/WooSFAgent AND Segaadam/BFA-LMS-Enroll

import { createHmac, timingSafeEqual } from 'node:crypto';

const EVENT_TYPE = 'woo-order'; // must match repository_dispatch types in each repo's workflow

// Only paid orders are handled.
const PAID_STATUSES = ['processing', 'completed'];

// 1. Salesforce sync. Order fields the sync itself writes. If an order already has one, it has been
// synced (or has failed and will be retried by the backup run), so the update that the sync's own
// write causes does not start yet another run.
const SF_REPO = 'Segaadam/WooSFAgent';
const SF_KEYS = ['sf_asset_created', 'sf_store_synced', 'sf_sync_attempts', 'sf_store_sync_attempts'];

// 2. Knowledge Link enrollment: only orders with a BFA package, and only until the enrollment
// agent has stamped the order.
const LMS_REPO = 'Segaadam/BFA-LMS-Enroll';
const LMS_KEY = 'bfa_lms_enrolled';
const BFA_PRODUCT_IDS = [2139, 2140, 2141];

const reply = (status, message) => new Response(message, { status, headers: { 'Content-Type': 'text/plain' } });

function validSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function dispatch(repo, orderId) {
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'woo-order-relay',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: EVENT_TYPE, client_payload: { order: orderId } }),
  });
  if (res.status === 204) {
    console.log(`Started ${repo} for order ${orderId}`);
    return `${repo}: started`;
  }
  const text = (await res.text()).slice(0, 300);
  console.error(`GitHub dispatch to ${repo} failed for order ${orderId}: ${res.status} ${text}`);
  throw new Error(`${repo}: dispatch failed (${res.status})`);
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

  if (!PAID_STATUSES.includes(order.status)) return reply(200, `skipped: status ${order.status}`);

  const keys = new Set((order.meta_data || []).map((m) => m.key));
  const hasBfa = (order.line_items || []).some((li) => BFA_PRODUCT_IDS.includes(Number(li.product_id)));

  const jobs = [];
  if (!SF_KEYS.some((k) => keys.has(k))) jobs.push(dispatch(SF_REPO, order.id));
  if (hasBfa && !keys.has(LMS_KEY)) jobs.push(dispatch(LMS_REPO, order.id));
  if (!jobs.length) return reply(200, 'skipped: already handled');

  // Run both; one failing does not stop the other. Only a failed Salesforce start is reported to
  // WooCommerce as an error: WooCommerce disables a webhook after repeated errors, and a missed
  // Knowledge Link start is picked up by that agent's own scheduled run anyway.
  const results = await Promise.allSettled(jobs);
  const lines = results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.message));
  const sfFailed = results.some((r) => r.status === 'rejected' && r.reason.message.startsWith(SF_REPO));
  return reply(sfFailed ? 502 : 200, `order ${order.id}: ${lines.join('; ')}`);
}

// A browser visit to the URL just confirms the relay is up.
export function GET() {
  return reply(200, 'WooCommerce order relay is running');
}
