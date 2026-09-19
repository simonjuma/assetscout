# AssetScout — Stripe Subscription Integration Plan (DOCUMENTATION ONLY)

**Status:** PLAN / SCHEMA / CONTRACTS ONLY. No application code written.
**Author:** Cline
**Date:** 2026-09-15
**Decision record:** You selected *"Only write the plan/architecture + exact SQL schema, API route contracts, env vars, and Stripe Dashboard steps as documentation now — no code until I confirm where the real repo is."*

---

## 0. CRITICAL PRECONDITION — READ FIRST

This document is a **design proposal for an existing codebase that is not present on this machine.**
It is **not** a description of verified existing code, because there is no existing code to verify.

### 0.1 Verified inspection findings (evidence, not assumption)

Workspace root: `/data/user/0/com.vscodroid/files/projects`

Complete non-`node_modules` file inventory of the workspace:

```
./vercheck.mjs
./README.md
./swrcheck/package.json
./swrcheck/install.log
```

| Required inspection item | Result |
|---|---|
| Project root / `package.json` | **NOT FOUND.** Only `swrcheck/package.json` (`"name": "assetscout-swr-check"`) — a throwaway Next.js install-verification skit with zero app code |
| Framework + Next.js version | **NOT FOUND** (only a bare `next@15.5.7` + `react@19.1.0` install test) |
| App Router structure (`app/` / `src/app/`) | **DOES NOT EXIST** |
| TypeScript config (`tsconfig.json`) | **DOES NOT EXIST** |
| Authentication system | **DOES NOT EXIST** |
| Database / Supabase integration | **DOES NOT EXIST.** Device-wide search (`/storage/emulated/0`, `/data/local/tmp`, `/data/user/0/com.vscodroid/files`, depth 8) for `supabase`, `next.config.ts`, `next.config.mjs` → **0 results** |
| Existing payment / finance / billing code | **DOES NOT EXIST** |
| Deployment configuration | **DOES NOT EXIST** |
| Environment variables | **NONE.** No `.env*`; no `STRIPE_*` / `SUPABASE_*` in `env` |
| Pricing / billing / plans / entitlements / marketplace routes | **NONE EXIST** |
| **Git repository** | **NONE.** `git status` → `fatal: not a git repository`. Device-wide search for `.git` (depth 5) → **0 results** |

**What does exist:** `/data/user/0/com.vscodroid/files/home/.dumps/assetscout-spec.md` (your 23 KB AssetScout master build prompt) and two failed-session transcripts (`kyors.txt`, `wyp6q.txt`) that show that prior session was spent debugging the VS Code/Cline shell environment — **not** building AssetScout.

**Nothing was created, modified, or deleted while producing this document.**

### 0.2 Tooling caveat for later implementation

- `node v24.18.0`, `npm 11.16.0` (via shell function), `git 2.55.0` are available.
- `timeout 25 npm ping` → `timeout: exec npm: No such file or directory` — `npm` is **not** a standalone binary; it resolves only through the shell's alias/function. Scripts invoking `npm` from a non-interactive context (CI, hooks, `child_process`) may fail on this platform.
- Android/ARM has no native `@next/swc-*` binary; your own `vercheck.mjs` probes `@next/swc-wasm-nodejs`, implying you already hit SWC loading failures. Plan for WASM SWC fallback or a non-Android build environment.

### 0.3 How to read this document

Every statement about "the existing app" is written as an **assumption to be verified**, marked `[VERIFY]`.
Sections 1–3 are architecture proposals. Sections 4–9 are executable artifacts (env vars, DDL, route contracts) you can apply to the real repo once located.

---

## 1. Architecture to Verify Before Any Code Is Written (`[VERIFY]`)

The following is the stack implied by `assetscout-spec.md` (line refs cited). **Confirm each against the real repo before implementing.**

