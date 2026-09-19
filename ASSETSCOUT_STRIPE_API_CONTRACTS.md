# AssetScout — Stripe API Route Contracts (DOCUMENTATION ONLY)

**Status:** PROPOSED CONTRACTS. No code written. Companion docs:
`ASSETSCOUT_STRIPE_INTEGRATION_PLAN.md`, `ASSETSCOUT_STRIPE_SCHEMA.sql`.
Route paths assume Next.js App Router and are `[VERIFY]` against the real repo's existing convention.

---

## 6.1 Shared conventions (apply to every route below)

| Concern | Rule |
|---|---|
| Runtime | `export const runtime = 'nodejs'` on all billing routes (Stripe SDK + raw body need Node, not Edge) |
| Auth | Resolve the user from the Supabase server session cookie via the repo's existing helper. **Never** accept a `userId` from the request body |
| Validation | Zod `.strict()` schemas. Unknown keys ⇒ `400`. This is what blocks `{ amount: 999 }` and `{ price_id: '...' }` injection |
| Auth failure | `401 { error: 'unauthenticated' }` |
| Entitlement/plan failure | `402 { error: 'plan_upgrade_required', requiredFeature }` (or `403` for admin-only) |
| Bad input | `400 { error: 'invalid_request', details }` — never echo secrets or provider errors |
| Upstream failure | `502 { error: 'stripe_unavailable' }`; log server-side with correlation id |
| Rate limiting | Reuse the repo's existing limiter (spec §30). If none exists, defer — but note it as a gap |
| Caching | `export const dynamic = 'force-dynamic'` on any route reading per-user billing state |
| No leakage | Responses never include `stripe_secret_key`, service-role tokens, or full Stripe objects |

**Shared response envelope**

```ts
type ApiError = { error: string; details?: unknown };
type ApiOk<T> = { data: T };
```

---

## 6.2 `GET /api/billing/plans`

Public, cacheable-ish (still `force-dynamic` if it reads DB). Feeds the pricing page and compare table.

**Auth:** none required (this is public marketing data).

**Response 200**

```ts
type PlanDto = {
  key: string;              // 'free' | 'pro' | 'agency' | 'enterprise'
  name: string;
  tagline: string | null;
  tier: number;
  requiresSalesContact: boolean;
  prices: Array<{
    billingInterval: 'month' | 'year';
    currency: 'USD' | 'KES';
    unitAmount: number;     // minor units
  }>;
  features: Array<{
    featureKey: string;
    valueType: 'boolean' | 'limit';
    enabled: boolean;
    limitValue: number | null;  // null = unlimited
  }>;
};
type Response = ApiOk<{ plans: PlanDto[]; defaultCurrency: 'USD' | 'KES' }>;
```

**Notes**
- `free` has no `prices` rows (or a single `0`-amount row) — resolve this consistently.
- `enterprise` is public (`requiresSalesContact: true`) but has **no** checkoutable prices ⇒ the UI shows "Contact sales".
- Only `is_active AND is_public` plans are returned to unauthenticated callers.
- Never expose `stripe_price_id` here. The client deals in `key` + interval only.

---

## 6.3 `GET /api/billing/subscription`

The billing page's state source. **Read-only mirror of DB state** (which is webhook-authoritative).

**Auth:** required → `401`

**Response 200**

```ts
type SubscriptionStateDto = {
  plan: { key: string; name: string; tier: number };
  status:
    | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid'
    | 'incomplete' | 'incomplete_expired' | 'paused' | 'none';  // 'none' = free
  billingInterval: 'month' | 'year' | null;
  currency: string | null;
  currentPeriodStart: string | null;   // ISO 8601
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  hasBillingAccount: boolean;          // whether a Stripe customer exists (portal availability)
  lastPaymentStatus: 'succeeded' | 'failed' | 'pending' | null;
  entitlements: Array<{ featureKey: string; valueType: 'boolean' | 'limit'; enabled: boolean; limitValue: number | null }>;
  /**
   * Display-only derived flags. NOT an entitlement source.
   * Access decisions must come from `entitlements` (server-resolved).
   */
  paymentIssue: boolean;   // status === 'past_due' or lastPaymentStatus === 'failed'
};
```

**Notes**
- This route performs **no** Stripe calls in the happy path (fast, and avoids rate limits). Optional: a separate admin/reconciler job syncs drift.
- `status: 'none'` means the user is on Free.
- Reads only the caller's own rows (RLS-scoped / `auth.uid()` filtered).

