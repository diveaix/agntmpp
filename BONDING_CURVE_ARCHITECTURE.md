# ./AGENT ZEC bonding-curve access sale

Status: proposed architecture, 2026-09-20. Documentation only; no sale, wallet or payment integration is enabled.
Model: ZEC-funded, database-managed access collectibles, following the application-led ownership model discussed with the user.
This is not native Zcash asset issuance, a trustless on-chain bonding curve, or a guaranteed investment return.

## 1. Product rules and proposed defaults

| Property | Design |
|---|---|
| Maximum supply | 4,444 passes |
| First price | 0.02 ZEC |
| Growth | 0.04444% compounded per successfully purchased pass |
| Settlement currency | ZEC; USD display is informational only |
| Ownership source of truth | ./AGENT PostgreSQL ledger |
| Purchase funding | Confirmed, custodial prepaid ZEC credit |
| Price advancement | On atomic purchase commit, never on deposit or quote |
| Rights | Access to supported tool categories, subject to published usage limits and safety gates |
| Multiple passes | Allowed by design; no automatic multiplication of usage quotas |
| Resale / transfers | Disabled in v1; later explicit ownership-transfer feature |
| Curve sell-back | Not offered; no redemption reserve or guaranteed resale value |
| Unsold credit | Withdrawable, subject to disclosed fees and security review |
| Purchase refunds | Separate policy to approve before launch; not automatic curve sell-back |
| API credentials | Account-scoped; collectible is an entitlement, not a bearer API secret |

Supply includes any team allocation. Recommended default is no unpriced allocation. Any giveaway, reserve or changed supply requires a revised published policy before opening.
Access duration, quotas, per-account purchase caps, fee policy and legal eligibility remain launch decisions. Do not market perpetual unlimited usage before those are defined.

## 2. Logical components

| Component | Responsibilities | Must not do |
|---|---|---|
| Existing frontend | Balance, funding request, price/quantity preview, receipt, holdings and withdrawals | Declare payment final from a pasted transaction ID |
| Existing auth/API/MCP | Authenticate users, issue scoped credentials, expose sale reads and requests | Equate pass ownership with permission to spend a wallet |
| Sale service | Quote curve, serialize purchases, allocate passes, issue receipts | Trust client price or advance sold count for an unpaid quote |
| Zcash observer | Validate received outputs, confirmations, canonical blocks and reorgs | Hold spending keys or expose viewing keys to clients |
| Treasury signer | Approve/sign withdrawals in an isolated boundary | Accept arbitrary transaction payloads from the AI or public API |
| PostgreSQL | Accounts/ledger, deposits, purchases, passes, entitlements, jobs and audit | Depend on an in-memory sold counter |
| Durable worker | Deposit reconciliation, withdrawal submission/recovery, entitlement events | Re-send a payout solely because an HTTP request timed out |
| MCP policy gate | Resolve current entitlement, quota, action permissions and execution limits | Bypass production-disabled adapters or admin restrictions |

Start with a modular Node API plus one worker and PostgreSQL. Vercel remains the frontend host.
A Zcash wallet/node/scanner connector is a separate deployment boundary where required by the selected software; choose and validate its actual APIs before implementation.

## 3. User journey and timing

1. User authenticates and requests a dedicated deposit address.
2. User sends ZEC from their own wallet.
3. UI shows observed payment and confirmation progress. No spendable sale credit yet.
4. Observer verifies canonical receipt under the published confirmation policy.
5. Deposit is credited exactly once.
6. User previews quantity and authorizes a maximum total ZEC spend.
7. Database transaction debits credit, advances supply and creates passes.
8. Tool access is available after commit; no extra Zcash transaction is needed per purchase or tool call.
9. User may withdraw unused credit through the controlled payout pipeline.

Only steps 2-5 wait on Zcash settlement. Purchases after funding are database operations; do not advertise a guaranteed latency before measuring the deployment.
Do not grant irrevocable passes or paid tool usage for an unconfirmed deposit. A transaction seen in a mempool may disappear or conflict.
Confirmation count is a treasury risk policy, not a universal network constant. Choose it after evaluating deposit values, chain conditions, node/wallet behavior and withdrawal exposure. Three confirmations in another application's configuration is not a security endorsement.

