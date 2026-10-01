# WooCommerce → Salesforce sync

Runs every hour on GitHub Actions, as two syncs one after the other:

- **BFA sync** (`node sync.js bfa`): the three BFA packages (product IDs 2139, 2140, 2141).
- **Store sync** (`node sync.js store`): every other store product listed in `PROFILES.store` in `sync.js`.

For each WooCommerce order containing one of its products, a sync:

1. Reads the buyer's billing name, email, address and CFP ID.
2. Finds the Salesforce Contact by email and updates it, converts a matching open Lead, or creates a new Contact under an Account.
3. Creates one Asset per matching line item, linked to the Contact, Account and Product2.
4. Creates one Opportunity for the order (Closed Won). Its Amount is the sum of that sync's own line items (after discounts, before tax and shipping), so an order with products from both syncs is never counted twice.
5. Marks the order as synced and adds a private order note.

The two syncs keep separate order stamps, so an order containing both a BFA package and a store product is synced by each:

| | BFA sync | Store sync |
|---|---|---|
| Synced stamp (order custom field) | `sf_asset_created` | `sf_store_synced` |
| Failed-attempts counter | `sf_sync_attempts` | `sf_store_sync_attempts` |

They never run at the same time, so a buyer who is new to Salesforce is only created once.

## Secrets and variables

Repo → Settings → Secrets and variables → Actions.

| Name | Type | Value |
|---|---|---|
| WC_STORE_URL | Secret | Store URL, e.g. https://www.think2perform.com |
| WC_CONSUMER_KEY | Secret | WooCommerce REST API key (Read/Write) |
| WC_CONSUMER_SECRET | Secret | WooCommerce REST API secret |
| SF_AUTH_URL | Secret | sfdxAuthUrl from `sf org display --target-org <alias> --verbose --json` |
| SF_CFP_FIELD | Variable | API name of the Contact CFP field, e.g. CFP_ID__c |
| CFP_META_KEY | Variable | WooCommerce order meta key holding the CFP ID (optional; auto-detected if blank) |

## Running it manually

Actions → WooCommerce → Salesforce sync → Run workflow. Choose which sync to run (both, bfa or store). Dry run is on by default and writes nothing; the log and run summary show what would happen.

## When something fails

- A failed order is retried on the next hourly run, up to 3 times. Each failure adds a private note to the order in WooCommerce explaining why.
- After 3 failures the order is parked. Fix the cause (e.g. a missing Product Code in Salesforce), then delete the order's failed-attempts custom field (see the table above) in WooCommerce to retry it.
- Any run with a new failure turns red, and GitHub emails whoever last edited the schedule in `.github/workflows/main.yml`.

## Renewing Salesforce access

The sync signs in with your Salesforce CLI login. If runs start failing at "Salesforce login", run `sf org login web --alias <alias>` if needed, re-export the auth URL with `sf org display --target-org <alias> --verbose --json`, and update the SF_AUTH_URL secret.

## Changing things

- **Products:** edit `PROFILES` at the top of `sync.js`. Each product has a name, a Work being conducted value (Consulting, Coaching, Training, Keynote, Product or License) and a Salesforce Product Code. BFA packages all use Product Code `BFA`; store products use their WooCommerce product ID as the Product Code, so each needs an active Product2 with that code.
- **New store products:** the Store sync warns about any product in a recent order that no sync handles. Add it to `PROFILES.store`, or to `IGNORED_PRODUCTS` if it should never sync.
- **Schedule:** edit the cron line in `.github/workflows/main.yml` (times are UTC).
- **Duplicates:** each Asset's Serial Number holds `WC-<order id>-<line item id>`, which prevents the same purchase from creating two Assets. An Opportunity is skipped if one with the same name, Account and Close Date already exists.