---

## 6.4 `POST /api/billing/checkout`

Creates a Stripe Checkout Session for a **subscription**. This is the only entry point to paid access.

**Auth:** required → `401`

**Request body** (Zod `.strict()` — any extra key ⇒ `400`)

```ts
const CheckoutRequest = z.object({
  planKey: z.enum(['pro', 'agency']),        // 'free'/'enterprise' rejected: 400
  billingInterval: z.enum(['month', 'year']),
  currency: z.enum(['USD', 'KES']).optional(),  // server still validates supportability
}).strict();
// Deliberately ABSENT: amount, priceId, price_id, quantity, successUrl, customerId, userId.
```

**Server steps (in order)**

```
1. Authenticate            -> userId = session user.               [401 if absent]
2. Parse + strict-validate -> reject unknown keys.                 [400]
3. Resolve price (SERVER)  -> plan_prices row for (planKey, interval, currency)
                              WHERE is_active = true; require plans.is_active.
                              [400 'plan_not_purchasable' if missing]
                              => stripePriceId, expectedUnitAmount
4. Reuse/create customer   -> billing_customers.stripe_customer_id, or create via
                              stripe.customers.create({ email, metadata:{ user_id } })
                              and persist BEFORE returning the URL.
                              Never trust a client-supplied customer id.
5. Create session          -> mode: 'subscription'
                              line_items: [{ price: stripePriceId, quantity: 1 }]
                              client_reference_id: userId
                              metadata: { user_id: userId, plan_key: planKey,
                                          billing_interval: interval }
                              subscription_data.metadata: { user_id, plan_key }
                              success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`
                              cancel_url:  `${APP_URL}/pricing?checkout=cancelled`
                              allow_promotion_codes: <policy decision>
                              automatic_tax / tax_id_collection: <policy decision>
6. Persist intent          -> payments-row/audit entry with checkout_session_id,
                              status 'pending' (optional but useful for reconciliation).
7. Respond                 -> { data: { url } }
```

**Response 200**

```ts
type Response = ApiOk<{ url: string }>;   // Stripe-hosted Checkout URL
```

**Guarantees**
- The amount is **never** taken from the request. It is whatever the resolved Stripe Price defines.
- `client_reference_id = userId` is the tamper check consumed later by the webhook (§7.2).
- If the user already has a live subscription, return `409 { error: 'subscription_exists' }` and direct them to upgrade/portal instead of creating a second subscription.

**Idempotency**
- Accept an optional `Idempotency-Key` request header and forward it to `stripe.checkout.sessions.create(..., { idempotencyKey })` so double-clicks/retries don't spawn duplicate sessions.

---

## 6.5 `POST /api/billing/portal`

Opens the Stripe Billing Portal (cancel, change plan, update payment method, invoices).

**Auth:** required → `401`

**Request body**

```ts
const PortalRequest = z.object({}).strict();   // no parameters needed
// return_url is built server-side from APP_URL, never from the client.
```

**Server steps**

```
1. Authenticate                           [401]
2. Load billing_customers.stripe_customer_id for userId
   -> if none: 400 { error: 'no_billing_account' }   (nothing to manage)
3. stripe.billingPortal.sessions.create({
     customer: stripeCustomerId,
     return_url: `${APP_URL}/billing`
   })
