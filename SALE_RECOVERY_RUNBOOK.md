# Sale recovery prerequisites and stop conditions

This is an engineering recovery checklist, not approved customer refund terms or permission to operate a live treasury. Production infrastructure, access terms and launch approval are still absent. Keep real-money routes disabled.

## Verified local drill

Run `npm run sale:test:postgres` only in a development environment with Docker. It creates its own loopback-only PostgreSQL container and synthetic data; it does not use an application database URL.

The backup drill quiesces its test workload, creates custom-format `pg_dump` archives in memory and restores accounting and signer databases into **new** databases. It compares every public application table, reconciles all 4,444 pass serials and ledger balances, checks purchase retry identity, compares stored signed artifacts and verifies that unresolved signing locks still prevent new wallet calls. The restored sale is explicitly paused before recovery checks. Cleanup removes only the labeled disposable container and its temporary databases.

This drill does not prove off-host durability, encrypted backup storage, point-in-time recovery, production role restoration, wallet-key recovery or consistency of independently timed backups. Its fixture uses `--no-owner --no-privileges`; production grants require separate validation before any service connects.

## Before a production backup plan can be approved

- Choose database and wallet hosting, restricted roles, encrypted off-host storage, retention and an acceptable recovery point/time. Do not silently assume daily backups are sufficient for a treasury.
- Cover accounting, signer intents/artifacts/locks, deposit assignments/cursors, account identity mappings and wallet recovery material. A wallet seed alone cannot restore the service's pass ownership or idempotency records.
- Keep spending material separate from application backups and access roles. Signed transaction artifacts also carry broadcast authority and require restricted handling.
- Establish coordinated recovery points or a proven reconciliation procedure across accounting, signer and wallet state. Two successful independent backups are not evidence of mutual consistency.
- Record backup identifiers, schema/application versions and successful restore-drill results without including raw transactions, keys or customer histories in operational logs.

## Incident and restore sequence

Read-only inspection: `npm run sale:status` reports aggregate sale state, frozen-account count, orphaned-credit count, withdrawal states/oldest age and notification queue states/delay. It prints no account IDs, destinations, transaction bytes or receipt history. Exit code 1 means a review signal or unavailable report; exit code 0 means only that this report succeeded without those signals. It never proves wallet solvency, observer/signer liveness, ledger reconciliation or permission to launch. It does not install monitoring, choose alert thresholds or change account/sale state.

1. Disable new financial operations and stop treasury signing/broadcast workers. Preserve the current databases, wallet state and existing logs; do not overwrite the only surviving evidence with a backup.
2. Restore into an isolated new environment with no production worker credentials or public financial routes. Verify backup integrity, database permissions and wallet recovery separately.
3. Keep the sale paused. Compare accounting and signer intent identities, all stored artifacts, unresolved wallet locks, deposit mappings and scan checkpoints. Run internal ledger reconciliation. It checks bookkeeping, not actual wallet solvency.
4. Independently verify canonical chain receipts and payouts against a fresh, correctly identified node and synchronized wallet. Reconcile wallet assets with available/held customer liabilities and earned proceeds. Unavailable evidence is not proof of non-payment.
5. Recover only the first verified saved artifact for each approved intent. Do not call the signer again merely because an accounting row, artifact or acknowledgment is absent from the restored backup. A later transaction may exist outside that backup's recovery point.
6. Do not delete ambiguous signing locks, release signed holds, refund, replace transactions, reuse serials or reopen access automatically. Escalate missing artifacts, inconsistent recovery points, expired transactions and reorganized receipts/payments for documented operator review.
7. Resume only after the incident-specific reconciliation, required independent review and explicit authorization. Successful tests or a `PAUSED` database row do not themselves authorize production reopening.

## Unresolved policy decisions

### Treasury authorization caps

`npm run sale:status` reports the configured caps, exact outstanding authorization exposure, remaining capacity and oversized pending-payout count in its existing read-only snapshot. Missing settings return null limits/capacity, not healthy zeros. Outstanding payouts with no configured limits or payouts exceeding configured limits raise review signals. The command never changes limits, releases holds, signs, or broadcasts. Remaining authorization capacity is not a wallet liquidity figure.

