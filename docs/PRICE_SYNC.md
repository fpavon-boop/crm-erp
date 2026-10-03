# Price-list sync

Updates the catalog (`CatalogProduct`) — and optionally the retail price and
cost on matching core `Product` rows — from the CTBOS price-list workbook, so
replacing the Excel file and re-running is all it takes to refresh prices.

## Ways to run it

| How | When |
|---|---|
| **CRM → Inventory → Sync prices** (admin only) | Normal use, including production. Upload the `.xlsx`, review the dry-run, press **Apply**. |
| `npm run sync-prices -- file.xlsx [--apply] [--no-mirror] [--parse-only]` | Any database you can reach from your machine. Dry run unless `--apply`. `--parse-only` validates the file without touching a database. |

The production container ships no source code or `tsx`, and a laptop can't
reach the production database directly — which is why the admin page is the
production path. `POST /api/inventory/sync-prices` (multipart `file`, plus
`apply`, `mirrorCore`, `expectedHash`) is what the page calls.

## What it reads

**`Price List` sheet — the source of truth** (one row per product, keyed by
`PartNo`):

| Column | Goes to |
|---|---|
| PartNo | `partNo` (unique upsert key; compared case-insensitively for duplicates) |
| Product / Description | `productName` / `description` |
| Category | `category`, and `categoryGroup` via a fixed table (unknown → `OTHER` + warning) |
| Pcs/Plt, Weight (lbs) | `pcsPerPallet`, `weightLbs` (`-` = empty) |
| Cost | `acquisitionCost` |
| Markup_Dist% / Cont% / Ret% | `markupDistributor` / `markupContractor` / `markupRetail` |
| Distributor / Contractor / Retail Price | A **typed-in number** = fixed price override for that tier; a **formula** = just the markup calculation (recomputed by the engine) |
| TrueMargin_% | Ignored (derived) |

**`WooCommerce Products` sheet — enrichment only.** Matched to the price list
by SKU = `PartNo`, or Woo `ID` = `WC-<ID>`. It supplies `dimensions` (L × W × H
in) and a retail-price cross-check (a mismatch is a warning). Names,
categories, descriptions and stock are not imported. Woo products with no
price-list row are listed, never created.

## Rules

- **Formulas without stored values.** The workbook is generated without
  calculated results, so the five formula shapes it uses are evaluated here.
  Any other formula aborts the run — nothing is guessed. If the file is later
  saved from Excel, stored results are used instead.
- **Estimated costs.** A Cost cell that is the formula `retail ÷ (1 + markup)`
  is an estimate: `costIsEstimated = true`. Typing a real cost over it clears
  the flag on the next sync. Estimated costs are **never copied** onto core
  `Product.cost` (the ERP's profitability reports would treat them as real);
  the retail price still is.
- **Freight.** `shippingMethod = LTL_FREIGHT` when the row has a Pcs/Plt value
  (sold and shipped by the pallet) or weighs ≥ 150 lb; otherwise `PARCEL`.
  The file has no freight/duty/packaging columns, so on existing products
  those (and shrinkage and the card-fee rate) are left as they are; new
  products start at 0 and the 2.9% fee.
- **Margins** use the engine's definition (net of the card fee), not the
  file's `TrueMargin_%`.
- **Mirror to core `Product`** (on by default): for core products whose `sku`
  equals a `PartNo`, set `price` = retail price and (if the cost is real)
  `cost` = landed cost. Never creates core products.

## Safety

- Dry run first; nothing is written until Apply, and Apply must present the
  hash of the file that was previewed.
- Any error in the file (unknown formula, cost ≤ 0, duplicate PartNo, missing
  name) refuses the whole run.
- One transaction: all rows or none.
- Only changed rows are written, so re-running the same file changes nothing.
- Nothing is deleted or deactivated; catalog products absent from the file are
  just listed.
- Cost changes are logged to `CatalogPriceAuditLog`; each applied run writes
  an `AuditLog` row (`PRICE_SYNC`).
- Admin-only; uploads are limited to `.xlsx` files under 10 MB.

Tests: `tests/price-sync.test.ts`.