| Layer | Assumed | Spec evidence | Why it matters for Stripe |
|---|---|---|---|
| Framework | Next.js App Router + TypeScript | Spec §34, §35 (`npm run lint/typecheck/build`), §36 | Determines Route Handler shape for the webhook |
| Hosting | Vercel or Node server | Not stated `[VERIFY]` | Webhook needs a raw-body Node runtime, not Edge |
| Database | Postgres via Supabase | Spec §30 explicitly names "Supabase service-role keys" and "Row-level security"; §29 "scalable relational database" | RLS policies + `auth.uid()` for billing isolation |
| Auth | Supabase Auth (likely) | Spec §22/§30 "Secure authentication", "role-based access control" | `auth.users.id` is the user FK for Stripe mapping |
| Spec-table for plans | `plans`, `subscriptions` already suggested | Spec §29 table list (lines 845–871) | **Do not create competing tables** if these exist |
| Payments | Stripe (Checkout + Subscriptions + Webhooks + Entitlements) | Spec §31 lines 926–941 | Mandated flow already matches your Stripe prompt |
| Currency | USD + KES | Spec §31 line 922 | Honest capability check required (see §10) |
| Secrets hygiene | Env vars only, never client/SCM | Spec §30 lines 903–913 | Matches your Stripe prompt exactly |
| Phasing | Marketplace is **Phase 4**; Portfolio Phase 5; Enterprise/API Phase 6 | Spec §34 lines 1048–1078 | **Stripe Connect payouts are out of scope now** — see §11 |

---

## 2. Centralized Plan & Entitlement Layer (the core of this design)

**Requirement:** "Do not hard-code plan permissions throughout individual pages. Use the existing entitlement architecture or create a centralized plan/feature entitlement layer if one does not already exist." (Your prompt) + spec line 705: *"Do not hard-code prices throughout the application. Store pricing/configuration centrally."*

### 2.1 Single source of truth

Three layers, one direction of dependency. Pages **never** read Stripe and never hard-code a tier.

```
DB: plans / plan_features / plan_prices   <- pricing + limits live here (admin-editable)
        |
        v
API layer: getEntitlements(userId)        <- resolves subscription status + overrides
        |
        v
UI + route handlers: requireEntitlement() <- server-side enforcement gate
```

- **Display** (pricing page, upgrade prompts) reads `plans` + `plan_features` + `plan_prices`. Never a literal `19`.
- **Enforcement** happens **server-side** in Route Handlers / Server Actions via one guard function. Client checks are cosmetic only and are never trusted.
- **Stripe Price IDs** live in `plan_prices.stripe_price_id` (env vars as fallback, see §5/§9). The browser sends only `plan_key` + `billing_interval`; the **server** resolves the Price ID. This satisfies "never allow the client to submit an arbitrary amount."

### 2.2 Plan catalog (maps spec §23 + your prompt)

Keys are stable strings; display names are data.

| `plans.key` | Name | Spec basis | Self-serve Stripe Checkout? |
|---|---|---|---|
| `free` | Free | §23 line 661 | No (default state, no Stripe object) |
| `pro` | Pro | §23 line 669, "$9–$19/month" | **Yes** — monthly + annual |
| `agency` | Investor / Agency | §23 line 688, "$49–$99/month" | **Yes** — monthly + annual |
| `enterprise` | Enterprise | §23 / §34 line 1075 | **No self-serve** — contact-sales / invoiced; provisioned by admin, optionally linked to a Stripe subscription created out-of-band |

`agency` is the DB key for spec's "INVESTOR / AGENCY" tier (display name stays "Investor / Agency"). Exact prices are **admin-configured rows**, not code constants. Note spec ranges are *"Suggested starting range"* — final values are your business decision.

### 2.3 Feature keys (centralized, namespaced)

Boolean gates vs. numeric limits are distinguished by `features.value_type`.