`agnt_treasury_limits` has no default row. New approval and new signing fail with `treasury_limits_unconfigured` until approved values are provisioned. `max_payout` bounds principal plus the full fee reserve; `max_outstanding` bounds the same total across APPROVED, SIGNED, BROADCAST and REVIEW requests. The approval transaction locks the singleton limit row so different customer accounts cannot each consume the same remaining capacity. HELD requests are not yet authorized; PAID and CANCELED requests do not consume outstanding authorization capacity. Ambiguous requests have no time-based release. Existing signed-artifact recovery remains possible without creating another signature.

These are aggregate authorization-exposure caps, not wallet balance limits or proof of solvency. They do not bound daily cumulative turnover, enforce a cold/hot-wallet split, or independently verify pending change. Production risk values and a dual-control/audited policy-provisioning workflow are still absent. Do not copy the synthetic values in `scripts/test-sale-approvals.ts` into production or change a policy row directly as an operational workaround. Run the explicit schema migration; it creates no configured limit and does not unlock the sale.

### Two-person withdrawal approval implementation boundary

The core now records immutable payment-bound votes in `agnt_withdrawal_approval_votes`, with an empty-by-default `agnt_treasury_operators` allowlist. `SaleService.approveWithdrawal` requires two distinct currently enabled, authorization-version-matching votes before HELD can become APPROVED. Customer self-approval is excluded. New signing rechecks these votes; artifact recovery does not re-sign. Existing approved rows lacking votes cannot start new signing. Run the explicit schema migration before using this code.

The operator HTTP path now uses the existing authenticated dashboard session: `GET /api/sale/operator/withdrawals/:id` returns a restricted payment preview and its hash only to enabled operators. `POST /api/sale/operator/withdrawals/:id/approve` accepts only `reason` and `payloadHash`, requires recent server authentication and trusted origin, and remains behind the hard launch gate. It records the session actor's vote and requests the guarded transition after two valid votes. It never signs or broadcasts. Replaying the same existing vote after approval does not add a vote. A stale preview hash is rejected before insertion. No request-body actor identity is accepted.

Production provisioning and an approved operator list are still absent. Synthetic test provisioning lives only in `scripts/test-sale-approvals.ts`, not application code. The internal vote recorder is a trusted composition API, not an authentication mechanism. Revocation disables vote counting; reauthorization must use a new authorization version. Old votes are not overwritten. A HELD request with conflicting historical votes can be canceled and replaced through the normal customer flow; never edit its destination or erase votes as a repair.

The required implementation must:

- Authorize two distinct authenticated operator identities from an explicitly provisioned allowlist; the customer ID on a withdrawal is not the approving actor. Shared credentials cannot establish two-person approval.
- Bind both votes to the exact withdrawal ID, owner, destination, principal, fee cap and policy version. Keep actor, reason, time and the approved payload hash in a separate durable audit record; customer notification ownership is not an audit actor.
- Serialize vote insertion and the final HELD-to-APPROVED transition with account/withdrawal locks. A duplicate vote is replay-safe but never counts twice. A frozen account, changed payload or canceled request must not become approved.
- Preserve cancellation while the request remains unsigned HELD; any votes on a canceled request must remain historical evidence, not revive it. Once APPROVED, retain the existing no-cancel/no-automatic-release rule.
- Enforce the vote requirement inside the transition itself, not only in a future HTTP/CLI wrapper, so the current internal method cannot bypass it. Legacy APPROVED records without verifiable approval evidence require review before new signing; saved artifacts still require recovery rather than re-signing.
- Verify unauthorized actors, duplicate votes, revoked operators, changed payment details, simultaneous second votes, cancellation/freeze races and audit preservation on backup/restore. Test fixtures must explicitly provision identities; no default production approvers or test bypass flags.

No production operator identities or roles have been provisioned. PostgreSQL tests cover duplicate concurrent votes, simultaneous final approvals, approval/cancellation races and approvals blocked behind committed operator revocation/account freezes, including preserved audit records and holds. Local HTTP tests also exercise the actual dashboard session resolver and logout/re-login using an isolated authentication store. Hosted/browser/email-provider E2E, deployment permissions and operational provisioning remain release work. None of these database/session tests imply that an already-started wallet RPC can be revoked. The sale launch gate remains closed.

### Wallet balance is not full payout coverage

