// WooCommerce → Salesforce sync
// Finds WooCommerce orders for the products in one sync profile (BFA or Store),
// creates/updates the buyer as a Salesforce Contact (under an Account), creates one
// Asset per line item and one Opportunity per order.
// Run with: node sync.js bfa   or   node sync.js store
// Runs hourly on GitHub Actions. No npm dependencies (uses Node's built-in fetch).

const fs = require('fs');

function clean(s) {
  return s == null ? '' : String(s).trim();
}

// ============================================================================
// SYNC PROFILES: the ONLY WooCommerce products this sync will ever touch.
// Each profile keeps its own order stamp, so an order containing products from
// both profiles is synced once by each, into its own Opportunity.
//
// For each WooCommerce product ID:
//   name  : product name, used in the Opportunity name and Asset description
//   code  : Salesforce Product2 Product Code (Store products default to their ID)
//   asset : Asset name (blank = the Salesforce product's name)
//   work  : Work being conducted on the Opportunity. One of:
//           Consulting, Coaching, Training, Keynote, Product, License
// Any product not listed in the profile is ignored, even if it's in the same order.
// ============================================================================

// Every BFA package becomes an Asset of this one Salesforce product.
const BFA_PACKAGE = { code: 'BFA', asset: 'Behavioral Financial Advice', work: 'Product' };

const PROFILES = {
  bfa: {
    label: 'BFA',
    stampKey: 'sf_asset_created', // order custom field: set when an order has synced
    attemptsKey: 'sf_sync_attempts', // order custom field: failed attempt count
    products: {
      2139: { name: 'BFA- Self-Directed Package', ...BFA_PACKAGE },
      2140: { name: 'BFA- Supported Package', ...BFA_PACKAGE },
      2141: { name: 'BFA- Structured Package', ...BFA_PACKAGE },
    },
  },
  store: {
    label: 'Store',
    stampKey: 'sf_store_synced',
    attemptsKey: 'sf_store_sync_attempts',
    warnUnmapped: true, // warn about store products no profile handles
    products: {
      503: { name: 'Emotional Competence 2.0 Assessment (EQ-i)', work: 'Product' },
      504: { name: 'Moral Intelligence 2.0', work: 'Product' },
      505: { name: 'Breakthrough Leadership Webinar Series', work: 'Training' },
      537: { name: 'The Original Values Card Deck', work: 'Product' },
      538: { name: 'Debrief Only - EQ-i 2.0 Results & Interpretation', work: 'Coaching' },
      539: { name: 'Financial Intelligence', work: 'Product' },
      540: { name: 'Transformational Growth Series', work: 'Training' },
      541: { name: 'Leveraging Your Financial Intelligence', work: 'Product' },
      542: { name: 'Feeling Word Vocabulary', work: 'Product' },
      543: { name: 'The Simple Genius (You)', work: 'Product' },
      544: { name: 'How To Get What You Want and Remain True to Yourself', work: 'Product' },
      798: { name: 'Building Your Business Around You', work: 'Training' },
      930: { name: "Don't Wait for Someone Else to Fix It", work: 'Product' },
      1099: { name: 'Evolve Conference', work: 'Training' },
      1647: { name: '2024 Evolve Advanced Ticket', work: 'Training' },
      1797: { name: '5 Levels of Leadership Assessment', work: 'Product' },
      2049: { name: 'TGS for Women Advisors', work: 'Training' },
      2268: { name: '2024 Evolve Advanced Ticket - Bulk Pricing', work: 'Training' },
      2555: { name: 'Leading in Alignment', work: 'Training' },
      3491: { name: 'Values Platform', work: 'License' },
      3880: { name: 'Advice That Sticks', work: 'Training' },
    },
  },
};

// Store products that deliberately are NOT synced by any profile (no warning for these).
const IGNORED_PRODUCTS = [
  1548, // Behavioral Financial Advice Program (BFA) - draft
  1638, // BFA Hybrid Series - draft
  1639, // Behavioral Financial Advice Accelerator Coaching - draft
  1985, // BFA | Cohort Series
  2040, // The Ultimate BFA Experience - draft
  2539, // BFA & Evolve Ticket Bundle - draft
  3215, // BFA Pass Protection
  3824, // BFA Coaching Fee
];

// Each order also gets one Opportunity with these settings.
const SF_OPP_STAGE = 'Closed Won';
const SF_OPP_RECORD_TYPE = 'Team_BFA'; // Record type API name

// Email domains that always go under one Account, whatever company name the buyer typed.
const DOMAIN_ACCOUNTS = {
  'ampf.com': 'Ameriprise Financial',
  'lpl.com': 'LPL',
  'thrivent.com': 'Thrivent',
};