4. Respond { url }
```

**Response 200** → `ApiOk<{ url: string }>`

**Notes**
- The portal requires Dashboard configuration: allowed cancellation, allowed plan switches to the correct Prices (see §12.5) — otherwise options appear missing.
- **Cancellation performed in the portal does not itself change entitlements here.** The `customer.subscription.updated`/`.deleted` webhook is what updates the DB (§7). This is intentional.
- Never pass a client-supplied `customer` id — only the one bound to `auth.uid()`.

---

# Section 7 — Stripe Webhook Endpoint (authoritative)

## 7.1 Route contract

**Path:** `POST /api/stripe/webhook` — `[VERIFY]` this path is not already taken by another webhook in the real repo.

```ts
export const runtime = 'nodejs';   // MUST NOT be edge: needs raw body + node crypto
export const dynamic = 'force-dynamic';
```

**Critical implementation rules**

1. Read the **raw** body: `const raw = await req.text()`. Do **not** `await req.json()` first — that consumes the stream and breaks the HMAC check. (App Router does not auto-parse, so no `bodyParser: false` config is needed as it was in Pages Router.)
2. Require the signature header: `const sig = req.headers.get('stripe-signature')`. Missing ⇒ `400` immediately.
3. Verify **before** any other work:
   ```ts
   const event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!);
   ```
   Wrap in `try/catch`; on failure ⇒ **`400 { error: 'invalid_signature' }`** and do not touch the DB.
4. Verify the event came from a configured Stripe account: reject unexpected `event.account` if you ever use Connect.
5. Respond `200 { received: true }` **only** after processing completes (or after a durable enqueue). Returning 200 before processing means a crash loses the event forever.
6. On handler failure return **`500`** so Stripe retries. Do not swallow errors into a 200.
7. Never return Stripe error bodies or stack traces to the caller — log server-side only.
8. Use the **service-role** Supabase client here (writes bypass RLS by design). This client must never be importable from client code.

## 7.2 Idempotency algorithm (mandatory)

```sql
-- schema §4.9; the ONLY correctness primitive that stops duplicate grants
insert into public.stripe_events (stripe_event_id, type, api_version, livemode, payload)
values ($1, $2, $3, $4, $5)
on conflict (stripe_event_id) do nothing
returning id;
```

- **Zero rows returned ⇒ the event was already recorded ⇒ return `200 { received: true, duplicate: true }` and do NOT re-apply it.** This is the guard against Stripe's aggressive retries.
- Process, then mark `processed_at = now()`.
- On failure, store `processing_error` + increment `attempts`, and return `500` so Stripe retries. Make each handler **safe to run twice** anyway (upserts, not inserts/increments) — belt and braces.
- Keep the raw `payload` **minimal**: store the object IDs and statuses you actually need for reconciliation, not the entire customer object (spec §32 data minimisation). Consider a retention/pruning policy.

## 7.3 Events to handle (scoped to what this implementation needs)

| Event | Handler action | Grants/revokes access? |
|---|---|---|
| `checkout.session.completed` | Tamper check `client_reference_id === user_id`; create/link `subscriptions` row from `session.subscription`; record `stripe_customer_id`; store `checkout_session_id` | Creates the record; entitlement follows from status |
| `customer.subscription.created` | Upsert subscription verbatim from the Stripe object (status, price, period, trial, cancel_at_period_end) | Yes (usually `active`/`trialing`) |
| `customer.subscription.updated` | Same upsert. Covers **renewal**, **plan change (up/downgrade)**, `cancel_at_period_end`, `past_due`, `paused`, trial→active | Yes — plan/status change |
| `customer.subscription.deleted` | Set terminal status (`canceled`), `ended_at`, revert plan to `free` | **Revokes** |
| `invoice.paid` | Upsert `invoices`, set `paid_at`; upsert `payments`; keep subscription active; feeds MRR/revenue reporting | Confirms/renews |
| `invoice.payment_failed` | Upsert invoice status; flag `paymentIssue`; surface a billing banner; start the grace policy | No immediate revoke (grace) |

**Intentionally NOT handled in this phase** (add only when the feature exists): `invoice.payment_action_required` (SCA), `charge.refunded` (unless refunds are offered), `customer.subscription.trial_will_end`, `price.*`/`product.*` (sync manually), any Connect events.

## 7.4 Resolving `user_id` in a webhook (never trust blind metadata)

Priority order, and **verify** rather than assume:

```
1. subscription.metadata.user_id        (set at Checkout creation)
2. checkout.session.client_reference_id (verified == session metadata user_id)
3. billing_customers lookup by stripe_customer_id   <- most reliable for lifecycle events
4. invoices/customer email match         <- LAST RESORT; ambiguous, may be shared
```

If no user can be resolved, **record the event and log an alert — do not drop it silently and do not guess.** Add an "unmatched events" admin view if volume warrants it.

## 7.5 Local testing

```bash
# Stripe CLI, no secrets in the repo:
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook   # prints a whsec_… for the session
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger invoice.payment_failed
stripe trigger customer.subscription.deleted
```

Replay the **same event twice** and assert: one `subscriptions` row, one `invoices` row, one `stripe_events` row, and no second entitlement grant. That single test is the proof of §7.2.

---

# Section 8 — Entitlement Enforcement & UI Contracts

## 8.1 Server-side guard (the only authority)

```ts
// src/lib/billing/guards.ts   (SERVER ONLY)
type GuardResult =
  | { ok: true }
  | { ok: false; status: 401 | 402 | 403; body: ApiError };