| `feature_key` | type | free | pro | agency | enterprise |
|---|---|---|---|---|---|
| `search.opportunities_per_month` | limit | 25 | 1000 | 10000 | unlimited |
| `search.advanced_filters` | boolean | ✗ | ✓ | ✓ | ✓ |
| `scoring.basic` | boolean | ✓ | ✓ | ✓ | ✓ |
| `scoring.advanced_risk` | boolean | ✗ | ✓ | ✓ | ✓ |
| `watchlist.items` | limit | 10 | 250 | unlimited | unlimited |
| `saved_searches.count` | limit | 0 | 25 | unlimited | unlimited |
| `alerts.count` | limit | 0 | 25 | unlimited | unlimited |
| `comparisons.bulk` | limit | 3 | 50 | unlimited | unlimited |
| `reports.monthly` | limit | 1 | 25 | 250 | unlimited |
| `reports.premium_export` | boolean | ✗ | ✓ | ✓ | ✓ |
| `verification.tracking` | boolean | ✗ | ✓ | ✓ | ✓ |
| `pipeline.acquisition` | boolean | ✗ | ✓ | ✓ | ✓ |
| `monetization.planner` | boolean | ✗ | ✓ | ✓ | ✓ |
| `portfolio.assets` | limit | 3 | 100 | unlimited | unlimited |
| `portfolio.analytics_roi` | boolean | ✗ | ✓ | ✓ | ✓ |
| `discovery.bulk` | boolean | ✗ | ✗ | ✓ | ✓ |
| `analytics.advanced` | boolean |  | ✗ | ✓ | ✓ |
| `projects.count` | limit | 1 | 1 | 10 | unlimited |
| `team.seats` | limit | 1 | 1 | 5 | unlimited |
| `api.access` | boolean | ✗ |  | ✓ | ✓ |
| `support.priority` | boolean | ✗ | ✗ | ✓ | ✓ |

"unlimited" = `limit_value IS NULL`. Encode the NULL-means-unlimited semantic in **one** place (`entitlementLimit()`), and keep it consistent in SQL and TypeScript.

**Anti-pattern to avoid:** `if (plan === 'pro') { ... }` scattered across pages.

### 2.4 Resolution algorithm (must be server-authoritative)

```
effective plan(user) =
    subscription status in ('active','trialing')        -> that plan_id
  else subscription 'past_due'                          -> GRACE: keep plan, flag 'payment_issue'
  else 'canceled'/'unpaid'/'incomplete_expired'         -> free
  else                                                  -> free

effective limit(user, feature) =
    entitlement_overrides (non-expired, admin-granted)  ELSE
    plan_features[effective plan][feature].limit_value  ELSE
    0 / false
```

Trial status is read from Stripe (`status = 'trialing'`, `trial_end`) — never inferred from a local clock.

### 2.5 Proposed file layout (adapt to the real repo's conventions)

```
src/lib/billing/plans.ts          # typed catalog loader (reads DB; no hard-coded prices)
src/lib/billing/entitlements.ts   # getEntitlements(userId), entitlementLimit(), hasFeature()
src/lib/billing/stripe.ts         # SERVER ONLY: `import 'server-only'` + Stripe SDK init from env
src/lib/billing/guards.ts         # requireEntitlement(...) -> 402/403; requireAdmin()
src/app/api/billing/...           # route handlers (see API contracts doc)
src/app/(dashboard)/billing/...   # UI: current plan, manage, cancel
src/app/pricing/...               # may already exist [VERIFY] — extend, do not duplicate
supabase/migrations/…_billing.sql # see schema doc
```

**Before creating any of these, locate the existing equivalents.** Spec §17 line 515 already lists "Billing" under the user dashboard — if that page exists, **extend it**.

---

## 3. Security Controls (mapped 1:1 to your requirements)

| # | Requirement | Implementation |
|---|---|---|
| 1 | `STRIPE_SECRET_KEY` server-side only | `src/lib/billing/stripe.ts` guarded with `import 'server-only'`; never imported by a Client Component |
| 2 | Publishable key exposed only where required | Stripe Checkout is **redirect-based**, so `STRIPE_PUBLISHABLE_KEY` is **not needed at all** in Phase 1. Add it only if/when you adopt Stripe Elements |
| 3 | No hard-coded secrets | Verified by the secret scan in §13.5; env access goes through one validated config module |
| 4 | No secrets in Git | `.env*` in `.gitignore`; commit `.env.example` with **empty** values only |
| 5 | No Supabase service-role / DB creds exposed | Service-role key used **only** in server modules; never a `NEXT_PUBLIC_*` var |
| 6 | Never trust frontend "payment success" | Success page is **cosmetic**. Entitlement activates only from webhook-written `subscriptions.status` |
| 7 | Verify webhook signatures | `stripe.webhooks.constructEvent(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET)` **before** any parsing or DB write |
| 8 | Idempotent webhooks | `stripe_events.stripe_event_id UNIQUE` + unique Stripe IDs on domain tables (schema §4.9) |
| 9 | Validate user + server-side prices | Session created only for the `auth.uid()` session user; Price resolved from DB by `plan_key` + `billing_interval` |
| 10 | No client-supplied amounts | Request schema accepts **no amount field**; Zod `.strict()` rejects unknown keys so `{amount: 1}` is a 400 |