const PROFILE_KEY = clean(process.argv[2] || process.env.SYNC_PROFILE || 'bfa').toLowerCase();
const PROFILE = PROFILES[PROFILE_KEY];
if (!PROFILE) {
  console.error(`Unknown sync profile "${PROFILE_KEY}". Use one of: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}

// Product settings for a WooCommerce product ID in this profile.
function productInfo(productId) {
  const p = PROFILE.products[productId];
  return { code: String(productId), asset: '', ...p };
}

const CONFIG = {
  productIds: Object.keys(PROFILE.products).map(Number),
  statuses: ['processing', 'completed'],
  lookbackDays: Number(process.env.LOOKBACK_DAYS || 3),
  maxAttempts: 3, // after this many failures an order is parked for manual review
  stampKey: PROFILE.stampKey,
  attemptsKey: PROFILE.attemptsKey,
  cfpMetaKey: clean(process.env.CFP_META_KEY), // blank = auto-detect any meta key containing "cfp"
  sfCfpField: clean(process.env.SF_CFP_FIELD), // Contact API field for CFP ID, e.g. CFP_ID__c
  sfApiVersion: 'v61.0',
  dryRun: process.env.DRY_RUN === 'true',
  // Catch-up mode: re-run orders that were ALREADY synced (fills in anything missing,
  // e.g. Opportunities). Existing Contacts, Assets and Opportunities are detected and skipped.
  resyncSynced: process.env.RESYNC_SYNCED === 'true',
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
  SF = {
    base: `${j.instance_url}/services/data/${CONFIG.sfApiVersion}`,
    soapUrl: `${j.instance_url}/services/Soap/u/${CONFIG.sfApiVersion.replace('v', '')}`,
    token: j.access_token,
  };
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
    console.log(`  [dry run] would create ${obj}:`, JSON.stringify(data));
    return `DRYRUN-${obj}`;
  }
  return (await sf(`/sobjects/${obj}`, { method: 'POST', body: JSON.stringify(data) })).id;
}

async function sfUpdate(obj, id, data) {
  if (CONFIG.dryRun) {
    console.log(`  [dry run] would update ${obj} ${id}:`, JSON.stringify(data));
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
  if (hit && !CONFIG.cfpMetaKey) console.log(`  CFP ID auto-detected in meta key "${hit.key}"`);
  return value || null;
}

function getPerson(order) {
  const b = order.billing || {};
  return {
    firstName: clean(b.first_name),
    lastName: clean(b.last_name),
    email: clean(b.email).toLowerCase(),
    company: clean(b.company),
    // Account to file them under: a DOMAIN_ACCOUNTS match wins over the typed company name.
    accountName: DOMAIN_ACCOUNTS[clean(b.email).toLowerCase().split('@')[1]] || clean(b.company),
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

  if (person.accountName) {
    // If several Accounts share the name, use the oldest one.
    const found = await query(
      `SELECT Id FROM Account WHERE Name = '${soqlEscape(person.accountName)}' ORDER BY CreatedDate ASC LIMIT 1`
    );
    if (found.length) return found[0].Id;
  }

  // No company (or company not found): create a new Account.
  const name = person.accountName || `${person.firstName} ${person.lastName}`.trim();
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

// ---------- Lead conversion ----------
async function findOpenLead(email) {
  const leads = await query(
    `SELECT Id FROM Lead WHERE Email = '${soqlEscape(email)}' AND IsConverted = false ORDER BY CreatedDate ASC LIMIT 1`
  );
  return leads[0] || null;
}

let convertedStatus = null;
async function getConvertedStatus() {
  if (!convertedStatus) {
    const found = await query('SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true ORDER BY SortOrder LIMIT 1');
    if (!found.length) throw new Error('Salesforce has no "converted" Lead Status set up');
    convertedStatus = found[0].MasterLabel;
  }
  return convertedStatus;
}

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Converts a Lead into a Contact (and Account) with no Opportunity.
// Salesforce only offers lead conversion through its SOAP API, so this call uses SOAP.
async function convertLead(leadId, accountId) {
  const status = await getConvertedStatus();
  if (CONFIG.dryRun) {
    console.log(`  [dry run] would convert Lead ${leadId}${accountId ? ` into Account ${accountId}` : ''}`);
    return { contactId: 'DRYRUN-Contact', accountId: accountId || 'DRYRUN-Account' };
  }
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">' +
    `<soapenv:Header><urn:SessionHeader><urn:sessionId>${xmlEscape(SF.token)}</urn:sessionId></urn:SessionHeader></soapenv:Header>` +
    '<soapenv:Body><urn:convertLead><urn:leadConverts>' +
    (accountId ? `<urn:accountId>${accountId}</urn:accountId>` : '') +
    `<urn:convertedStatus>${xmlEscape(status)}</urn:convertedStatus>` +
    '<urn:doNotCreateOpportunity>true</urn:doNotCreateOpportunity>' +
    `<urn:leadId>${leadId}</urn:leadId>` +
    '<urn:overwriteLeadSource>false</urn:overwriteLeadSource>' +
    '<urn:sendNotificationEmail>false</urn:sendNotificationEmail>' +
    '</urn:leadConverts></urn:convertLead></soapenv:Body></soapenv:Envelope>';
  const res = await request('Salesforce convertLead', SF.soapUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
    body,
  });
  const xml = await res.text();
  const tag = (t) => (xml.match(new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`)) || [])[1];
  if (!res.ok || tag('success') !== 'true') {
    throw new Error(`Lead ${leadId} could not be converted: ${tag('message') || tag('faultstring') || `HTTP ${res.status}`}`);
  }
  return { contactId: tag('contactId'), accountId: tag('accountId') };
}

