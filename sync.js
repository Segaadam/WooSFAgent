// BFA → Salesforce sync
// Finds WooCommerce orders for the BFA packages, creates/updates the buyer as a
// Salesforce Contact (under an Account), and creates one Asset per BFA line item.
// Runs hourly on GitHub Actions. No npm dependencies (uses Node's built-in fetch).

const fs = require('fs');

function clean(s) {
  return s == null ? '' : String(s).trim();
}

const CONFIG = {
  productIds: [2139, 2140, 2141], // BFA packages
  statuses: ['processing', 'completed'],
  lookbackDays: Number(process.env.LOOKBACK_DAYS || 3),
  maxAttempts: 3, // after this many failures an order is parked for manual review
  stampKey: 'sf_asset_created', // order custom field: set when an order has synced
  attemptsKey: 'sf_sync_attempts', // order custom field: failed attempt count
  cfpMetaKey: clean(process.env.CFP_META_KEY), // blank = auto-detect any meta key containing "cfp"
  sfCfpField: clean(process.env.SF_CFP_FIELD), // Contact API field for CFP ID, e.g. CFP_ID__c
  sfApiVersion: 'v61.0',
  dryRun: process.env.DRY_RUN === 'true',
  // Only needed if a WooCommerce SKU doesn't match the Salesforce Product2 ProductCode.
  // Example: { 2139: 'BFA-SD' }
  productCodeOverrides: {},
};

// ---------- helpers ----------
function env(name) {
  const v = clean(process.env[name]);
  if (!v) throw new Error(`Missing secret: ${name}`);
  return v;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const soqlEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const today = () => new Date().toISOString().slice(0, 10);
const metaValue = (order, key) => ((order.meta_data || []).find((m) => m.key === key) || {}).value;

// Only include fields that have a value, so we never blank out existing Salesforce data.
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null));
}