### 3.1 Threat-model notes

- **Replay/duplicate:** Stripe retries webhooks aggressively. Unique constraint on `stripe_events.stripe_event_id` + `INSERT … ON CONFLICT DO NOTHING` returning zero rows ⇒ skip processing. Never grant entitlement twice.
- **Out-of-order delivery:** Stripe does not guarantee ordering. Always **upsert from the event's own object payload** (fetch the Subscription / Invoice by ID from Stripe if `previous_attributes` matter) rather than incrementing counters. Prefer set-based assignment (`status = <event status>`), never `update … set credits = credits + 1`.
- **Customer hijack:** bind `stripe_customer_id` to `auth.uid()` at creation time; on `checkout.session.completed`, verify `session.client_reference_id === auth.uid()` before writing.
- **Price tampering:** price is looked up server-side; a client-sent `price_id` is ignored/rejected.
- **Privilege escalation:** `plan_key = 'enterprise'` must never be accepted from a self-serve request — enterprise provisioning is an admin-only route protected by `requireAdmin()`.
- **RLS:** billing tables are readable by their owner and **writable only by the service role** (server). If RLS is bypassed by a leaked anon key, a user still cannot write their own `subscriptions.status`.
- **PII minimisation:** store Stripe IDs, amounts, statuses, periods. Do **not** store card data (never touches your servers — Checkout handles it), and do not mirror full Stripe webhook payloads beyond what reconciliation needs (spec §32 data-minimisation).

---

## 4. Environment Variables

**Current state: NONE of these are set on this machine.** `env | grep -iE 'stripe|supabase'` → *no stripe/supabase env vars set*.

### 4.1 Variables to add to the deployment environment

| Variable | Required? | Scope | Purpose / notes |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | **REQUIRED** | **server only** | `sk_test_…` in test, `sk_live_…` in production. Never `NEXT_PUBLIC_*`. Never committed. |
| `STRIPE_WEBHOOK_SECRET` | **REQUIRED** | **server only** | `whsec_…`. **Per-endpoint** — a *different* value for test mode vs live mode and for local `stripe listen`. |
| `APP_URL` (or `NEXT_PUBLIC_APP_URL`) | **REQUIRED** | server + client | Absolute origin used to build `success_url`, `cancel_url`, portal `return_url`. **Build from this env var, never from the `Host` header** (host-header-injection risk in redirects). Must be `https://` in production. |
| `NEXT_PUBLIC_SUPABASE_URL` | **REQUIRED** (likely already exists in the real repo) | client + server | Existing Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **REQUIRED** (likely already exists) | client + server | Existing anon key; safe to expose, RLS protects data. |
| `SUPABASE_SERVICE_ROLE_KEY` | **REQUIRED** | **server only** | Needed by the webhook writer (writes bypass RLS by design). Never expose (spec §30 line 907 explicitly forbids exposing this). |
| `STRIPE_PRICE_PRO_MONTHLY` | *optional* | server only | Only as a **fallback** if you prefer env over the `plan_prices` table. **Database is recommended** as the single source of truth (spec line 705). Do not maintain both as equals — pick one. |
| `STRIPE_PRICE_PRO_ANNUAL` | *optional* | server only | Same caveat. |
| `STRIPE_PRICE_AGENCY_MONTHLY` | *optional* | server only | Same caveat. |
| `STRIPE_PRICE_AGENCY_ANNUAL` | *optional* | server only | Same caveat. |
| `STRIPE_DEFAULT_CURRENCY` | *optional* | server only | `USD` (recommended default). See §10 on KES. |

**Note on `STRIPE_PUBLISHABLE_KEY`:** not listed as required. With redirect-based Stripe Checkout + Billing Portal, **no publishable key is needed**. Add it only if you later use Stripe Elements/`stripe.js` client-side (your prompt permits it "only where required").