// ---------- person -> Contact ----------
// 1. Existing Contact with this email: update it.
// 2. Otherwise, an open Lead with this email: convert it, then update the new Contact.
// 3. Otherwise: create a new Contact.
async function upsertContact(person) {
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

  const matches = await query(
    `SELECT Id, AccountId FROM Contact WHERE Email = '${soqlEscape(person.email)}' ORDER BY CreatedDate ASC LIMIT 5`
  );
  if (matches.length > 1) console.log(`  Note: ${matches.length} Contacts share ${person.email}; using the oldest`);
  const existing = matches[0] || null;

  if (existing) {
    const accountId = await resolveAccount(person, existing);
    await sfUpdate('Contact', existing.Id, existing.AccountId ? fields : { ...fields, AccountId: accountId });
    console.log(`  Updated existing Contact ${existing.Id}`);
    return { contactId: existing.Id, accountId, how: 'existing Contact' };
  }

  const lead = await findOpenLead(person.email);
  if (lead) {
    // With a company on the order, convert into the matching (oldest) Account;
    // otherwise Salesforce creates the Account from the Lead's company.
    const targetAccount = person.accountName ? await resolveAccount(person, null) : null;
    const converted = await convertLead(lead.Id, targetAccount);
    console.log(`  Converted Lead ${lead.Id} to Contact ${converted.contactId}`);
    await sfUpdate('Contact', converted.contactId, fields);
    return { ...converted, how: 'converted from Lead' };
  }

  const accountId = await resolveAccount(person, null);
  const contactId = await sfCreate('Contact', { ...fields, AccountId: accountId });
  console.log(`  Created Contact ${contactId}`);
  return { contactId, accountId, how: 'new Contact' };
}

const WARNINGS = [];
function warn(msg) {
  console.log(`::warning::${msg}`);
  WARNINGS.push(msg);
}

// Finds the Salesforce product for a Product Code, once per code per run.
// Returns null if it's missing, so Assets are still created and a warning is shown.
const productLookups = new Map();
function findProduct(code) {
  if (!productLookups.has(code)) {
    productLookups.set(
      code,
      query(
        `SELECT Id, Name FROM Product2 WHERE ProductCode = '${soqlEscape(code)}' AND IsActive = true ORDER BY CreatedDate ASC LIMIT 1`
      ).then((found) => {
        if (found.length) return found[0];
        warn(`No active Salesforce product with Product Code "${code}"; Assets created without a product link`);
        return null;
      })
    );
  }
  return productLookups.get(code);
}

async function createAsset(order, item, contactId, accountId) {
  // SerialNumber holds a unique WooCommerce reference so an Asset is never created twice.
  const ref = `WC-${order.id}-${item.id}`;
  const dup = await query(`SELECT Id FROM Asset WHERE SerialNumber = '${soqlEscape(ref)}' LIMIT 1`);
  if (dup.length) {
    console.log(`  Asset already exists for ${ref} (${dup[0].Id})`);
    return dup[0].Id;
  }
  const info = productInfo(item.product_id);
  const product = await findProduct(info.code);
  const id = await sfCreate('Asset', {
    Name: (info.asset || (product && product.Name) || info.name).slice(0, 255),
    AccountId: accountId,
    ContactId: contactId,
    ...(product ? { Product2Id: product.Id } : {}),
    SerialNumber: ref,
    Status: 'Purchased',
    PurchaseDate: String(order.date_created).slice(0, 10),
    Quantity: item.quantity,
    Price: Number(item.price) || null,
    Description: `${info.name} (WooCommerce order #${order.number})`,
  });
  console.log(`  Created Asset ${id} for "${info.name}"`);
  return id;
}