## 4. Exact curve arithmetic

Let s be the number of passes already sold, starting at zero.

P(s) = 2,000,000 * (2501111 / 2500000)^s zatoshis.

This is exactly 0.02 ZEC * 1.0004444^s before integer rounding.
Define the charged price of each pass as ceil(P(s)) zatoshis. Compute each term from the original rational formula, not from the preceding rounded price.

For quantity q:
total(s,q) = sum of ceil(P(s+i)), for i = 0 through q-1.

Use BigInt integer arithmetic and precompute the 4,444 prices plus prefix totals once from a reviewed, versioned formula.
Persist the schedule/version hash when opening the sale. Do not change prices after purchase or use floating-point math for accounting.
The preview API returns atomic-unit strings plus human-readable ZEC. JavaScript Number is not the accounting representation.

Approximate figures before per-pass rounding:
- Pass 1: 0.02 ZEC.
- Pass 4,444: 0.14399273925063777 ZEC.
- Total sellout: 279.1555572096326 ZEC.

Verified with exact BigInt arithmetic under this rounding policy: first pass 0.02000000 ZEC; last pass 0.14399274 ZEC; total sellout 279.15557929 ZEC.

Network fees and any disclosed platform charges are separate. There is no USD price peg.
A multi-pass order takes consecutive indices and advances the curve once per pass, atomically.
No burns or administrative refunds decrease sold_count or resell a consumed index.

## 5. Quote and concurrency semantics

A quote is a preview, not an unpaid reservation.

Quote response:
quote_id, curve_version, sold_count_snapshot, quantity, preview_total_zatoshi, expiry, available_supply.

Purchase request:
quantity, max_total_zatoshi, curve_version, quote_id, idempotency_key.

Before submission, the UI explains that another purchase may advance the price. Default max_total is the displayed total; the user may explicitly approve additional tolerance.
At execution, calculate from current sold_count and reject if above max_total, expired, sold out or insufficient credit.
Never silently reduce quantity. Reject the entire order if less supply remains.

Ordering is the database's serialized purchase order, not browser click time, deposit time or an alleged public-chain ordering.
Publish that this is operator-mediated ordering. Rate limits and account verification reduce spam but do not guarantee Sybil resistance or perfect fairness.

Atomic transaction:
1. Authenticate owner and require recent authentication for sensitive actions.
2. Establish/replay the unique owner + idempotency key; a changed payload with the same key is rejected.
3. Lock sale state, then the buyer's balance in a consistent order.
4. Validate sale open, supply, curve version, credit and max total.
5. Debit buyer credit and credit sale proceeds using balanced ledger entries.
6. Insert purchase and exactly q uniquely numbered passes.
7. Advance sold_count by q and grant/recompute entitlement in the same transaction.
8. Insert an outbox event and commit.
9. Return durable receipt; worker delivers notifications afterward.

A server crash before commit changes nothing. A crash after commit returns the existing receipt on retry.
A notification or cache failure cannot roll back the completed purchase.
Do not debit credit now and allocate passes in a later unrelated transaction.

## 6. Minimum data model

| Entity | Key fields and constraints |
|---|---|
| sale | id, status, supply_cap, sold_count, curve_version, schedule_hash; sold_count <= cap |
| deposit_address | user_id, network, receiver/pool, unique address identity, scan start; never recycle between users |
| deposit | network, txid, received output/note identity, address_id, amount_zatoshi, block hash/height, status, credited ledger ID |
| ledger_transaction | id, type, external reference, status, created_at |
| ledger_entry | ledger_transaction_id, account_id, debit/credit, amount_zatoshi; every transaction balances |
| account_balance | user_id, available/held credit, version; updated transactionally and reconcilable to ledger |
| purchase | id, user_id, quantity, first/last index, total, curve_version, idempotency_key, request hash |
| pass | collection_id + serial unique, owner_id, purchase_id, state, metadata hash |
| entitlement | user_id, source, status, policy_version, version; effective rights derived from active passes |
| withdrawal | id, user_id, amount, fee limit, destination, status, idempotency_key, signed payload reference, txid |
| outbox / jobs | unique event ID, attempts, next retry, state |
| audit_event | actor, operation, reason, timestamp, minimal structured change record |

