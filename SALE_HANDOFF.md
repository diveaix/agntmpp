# ./AGENT sale handoff

Status: implemented in substantial part, unfinished, not approved for customer funds. No deployment or live sale is included in this handoff.

## What exists

- Exact 4,444-pass compounded ZEC price schedule, atomic purchases and account-bound holdings.
- PostgreSQL available/held-credit accounting, idempotent deposits/purchases/withdrawals, journal reconciliation and private history export.
- Deposit observation and isolated signing adapters, durable signed-byte recovery, two-operator payout approvals and fee-inclusive authorization caps.
- Stored access-policy binding and quota checks; actual access duration and allowance remain undecided.
- Authenticated sale frontend and API, pending-request retry/cancellation, and account-generation recovery for lost request keys.

These are database-managed access collectibles, not native transferable Zcash NFTs. Prepaid ZEC makes the operator a custodian.

## Verification that can be claimed

- The last captured full `npm run check` passed 191 tests, TypeScript and build before the subsequent request-generation feature.
- Subsequent request-generation work passed focused client/service/HTTP tests, TypeScript and frontend build.
- The full disposable PostgreSQL harness subsequently passed recovery-reset/submission races, 4,444-pass sellout, accounting reconciliation and pg_dump/pg_restore. Temporary database/container cleanup succeeded.
- Earlier actual-wallet regtest verification covers confirmed funding, purchase, signing/restart and payout settlement. It is not evidence of deployed infrastructure readiness.
- The latest extended browser recovery test has **no captured terminal result**. Its process handle disappeared and no matching running process was found. Do not count it as passed.

## Remaining engineering work

1. Finish browser verification of generation-based recovery, including failed reset responses and retained drafts.
2. Reconcile verified wallet assets, pending payouts and owned change against customer liabilities. Internal journal reconciliation and wallet totals alone do not prove coverage.
3. Finish signer crash/restore coverage, restricted production roles, and audited operator/policy provisioning.
4. Resolve production authentication-store concurrency, worker scheduling/alerts, and coordinated off-host database/wallet recovery.
5. Finalize artwork/content hosting and receipt-key trust publication, then run hosted end-to-end verification and independent security review.

Do not turn this list into an open-ended series of optional enhancements. Agree on the next bounded deliverable before another long execution session.

## Decisions and infrastructure needed from the owner

- PostgreSQL hosting and Zcash wallet/node deployment choice: not yet supplied.
- Pass access duration and usage allowance: explicitly deferred.
- Published custody/refund/fee/eligibility rules and approved confirmation/treasury risk limits.
- Explicit authorization for any deployment or real-money pilot; neither is implied by passing tests.

## Safety state

`src/mcp/sale/runtime.ts` unconditionally reports launch, funding and withdrawals disabled. `requireSaleLaunch()` always rejects. Keep these gates intact until the missing requirements are independently verified; do not replace them with a single environment flag.

The detailed historical evidence remains in `SALE_IMPLEMENTATION_STATUS.md`; some older paragraphs there are superseded. This handoff separates implementation from verification and does not certify production readiness.