// ---------- Opportunity ----------
let oppRecordTypeLookup = null;
function getOppRecordTypeId() {
  if (!oppRecordTypeLookup) {
    oppRecordTypeLookup = query(
      `SELECT Id FROM RecordType WHERE SobjectType = 'Opportunity' AND DeveloperName = '${soqlEscape(SF_OPP_RECORD_TYPE)}' AND IsActive = true LIMIT 1`
    ).then((found) => {
      if (found.length) return found[0].Id;
      warn(`Opportunity record type "${SF_OPP_RECORD_TYPE}" not found; Opportunities use the default record type`);
      return null;
    });
  }
  return oppRecordTypeLookup;
}

// One Opportunity per order per profile: "Shipping company - First Last - Product".
async function createOpportunity(order, person, items, contactId, accountId) {
  const company = clean(order.shipping && order.shipping.company) || person.company;
  const productNames = [...new Set(items.map((i) => productInfo(i.product_id).name))];
  const products = productNames.length > 2 ? 'Multiple products' : productNames.join(', ');
  const name = [company, `${person.firstName} ${person.lastName}`.trim(), products]
    .filter(Boolean)
    .join(' - ')
    .slice(0, 120);
  const closeDate = String(order.date_paid || order.date_created).slice(0, 10);
  // Amount = this profile's line items only (after discounts, before tax and shipping),
  // so an order with products from both profiles is never counted twice.
  const amount = Math.round(items.reduce((sum, i) => sum + (Number(i.total) || 0), 0) * 100) / 100;
  // Work being conducted is a multi-select picklist: one value per kind of product in the order.
  const work = [...new Set(items.map((i) => productInfo(i.product_id).work))].sort().join(';');

  // Skip if this Opportunity already exists (e.g. a re-run of the same order).
  // Amount is deliberately not part of this check: orders synced before line-item
  // amounts were introduced used the order total.
  if (!String(accountId).startsWith('DRYRUN')) {
    const dup = await query(
      `SELECT Id FROM Opportunity WHERE Name = '${soqlEscape(name)}' AND AccountId = '${soqlEscape(accountId)}' ` +
        `AND CloseDate = ${closeDate} LIMIT 1`
    );
    if (dup.length) {
      console.log(`  Opportunity already exists (${dup[0].Id})`);
      return dup[0].Id;
    }
  }

  const recordTypeId = await getOppRecordTypeId();
  const id = await sfCreate('Opportunity', {
    Name: name,
    AccountId: accountId,
    Contact__c: contactId,
    CloseDate: closeDate,
    Amount: amount,
    StageName: SF_OPP_STAGE,
    Work_being_conducted__c: work,
    ...(recordTypeId ? { RecordTypeId: recordTypeId } : {}),
    Description: `WooCommerce order #${order.number}`,
  });
  console.log(`  Created Opportunity ${id}: "${name}"`);
  return id;
}

// Adds the buyer as the Opportunity's primary Contact Role, unless they already are one
// (so re-runs and catch-up mode also fill it in on existing Opportunities).
async function ensureContactRole(oppId, contactId) {
  if (!String(oppId).startsWith('DRYRUN') && !String(contactId).startsWith('DRYRUN')) {
    const existing = await query(
      `SELECT Id FROM OpportunityContactRole WHERE OpportunityId = '${soqlEscape(oppId)}' ` +
        `AND ContactId = '${soqlEscape(contactId)}' LIMIT 1`
    );
    if (existing.length) {
      console.log(`  Contact Role already exists (${existing[0].Id})`);
      return existing[0].Id;
    }
  }
  const id = await sfCreate('OpportunityContactRole', { OpportunityId: oppId, ContactId: contactId, IsPrimary: true });
  console.log(`  Added Contact Role ${id}`);
  return id;
}