Deduplicate deposits by an actual received output/note identity, not txid alone: one transaction can contain multiple relevant outputs.
Store monetary amounts as integers (BIGINT/NUMERIC with explicit bounds); API amounts are decimal strings.
Ledger corrections use compensating entries, not deletion or editing of historical credits.

## 7. Zcash custody and deposit verification

Prepaid balances are customer liabilities. This makes ./AGENT a custodian of funding, not merely a frontend.

Preferred deposit UX: dedicated shielded receiver/address per account, using a tested wallet/scanner. Keep viewing authority isolated from spending authority.
If only transparent deposits are supported at launch, disclose this clearly and do not label them shielded.
A browser-provided txid can accelerate lookup but is never proof of payment or account ownership.

Observer verifies:
- correct network and assigned recipient;
- actual received amount;
- note/output uniqueness;
- block inclusion and canonicality;
- configured confirmation threshold;
- no prior credit for the same receipt.

Continuously reconcile ledger liabilities against verified wallet balances, pending payouts and treasury classifications.
Maintain enough liquid ZEC to cover customer available/held balances and fees. Do not use unspent customer deposits for operating expenses.
Move only earned sale proceeds under a separate treasury policy. Proceeds still need reserves for disclosed refunds and operating commitments.

If a previously credited receipt is orphaned, freeze affected available credit and outbound payouts, re-evaluate canonical receipt and enter recovery.
If credit was already spent, mark the dependent entitlement provisional/suspended pending review and account for the deficit explicitly.
Do not reuse its pass serial or silently erase the purchase. Publish how affected users will be handled.

## 8. Unused-credit withdrawals

Withdrawals are not NFT sell-backs.

Flow:
REQUESTED -> HELD -> APPROVED -> SIGNED -> BROADCAST -> CONFIRMING -> PAID.

Branches: REJECTED, CANCELED_BEFORE_SIGNING, UNKNOWN_BROADCAST, REORGED, MANUAL_REVIEW.

- Require recent authentication; validate destination/network and obtain explicit fee approval.
- Move requested credit from available to held atomically before signing.
- Serialize treasury spends or use wallet-supported note locking to avoid conflicting shielded spends.
- Store signed transaction bytes/hash securely before broadcast.
- After timeout, reconcile or rebroadcast the same transaction; never build an unrelated replacement blindly.
- Settle held balance when canonical payment is confirmed; account for actual fees and release unused fee reserve.
- Do not release held funds while an already signed transaction could still become valid/confirmed.
- Changing a destination requires canceling the old unsigned request and making a new approved request.
- Refund/withdrawal addresses are explicitly supplied and validated; never assume the sender's address can be recovered from a shielded payment.

Treasury signer access is separate from normal MCP tools. Administrative approvals, hot-wallet limits, alerts, backups and restore procedures are required.
Selling out closes purchases, not the ability to withdraw unused credit.

## 9. Pass ownership, metadata and tool gating

Collectibles have stable IDs, immutable issuance receipts and content hashes for metadata/artwork.
Artwork hosting can use durable object storage or content-addressed storage; a metadata hash does not create a consensus-enforced NFT.
A signed receipt is evidence of an issuance event, not proof of current ownership after a future transfer.

V1 passes are account-bound. Private collection images may be public; ownership/account mapping is private to the service and authorized user.
Offer user holdings/history export and publish recovery policy. Do not claim ownership survives operator disappearance in the same way as a independently transferable on-chain asset.

Existing integration points:
- access-types.ts / access-control.ts: add a distinct collectible entitlement source, not a fake paid subscription.
- tools/account.ts and dashboard snapshot: expose current rights and holdings.
- tools/index.ts: authenticate and check effective entitlement centrally before applicable dispatch.
- A2A and automation: resolve current entitlement again at execution, not only task creation.
- Existing API keys and connector URLs stay account-bound; no spending keys are moved between accounts.