### 4.2 `.env.example` to commit (empty values — safe for Git)

```dotenv
# --- Stripe (server-side only) ---
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
# STRIPE_PUBLISHABLE_KEY=          # only if client-side Stripe.js is introduced later

# --- Application origin used for redirect URLs ---
APP_URL=http://localhost:3000

# --- Supabase (likely already present in the real repo — confirm, do not duplicate) ---
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

### 4.3 Hard rules

1. `.env`, `.env.local`, `.env.*.local` must be in `.gitignore` **before** any secret is written. `[VERIFY]` the real repo's `.gitignore` first; if `.env*` is not ignored, that is a **pre-existing defect to fix first**.
2. Only the deploy platform's secret store holds real values (e.g. Vercel → Project → Settings → Environment Variables; or your platform's equivalent `[VERIFY]`).
3. Never paste secret values into source, comments, docs, commits, or this chat — the values above are intentionally blank.
4. Server-only modules must `import 'server-only'` so a Client Component import fails at build time rather than leaking the key.
5. Test and live keys must live in **separate** environments. Never mix `sk_test_*` with `whsec_*` from the live endpoint.

---

## 5. Pricing Configuration & Stripe Price Mapping

### 5.1 Rule: Stripe Price IDs and amounts live in ONE place

Preferred source of truth: the `plan_prices` table (schema §4.2). Env vars are an acceptable alternative **only if** you reject the DB approach — but do not run both as equals, or you will get drift between the pricing page and what Stripe actually charges.

| Plan | Interval | DB row (`plan_prices`) | Env fallback | Stripe object |
|---|---|---|---|---|
| `pro` | month | `(plan=pro, interval=month, currency=USD)` | `STRIPE_PRICE_PRO_MONTHLY` | `price_…` recurring monthly |
| `pro` | year | `(plan=pro, interval=year, currency=USD)` | `STRIPE_PRICE_PRO_ANNUAL` | `price_…` recurring yearly |
| `agency` | month | `(plan=agency, interval=month, currency=USD)` | `STRIPE_PRICE_AGENCY_MONTHLY` | `price_…` recurring monthly |
| `agency` | year | `(plan=agency, interval=year, currency=USD)` | `STRIPE_PRICE_AGENCY_ANNUAL` | `price_…` recurring yearly |
| `free` | — | none needed | none | no Stripe object |
| `enterprise` | — | none (`requires_sales_contact = true`) | none | invoiced / out-of-band |

### 5.2 Stripe Price design decisions

1. **One Product per plan** (e.g. "AssetScout Pro"), **multiple Prices** under it (monthly, annual, optionally KES). Keeps Dashboard reporting clean and makes "revenue by plan" trivially accurate.
2. **Amounts are integer minor units.** Stripe's minor-unit exponent varies by currency (JPY is zero-decimal). KES uses 2 decimals, but confirm the exponent for any currency you add rather than assuming `×100` universally.
3. **Prices are immutable in Stripe.** To change a price: create a *new* `price_…`, insert a new `plan_prices` row, set the old row `is_active = false`. Do **not** edit the old row. Existing subscriptions keep the old price until migrated — decide explicitly whether to grandfather or migrate.
4. **Annual pricing is its own Price** — never `monthly × 12` computed at runtime.
5. **Display formatting is centralized**: one `formatMoney(minorUnits, currency)` helper using `Intl.NumberFormat`. No page interpolates `$` or `KSh` itself.
6. **`plan_prices.unit_amount` must agree with the Stripe Price.** Since the client never sends an amount, a mismatch would silently charge the Stripe amount. Mitigate with the admin assertion check in §13.3.

### 5.3 Where prices appear in the UI

The pricing page, compare table, upgrade prompts, and billing page all read from `getPlans()` / `getEntitlements()`. If you later change `pro` from $19 to $29, the correct change is **one Stripe Price + one DB row** — zero component edits. That is the test of whether this architecture was implemented correctly.

**No hard-coded amounts anywhere:** a repo-wide search for regex `\$\s?\d+` and `KSh` should return only fixtures, tests, and the money-formatting helper.