// ---------- per-order flow ----------
async function processOrder(order) {
  const person = getPerson(order);
  if (!person.email) throw new Error('Order has no billing email');
  if (!person.lastName) throw new Error('Order has no billing last name');

  const { contactId, accountId, how } = await upsertContact(person);

  const items = order.line_items.filter((li) => CONFIG.productIds.includes(li.product_id));
  const assetIds = [];
  for (const item of items) assetIds.push(await createAsset(order, item, contactId, accountId));

  const oppId = await createOpportunity(order, person, items, contactId, accountId);
  await ensureContactRole(oppId, contactId);

  const summary = `Contact ${contactId} (${how}); Assets ${assetIds.join(', ')}; Opportunity ${oppId}`;
  await setOrderMeta(order.id, CONFIG.stampKey, `${summary} on ${today()}`);
  await addOrderNote(order.id, `${PROFILE.label} sync: synced to Salesforce. ${summary}.`);
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
      `${PROFILE.label} sync: Salesforce sync failed (attempt ${attempts} of ${CONFIG.maxAttempts}): ${message}` +
        (parked ? ` Automatic retries stopped. Fix the issue, then delete the "${CONFIG.attemptsKey}" custom field to retry.` : '')
    );
  } catch (err) {
    console.error(`  Could not record failure on the order: ${err.message}`);
  }
}

// Store products in recent orders that no profile syncs and that aren't in IGNORED_PRODUCTS.
function warnUnmappedProducts(orders) {
  const known = new Set([
    ...Object.values(PROFILES).flatMap((p) => Object.keys(p.products).map(Number)),
    ...IGNORED_PRODUCTS,
  ]);
  const seen = new Set();
  for (const o of orders) {
    for (const li of o.line_items || []) {
      if (known.has(li.product_id) || seen.has(li.product_id)) continue;
      seen.add(li.product_id);
      warn(
        `Order #${o.number} has product ${li.product_id} "${li.name}", which no sync handles. ` +
          'Add it to a profile or to IGNORED_PRODUCTS in sync.js.'
      );
    }
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

  console.log(`${PROFILE.label} → Salesforce sync${CONFIG.dryRun ? ' (DRY RUN: nothing will be written)' : ''}`);
  await sfLogin();

  const orders = await getRecentOrders();
  if (PROFILE.warnUnmapped) warnUnmappedProducts(orders);
  const myOrders = orders.filter((o) => o.line_items.some((li) => CONFIG.productIds.includes(li.product_id)));
  const unsynced = myOrders.filter((o) => !metaValue(o, CONFIG.stampKey));
  const parked = unsynced.filter((o) => (Number(metaValue(o, CONFIG.attemptsKey)) || 0) >= CONFIG.maxAttempts);
  const todo = CONFIG.resyncSynced
    ? myOrders.filter((o) => metaValue(o, CONFIG.stampKey))
    : unsynced.filter((o) => !parked.includes(o));
  if (CONFIG.resyncSynced) console.log('CATCH-UP MODE: re-running orders that were already synced');

  console.log(
    `Orders in last ${CONFIG.lookbackDays} days: ${orders.length} | ${PROFILE.label}: ${myOrders.length} | ` +
      `already synced: ${myOrders.length - unsynced.length} | parked: ${parked.length} | to process: ${todo.length}`
  );

  const successes = [];
  const failures = [];
  for (const order of todo) {
    console.log(`\nOrder #${order.number}: ${order.billing?.first_name} ${order.billing?.last_name}`);
    try {
      successes.push(`#${order.number}: ${await processOrder(order)}`);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failures.push(`#${order.number}: ${err.message}`);
      await recordFailure(order, err.message);
    }
  }

  for (const o of parked) {
    console.log(`::warning::Order #${o.number} needs manual attention (${PROFILE.label} sync failed ${CONFIG.maxAttempts} times)`);
  }

  console.log(`\nDone. Synced ${successes.length}, failed ${failures.length}, parked ${parked.length}.`);

  writeJobSummary([
    `## ${PROFILE.label} → Salesforce sync${CONFIG.dryRun ? ' (dry run)' : ''}`,
    `Checked ${orders.length} orders from the last ${CONFIG.lookbackDays} days. ` +
      `Synced **${successes.length}**, failed **${failures.length}**, parked **${parked.length}**.`,
    ...(successes.length ? ['', '### Synced', ...successes.map((s) => `- ${s}`)] : []),
    ...(failures.length ? ['', '### Failed (will retry)', ...failures.map((s) => `- ${s}`)] : []),
    ...(parked.length ? ['', '### Needs manual attention', ...parked.map((o) => `- #${o.number}`)] : []),
    ...(WARNINGS.length ? ['', '### Warnings', ...[...new Set(WARNINGS)].map((w) => `- ${w}`)] : []),
  ]);

  if (failures.length) process.exit(1); // marks the run red so GitHub emails you
}

main().catch((err) => {
  console.error(err.message || err);
  writeJobSummary([`## ${PROFILE.label} → Salesforce sync`, '', `**Run failed:** ${err.message || err}`]);
  process.exit(1);
});