Tool checks: valid auth -> active user -> entitlement -> quota -> action permissions -> runtime readiness -> wallet-specific spending authorization.
A pass does not enable admin functions, unrestricted plugin installation, unsupported protocols or disabled live execution.
Define which fees/tool quotas ownership covers before launch. Gas, third-party data fees and external protocol costs are not implicitly free.

Use current entitlement version or a fail-closed short cache with explicit invalidation. Do not grant indefinite rights inside long-lived API tokens.
If transfers are later enabled, transfer ownership and recompute both accounts' entitlements atomically. Stop future queued actions authorized solely by the former owner's pass.
Existing in-flight blockchain transactions cannot be undone by an entitlement change.

## 10. Proposed API surface

Names below are proposed, not existing routes.

GET /sale                     public price schedule/version, sold count and status
POST /sale/quote               quantity preview; no inventory reservation
POST /sale/purchases           authenticated, idempotent, max-total-bound purchase
GET /sale/purchases/:id        owner-only receipt
GET /sale/balance              available, held and confirming credit
POST /sale/deposit-address     authenticated address allocation; retry-safe
GET /sale/deposits             owner-only deposit state
GET /sale/passes               owner-only collectible list
POST /sale/withdrawals         authenticated, idempotent payout request
GET /sale/withdrawals/:id      owner-only payout state
GET /access/entitlements       effective rights and policy version

Rate-limit address creation and quotes as well as purchases. Apply CSRF protection where cookie authentication is used.
No public endpoint may modify prices, confirmation policy, credits, supply or pass ownership.
Admin changes require explicit roles, audit and dual control for treasury/policy changes.

## 11. User-visible states

- Funding requested: no funds detected.
- Payment detected: not yet spendable.
- Confirming: show current/required confirmations, not a guaranteed countdown.
- Credit available: purchase can proceed.
- Price changed: no debit; review new price.
- Purchased: immutable receipt and pass IDs.
- Sold out: purchases unavailable; unused credit remains withdrawable.
- Withdrawal pending/confirmed: separate from sale completion.
- Recovery required: clear reason and support path, no false success.

Show sold passes separately from deposited ZEC. Depositing does not guarantee allocation or reserve a price.
No fake mint counters or manual sold overrides; counts derive from committed issuance records.

## 12. Verification and release gates

Pricing:
- First pass costs exactly 2,000,000 zatoshis.
- Rational multiplier is 2501111/2500000, not 1.04444.
- Every subsequent charged price is monotonic.
- Multi-buy total equals sum of individual scheduled prices.
- Integer rounding is deterministic across API, worker and UI.

Concurrency:
- Many requests for the final pass result in exactly one purchase.
- Same idempotency key never causes a second debit; changed payload is rejected.
- Purchase vs withdrawal cannot overspend one balance.
- Crash before/after commit preserves ledger and inventory consistency.
- Inventory count equals issued serials, with no gaps caused by failed purchases.

Settlement:
- Same received output cannot credit twice.
- Wrong network/address or fabricated txid never credits.
- Observer outage, scan replay and reorg recover without duplicate credit.
- Unknown payout broadcast cannot trigger duplicate payouts.
- Pending withdrawal holds remain recoverable after worker restart.

Access/security:
- Users cannot read others' deposits, holdings or receipts.
- Entitlement loss stops future paid calls/automations.
- Pass ownership never bypasses wallet authorization.
- Backup restoration preserves ledger, signing state and idempotency.
- Logs contain no private keys, viewing keys or full user payment history.
- Reconciliation detects accounting shortfall and pauses new purchases/payouts as appropriate.

Release sequence:
1. Freeze sale/access/custody/refund rules.
2. Build and test pure pricing plus database transaction core.
3. Integrate Zcash observer and isolated withdrawal signer on a test environment.
4. Integrate existing account/API entitlement checks.
5. Exercise failure recovery and independent security review.
6. Run a capped pilot before opening full supply.

No production funds, launch date, confirmation threshold, transferable NFT claim or lifetime access promise is authorized by this architecture alone.