// fetch with a timeout and retries on network errors, rate limits and server errors.
async function request(label, url, opts = {}) {
  const delays = [2000, 5000, 15000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      throw new Error(`${label} network error: ${err.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < delays.length) {
      await sleep(delays[attempt]);
      continue;
    }
    return res;
  }
}

// ---------- WooCommerce ----------
const WC = {};

async function wc(path, opts = {}) {
  const label = `WooCommerce ${opts.method || 'GET'} ${path.split('?')[0]}`;
  const res = await request(label, `${WC.url}/wp-json/wc/v3${path}`, {
    ...opts,
    headers: { Authorization: WC.auth, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`${label} -> ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function getRecentOrders() {
  const after = new Date(Date.now() - CONFIG.lookbackDays * 86400000).toISOString();
  const orders = [];
  for (let page = 1; ; page++) {
    const batch = await wc(
      `/orders?status=${CONFIG.statuses.join(',')}&after=${encodeURIComponent(after)}&per_page=100&page=${page}`
    );
    orders.push(...batch);
    if (batch.length < 100) break;
  }
  return orders;
}

async function setOrderMeta(orderId, key, value) {
  if (CONFIG.dryRun) return;
  await wc(`/orders/${orderId}`, { method: 'PUT', body: JSON.stringify({ meta_data: [{ key, value }] }) });
}

// Private order note, visible to staff on the order page in WooCommerce.
async function addOrderNote(orderId, note) {
  if (CONFIG.dryRun) return;
  await wc(`/orders/${orderId}/notes`, { method: 'POST', body: JSON.stringify({ note, customer_note: false }) });
}

// ---------- Salesforce ----------
let SF = null;

// Parses a Salesforce CLI auth URL: force://<clientId>:<clientSecret>:<refreshToken>@<instanceUrl>
function parseAuthUrl(authUrl) {
  const body = authUrl.replace(/^force:\/\//, '');
  const at = body.lastIndexOf('@');
  if (!authUrl.startsWith('force://') || at < 0) {
    throw new Error('SF_AUTH_URL is not a valid Salesforce CLI auth URL (it should start with force://)');
  }
  const [clientId, clientSecret, ...rest] = body.slice(0, at).split(':');
  const host = body.slice(at + 1).replace(/\/$/, '');
  return {
    clientId,
    clientSecret,
    refreshToken: rest.join(':'),
    instanceUrl: host.startsWith('http') ? host : `https://${host}`,
  };
}

async function sfLogin() {
  let params, tokenUrl;
  if (clean(process.env.SF_AUTH_URL)) {
    // Preferred: the refresh token from your Salesforce CLI login.
    const a = parseAuthUrl(clean(process.env.SF_AUTH_URL));
    tokenUrl = `${a.instanceUrl}/services/oauth2/token`;
    params = { grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken };
    if (a.clientSecret) params.client_secret = a.clientSecret;
  } else {
    // Fallback: Connected App client credentials flow (for a future integration user).
    tokenUrl = `${env('SF_LOGIN_URL').replace(/\/$/, '')}/services/oauth2/token`;
    params = { grant_type: 'client_credentials', client_id: env('SF_CLIENT_ID'), client_secret: env('SF_CLIENT_SECRET') };
  }
  const res = await request('Salesforce login', tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(
      `Salesforce login failed (${res.status}): ${await res.text()}\n` +
        'If you use SF_AUTH_URL, your CLI login may have expired or been revoked. ' +
        'Re-export it with: sf org display --target-org <alias> --verbose --json'
    );
  }
  const j = await res.json();
  SF = { base: `${j.instance_url}/services/data/${CONFIG.sfApiVersion}`, token: j.access_token };
}

async function sf(path, opts = {}) {
  const label = `Salesforce ${opts.method || 'GET'} ${path.split('?')[0]}`;
  const res = await request(label, `${SF.base}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${SF.token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} -> ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function query(soql) {
  return (await sf(`/query?q=${encodeURIComponent(soql)}`)).records;
}

async function sfCreate(obj, data) {
  if (CONFIG.dryRun) {
    console.log(`   [dry run] would create ${obj}:`, JSON.stringify(data));
    return `DRYRUN-${obj}`;
  }
  return (await sf(`/sobjects/${obj}`, { method: 'POST', body: JSON.stringify(data) })).id;
}

async function sfUpdate(obj, id, data) {
  if (CONFIG.dryRun) {
    console.log(`   [dry run] would update ${obj} ${id}:`, JSON.stringify(data));
    return;
  }
  await sf(`/sobjects/${obj}/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

// ---------- order → person ----------
function getCfpId(order) {
  const meta = order.meta_data || [];
  const hit = CONFIG.cfpMetaKey
    ? meta.find((m) => m.key === CONFIG.cfpMetaKey)
    : meta.find((m) => /cfp/i.test(m.key));
  const value = hit ? clean(hit.value) : '';
  if (hit && !CONFIG.cfpMetaKey) console.log(`   CFP ID auto-detected in meta key "${hit.key}"`);
  return value || null;
}

function getPerson(order) {
  const b = order.billing || {};
  return {
    firstName: clean(b.first_name),
    lastName: clean(b.last_name),
    email: clean(b.email).toLowerCase(),
    company: clean(b.company),
    street: [clean(b.address_1), clean(b.address_2)].filter(Boolean).join('\n'),
    city: clean(b.city),
    state: clean(b.state),
    postcode: clean(b.postcode),
    country: clean(b.country),
    cfpId: getCfpId(order),
  };
}

// ---------- Salesforce records ----------
async function resolveAccount(person, existingContact) {
  // Existing Contacts keep their current Account.
  if (existingContact && existingContact.AccountId) return existingContact.AccountId;

  if (person.company) {
    const found = await query(`SELECT Id FROM Account WHERE Name = '${soqlEscape(person.company)}' LIMIT 2`);
    if (found.length === 1) return found[0].Id;
    if (found.length > 1) throw new Error(`More than one Account named "${person.company}"; link this one manually`);
  }

  // No company (or company not found): create a new Account.
  const name = person.company || `${person.firstName} ${person.lastName}`.trim();
  return sfCreate(
    'Account',
    compact({
      Name: name,
      BillingStreet: person.street,
      BillingCity: person.city,
      BillingState: person.state,
      BillingPostalCode: person.postcode,
      BillingCountry: person.country,
    })
  );
}

async function upsertContact(person) {
  const matches = await query(
    `SELECT Id, AccountId FROM Contact WHERE Email = '${soqlEscape(person.email)}' ORDER BY CreatedDate ASC LIMIT 5`
  );
  if (matches.length > 1) console.log(`   Note: ${matches.length} Contacts share ${person.email}; using the oldest`);
  const existing = matches[0] || null;

  const fields = compact({
    FirstName: person.firstName,
    LastName: person.lastName,
    Email: person.email,
    MailingStreet: person.street,
    MailingCity: person.city,
    MailingState: person.state,
    MailingPostalCode: person.postcode,
    MailingCountry: person.country,
    ...(CONFIG.sfCfpField && person.cfpId ? { [CONFIG.sfCfpField]: person.cfpId } : {}),
  });

  const accountId = await resolveAccount(person, existing);

  if (existing) {
    await sfUpdate('Contact', existing.Id, fields);
    console.log(`   Updated Contact ${existing.Id}`);
    return { contactId: existing.Id, accountId };
  }
  const contactId = await sfCreate('Contact', { ...fields, AccountId: accountId });
  console.log(`   Created Contact ${contactId}`);
  return { contactId, accountId };
}

async function findProduct(item) {
  const code = CONFIG.productCodeOverrides[item.product_id] || clean(item.sku);
  if (!code) throw new Error(`Line item "${item.name}" has no SKU and no override code`);
  const found = await query(
    `SELECT Id FROM Product2 WHERE ProductCode = '${soqlEscape(code)}' AND IsActive = true LIMIT 2`
  );
  if (found.length !== 1) throw new Error(`Expected 1 active Salesforce product with code "${code}", found ${found.length}`);
  return found[0].Id;
}

async function createAsset(order, item, contactId, accountId) {
  // SerialNumber holds a unique WooCommerce reference so an Asset is never created twice.
  const ref = `WC-${order.id}-${item.id}`;
  const dup = await query(`SELECT Id FROM Asset WHERE SerialNumber = '${soqlEscape(ref)}' LIMIT 1`);
  if (dup.length) {
    console.log(`   Asset already exists for ${ref} (${dup[0].Id})`);
    return dup[0].Id;
  }
  const product2Id = await findProduct(item);
  const id = await sfCreate('Asset', {
    Name: item.name,
    AccountId: accountId,
    ContactId: contactId,
    Product2Id: product2Id,
    SerialNumber: ref,
    Status: 'Purchased',
    PurchaseDate: String(order.date_created).slice(0, 10),
    Quantity: item.quantity,
    Price: Number(item.price) || null,
    Description: `WooCommerce order #${order.number}`,
  });
  console.log(`   Created Asset ${id} for "${item.name}"`);
  return id;
}

// ---------- per-order flow ----------
async function processOrder(order) {
  const person = getPerson(order);
  if (!person.email) throw new Error('Order has no billing email');
  if (!person.lastName) throw new Error('Order has no billing last name');

  const { contactId, accountId } = await upsertContact(person);

  const items = order.line_items.filter((li) => CONFIG.productIds.includes(li.product_id));
  const assetIds = [];
  for (const item of items) assetIds.push(await createAsset(order, item, contactId, accountId));

  const summary = `Contact ${contactId}; Assets ${assetIds.join(', ')}`;
  await setOrderMeta(order.id, CONFIG.stampKey, `${summary} on ${today()}`);
  await addOrderNote(order.id, `Synced to Salesforce. ${summary}.`);
  return summary;
}

async function recordFailure(order, message) {
  if (CONFIG.dryRun) return;
  const attempts = (Number(metaValue(order, CONFIG.attemptsKey)) || 0) + 1;
  const parked = attempts >= CONFIG.maxAttempts;
  try {
    await setOrderMeta(order.id, CONFIG.attemptsKey, String(attempts));
    await addOrderNote(
      order.id,
      `Salesforce sync failed (attempt ${attempts} of ${CONFIG.maxAttempts}): ${message}` +
        (parked ? ` Automatic retries stopped. Fix the issue, then delete the "${CONFIG.attemptsKey}" custom field to retry.` : '')
    );
  } catch (err) {
    console.error(`   Could not record failure on the order: ${err.message}`);
  }
}

function writeJobSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

// ---------- main ----------
async function main() {
  WC.url = env('WC_STORE_URL').replace(/\/$/, '');
  WC.auth = 'Basic ' + Buffer.from(`${env('WC_CONSUMER_KEY')}:${env('WC_CONSUMER_SECRET')}`).toString('base64');

  console.log(`BFA → Salesforce sync${CONFIG.dryRun ? ' (DRY RUN: nothing will be written)' : ''}`);
  await sfLogin();

  const orders = await getRecentOrders();
  const bfaOrders = orders.filter((o) => o.line_items.some((li) => CONFIG.productIds.includes(li.product_id)));
  const unsynced = bfaOrders.filter((o) => !metaValue(o, CONFIG.stampKey));
  const parked = unsynced.filter((o) => (Number(metaValue(o, CONFIG.attemptsKey)) || 0) >= CONFIG.maxAttempts);
  const todo = unsynced.filter((o) => !parked.includes(o));

  console.log(
    `Orders in last ${CONFIG.lookbackDays} days: ${orders.length} | BFA: ${bfaOrders.length} | ` +
      `already synced: ${bfaOrders.length - unsynced.length} | parked: ${parked.length} | to process: ${todo.length}`
  );

  const successes = [];
  const failures = [];
  for (const order of todo) {
    console.log(`\nOrder #${order.number}: ${order.billing?.first_name} ${order.billing?.last_name}`);
    try {
      successes.push(`#${order.number}: ${await processOrder(order)}`);
    } catch (err) {
      console.error(`   FAILED: ${err.message}`);
      failures.push(`#${order.number}: ${err.message}`);
      await recordFailure(order, err.message);
    }
  }

  for (const o of parked) {
    console.log(`::warning::Order #${o.number} needs manual attention (sync failed ${CONFIG.maxAttempts} times)`);
  }

  console.log(`\nDone. Synced ${successes.length}, failed ${failures.length}, parked ${parked.length}.`);

  writeJobSummary([
    `## BFA → Salesforce sync${CONFIG.dryRun ? ' (dry run)' : ''}`,
    `Checked ${orders.length} orders from the last ${CONFIG.lookbackDays} days. ` +
      `Synced **${successes.length}**, failed **${failures.length}**, parked **${parked.length}**.`,
    ...(successes.length ? ['', '### Synced', ...successes.map((s) => `- ${s}`)] : []),
    ...(failures.length ? ['', '### Failed (will retry)', ...failures.map((s) => `- ${s}`)] : []),
    ...(parked.length ? ['', '### Needs manual attention', ...parked.map((o) => `- #${o.number}`)] : []),
  ]);

  if (failures.length) process.exit(1); // marks the run red so GitHub emails you
}

main().catch((err) => {
  console.error(err.message || err);
  writeJobSummary(['## BFA → Salesforce sync', '', `**Run failed:** ${err.message || err}`]);
  process.exit(1);
});