Artifact loading now checks the saved network/intent hash against the corresponding durable signing claim in the same read, in addition to validating field shapes, payload size and the stored raw-byte hash. A missing or conflicting claim is recovery failure, not permission to create another payment. These consistency checks do not independently prove that a well-formed transaction ID belongs to the bytes, or protect against an administrator rewriting both records; trusted wallet validation and restricted signer storage remain required.

Run `npm run sale:signer:status` in the isolated signer environment to inspect aggregate durable claims, wallet locks and saved-artifact counts using `AGNT_SALE_SIGNER_DATABASE_URL`. It does not use wallet RPC, sign, broadcast, mutate rows or print transaction bytes/references. Exit 1 means unavailable, unresolved signing or record conflicts; inspect the sanitized output to distinguish them. An unresolved claim may still be running. `with_artifact` means a saved row exists while its wallet lock remains, not that its bytes or payment are verified. Exit 0 is not proof of wallet coverage, worker liveness or launch readiness. No alert schedule is installed.

Signer and broadcaster workers re-read current approval/transaction fields and the account freeze flag immediately before invoking the wallet signer or submitting saved bytes. A freeze observed at those checkpoints prevents the new external call; a changed intent requires review. This is not atomic revocation across PostgreSQL and wallet RPC: a freeze after the final check cannot cancel an already-started request. Continue treating its signing claim, saved transaction and customer hold as potentially live. A pre-call rejection retains durable signer claims conservatively; do not delete them and automatically retry without reviewing wallet outcome.

`observeWalletInventory` returns wallet-reported spendable notes at an explicit depth. Do not subtract total customer liabilities from that number and label the difference an insolvency loss or withdrawable surplus. An APPROVED payout may already have locked wallet inputs before its signed artifact and SIGNED ledger state are committed; SIGNED/BROADCAST payouts may also have pending change. Their holds must remain intact. A wallet restart is not evidence that those notes are safe to reuse.

The observation also returns separate pending and dust totals, reconciled across both pinned balance RPC responses. Pending includes both change and other funds waiting to become spendable; it is not a per-payout change proof. Neither category is added to spendable funds. `lockedZatoshi: null` means the pinned RPC cannot report that category, not that no notes are locked. Use transaction-specific owned-output evidence before attributing any pending amount to a payout.

The [pinned beta.3 detailed balance implementation](https://raw.githubusercontent.com/zcash/zallet/v0.1.0-beta.3/zallet-core/src/components/json_rpc/methods/get_balances.rs) explicitly leaves locked-output reporting unimplemented. An omitted `locked` field is therefore not evidence of zero locked funds. Account spending authority, persisted signing claims/artifacts, canonical payout evidence and owned change need reconciliation before declaring coverage. Never add the full signed transaction input value and its change to reserves at the same time, release an ambiguous hold, or create a replacement payout to make reported balances agree.

Credited deposits that lose sufficient canonical backing now retain one `agnt_sale_credit_reviews` record per received output. `credited_amount` is the gross value previously credited, not a net treasury-loss calculation or customer debt. Coverage can be `ORPHANED`, `UNCONFIRMED` or `RESTORED`; restored evidence does not close review or unfreeze access. The operator report aggregates these exact zatoshi amounts and flags orphaned credited receipts missing a review record, including legacy data. Re-verify those receipts with the trusted observer; do not fabricate a production confirmation threshold to backfill them. Owner exports include their review records. Financial compensation, deficit allocation and closure still require an approved policy and reconciliation against actual wallet assets.

User-facing custody/refund terms, how deficits after a chain reorganization are handled, signer approval roles, hot-wallet limits, backup retention and reopening authority are not approved. They must be resolved before a sale accepts funds. The implementation intentionally has no automatic financial repair/unfreeze command.
# Offline receipt verification

With a downloaded receipt and a separately trusted ./AGENT receipt public key (SPKI PEM), run:

```powershell
npm run sale:receipt:verify -- "C:\receipts\agent-purchase-receipt.json" "C:\receipts\trusted-receipt-public.pem"
```

The command performs no network/database/wallet calls and accepts no private key. Exit zero means the signature and issuance contents match the supplied public key; it does not establish current access, transferable ownership or treasury solvency. A key obtained only from the same untrusted receipt is not an independent trust source. No production receipt public key has been published/configured by this implementation. Key distribution, rotation, revocation and recovery procedures must be agreed before launch. Treat failure as unresolved evidence, not permission to edit the receipt or replace a stored signature.
