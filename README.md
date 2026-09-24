# BFA → Salesforce sync

Runs every hour on GitHub Actions. For each WooCommerce order containing a BFA package
(product IDs 2139, 2140, 2141), it:

1. Reads the buyer's billing name, email, address and CFP ID.
2. Finds the Salesforce Contact by email and updates it, or creates it under an Account.
3. Creates one Asset per BFA line item, linked to the Contact, Account and Product2.
4. Marks the order as synced (`sf_asset_created` custom field) and adds a private order note.

## Secrets and variables

Repo → Settings → Secrets and variables → Actions.

| Name | Type | Value |
| --- | --- | --- |
| `WC_STORE_URL` | Secret | Store URL, e.g. `https://www.think2perform.com` |
| `WC_CONSUMER_KEY` | Secret | WooCommerce REST API key (Read/Write) |
| `WC_CONSUMER_SECRET` | Secret | WooCommerce REST API secret |
| `SF_AUTH_URL` | Secret | `sfdxAuthUrl` from `sf org display --target-org <alias> --verbose --json` |
| `SF_CFP_FIELD` | Variable | API name of the Contact CFP field, e.g. `CFP_ID__c` |
| `CFP_META_KEY` | Variable | WooCommerce order meta key holding the CFP ID (optional; auto-detected if blank) |

## Running it manually

Actions → **BFA → Salesforce sync** → **Run workflow**. Dry run is on by default and writes nothing;
the log and run summary show what would happen.

## When something fails

- A failed order is retried on the next hourly run, up to 3 times. Each failure adds a private
  note to the order in WooCommerce explaining why.
- After 3 failures the order is parked. Fix the cause (e.g. a missing Product Code in Salesforce),
  then delete the order's `sf_sync_attempts` custom field in WooCommerce to retry it.
- Any run with a new failure turns red, and GitHub emails whoever last edited the schedule
  in `.github/workflows/sync.yml`.

## Renewing Salesforce access

The sync signs in with your Salesforce CLI login. If runs start failing at "Salesforce login",
run `sf org login web --alias <alias>` if needed, re-export the auth URL with
`sf org display --target-org <alias> --verbose --json`, and update the `SF_AUTH_URL` secret.

## Changing things

- **Product codes:** the WooCommerce SKU must match the Salesforce Product2 Product Code.
  If they differ, set `productCodeOverrides` at the top of `sync.js`.
- **Schedule:** edit the `cron` line in `.github/workflows/sync.yml` (times are UTC).
- **Duplicates:** each Asset's Serial Number holds `WC-<order id>-<line item id>`, which
  prevents the same purchase from creating two Assets.