requireEntitlement(userId: string, featureKey: string, cost = 1): Promise<GuardResult>
```

Rules:

1. **Every** gated operation calls the guard **before** doing work: opportunity search, advanced filters, watchlist add beyond limit, report generation, pipeline, portfolio analytics, bulk discovery, API access.
2. The guard reads `plans`/`plan_features` + `entitlement_overrides` (never a literal tier string).
3. Numeric limits require a **usage counter** to be meaningful (e.g. opportunities searched this month). Decide the counting window (calendar month vs. rolling 30 days), store it, and reset it — otherwise `search.opportunities_per_month` is decorative. Counting must be server-side.
4. Exceeding a limit returns `402 { error: 'plan_upgrade_required', requiredFeature }` so the UI can show a targeted upgrade prompt — not a generic error.
5. Admin-only routes call `requireAdmin()` (role from the existing profile/role system, spec §22 line 655) — reusing the repo's existing role mechanism, not a new one.

## 8.2 Client-side checks are advisory only

Allowed: hiding buttons, showing tier badges, disabling premium tabs, rendering "Upgrade to Pro" prompts.
Forbidden: relying on any of it for access control. Assume a user can call every endpoint directly with `curl` and that the UI is fully bypassable.

**Bypass test (must be performed):**
```
1. Set a user to Free.
2. With a Free session cookie, POST each premium endpoint directly.
   Expected: 402 plan_upgrade_required, and NO data returned.
3. POST /api/billing/checkout with:
   { planKey:'pro', billingInterval:'month', amount: 1 }        -> 400 (unknown key)
   { planKey:'pro', billingInterval:'month', priceId:'price_x' } -> 400 (unknown key)
   { planKey:'free', billingInterval:'month' }                   -> 400 (not purchasable)
   { planKey:'enterprise', billingInterval:'month' }             -> 400 (sales-only)
4. Navigate directly to the success URL without paying.
   Expected: no paid features; state still 'none'/free.
5. Send a forged webhook POST without a valid signature -> 400, DB unchanged.
```
Step 4 and 5 are the explicit proof of "paid entitlements cannot be activated by manipulating frontend requests."

## 8.3 UI surfaces to build or extend

| Surface | Requirement | Notes |
|---|---|---|
| `/pricing` | View plans, compare features, select plan, start checkout | `[VERIFY]` if it exists (spec §28 line 819 lists `/pricing`) — **extend, do not duplicate** |
| Billing dashboard page | Current plan, status, renewal date, "Cancels on", payment status, manage billing, cancel/change | Spec §17 line 515 already lists a "Billing" dashboard item — extend it |
| `/billing/success` | Cosmetic confirmation + activation polling | Never grants access |
| `/billing/cancelled` (or `?checkout=cancelled` on `/pricing`) | Clear "no payment taken" message + retry | |
| Upgrade prompts | Contextual, showing the specific missing feature and the plan that unlocks it | Driven by `requiredFeature` from the 402 body |
| Billing banner | `past_due` / failed payment notice with portal link | Non-blocking but prominent |

## 8.4 States to implement (all four, non-negotiable)

| State | Behaviour |
|---|---|
| **Loading** | Checkout/portal buttons show a spinner and are disabled to prevent double-submit (plus server-side `Idempotency-Key`) |
| **Success** | Real DB-confirmed state only. If the webhook hasn't landed: "Payment received — activating…" then poll |
| **Cancellation** | "Checkout cancelled. You have not been charged." — never a red error for a deliberate cancel |
| **Error** | Actionable copy ("We couldn't reach the payment provider. Please try again.") + support path; log server-side |

**Explicitly forbidden** (your requirement): any UI that shows a fake payment confirmation, or claims success before the webhook confirms it.

## 8.5 Accessibility & design preservation

- Preserve the existing AssetScout design system; reuse existing buttons/cards/badges — do not introduce a competing component library or restyle the app.
- Pricing table: use a real `<table>` (or `role="table"`) with `<th scope>` headers, not a grid of divs, so screen readers announce plan/feature pairs.
- Checkout/portal buttons: real `<button>` elements with `aria-busy` during loading; visible focus states; keyboard reachable; disabled states announced.
- Status messages (`loading`/`success`/`error`) use a live region (`role="status"` / `aria-live="polite"`) so status changes are announced.
- Price currency changes must not rely on colour alone; include the currency code in text (spec §27: mobile-first, responsive).
- Do not break the mobile-first requirement (spec §27 line 785).
