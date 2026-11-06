# Zcash integration decision and verification environment

Checked 2026-09-20. This is an implementation candidate, not an enabled payment provider or production approval.

Current implementation evidence and remaining launch gates are maintained in `SALE_IMPLEMENTATION_STATUS.md`. The environment notes below record earlier discovery stages; beta.1 limitations and initially missing Docker/wallet infrastructure are historical, not the current local test state. The current harness pins beta.3 and has passed actual deposits, pass purchases, withdrawals, funded-deposit forks and paid-withdrawal forks. Production infrastructure and approved access/custody policies are still missing.

## Candidate: Zebra + Zallet, isolated regtest first

Zallet's upstream README still describes a beta with potentially breaking changes and incomplete review. Pin a specific release and verify its capabilities before implementing against it. Do not treat the moving documentation as a guarantee of the installed version. [Upstream status](https://github.com/zcash/zallet)

The Zcash Foundation's Z3 project documents a Docker-based regtest environment containing Zebra, Zaino, Zallet, and an RPC router with separate network volumes. Use a disposable wallet containing only regtest funds. Its published development credentials are not production credentials. [Z3 regtest instructions](https://github.com/ZcashFoundation/z3/blob/main/docs/regtest.md)

## Adapter requirements established by API review

- Discover the installed methods and pin response fixtures. `z_listtransactions` is documented as experimental.
- Derive and persist an explicit account/diversifier mapping. Never infer a customer's receipt merely because it appeared in an address-filtered `z_listunspent` response: shielded filtering can include other diversifiers in the same wallet account.
- Read actual output identity, recipient, atomic amount and canonical inclusion before calling `SaleService.observe`. Exclude internal change. Replay historical transactions, not just currently unspent notes.
- Investigate `pczt_create`, `pczt_prove`, `pczt_sign`, and `pczt_extract` for staged payouts. Persist the completed transaction securely before broadcasting. Test the installed release's input-locking and restart behavior; method presence alone does not prove safe recovery.

These requirements follow the [Zallet RPC reference](https://zcash.github.io/zallet/rpc/index.html). The implementation now separates receipt normalization, node/wallet verification, scanning, signing and payout workers under `src/mcp/sale`; the pinned-release integration tests establish the supported subset, not the moving documentation alone.

`src/mcp/sale/zallet-receipts.ts` now normalizes confirmed transaction responses using the [reviewed transaction source](https://github.com/zcash/zallet/blob/f9dcd4d31439feb813c95ac2516814421f5b04df/zallet-core/src/components/json_rpc/methods/view_transaction.rs). It accepts separately supplied canonical-block evidence but does not obtain or cryptographically verify that evidence. It recognizes transparent, Sapling, Orchard, and Ironwood outputs from that source; unknown pools require a separately reviewed implementation. Do not wire it to credit balances until real pinned-version fixtures, recipient encoding, sync freshness, historical replay, and reorg handling are verified.

Do not use `getwalletinfo` balance fields for solvency: Zallet documents them as unpopulated. Use and validate dedicated balance methods. [Altered RPC semantics](https://zcash.github.io/zallet/zcashd/json_rpc.html)

## Historical environment and compatibility findings

The first checks found Docker stopped and no Zallet, Zebra, or Cargo executable on PATH. A subsequent check found Docker running. Disposable PostgreSQL concurrency tests now pass through `npm run sale:test:postgres`; that temporary database is removed afterward and is not an application database. No Zcash wallet, real funds, or paid infrastructure has been created. The user still has no configured application PostgreSQL or wallet provider.

Next: extend the available local Docker test environment to a complete wallet and validate deposit attribution, replay, reorgs, fee limits, unknown broadcast recovery, and backup restoration before wiring the locked funding and payout routes. A production hosting choice remains separate. Production stays disabled regardless of regtest results until custody/access terms and launch approval are explicit.

Local node validation has now passed through `npm run sale:test:zcash-node`. The test-only config explicitly removes both mainnet and testnet seeds; the reviewed upstream regtest template did not. Zebra 6.2.3 reports `chain: "test"` for regtest, so the runner checks the distinct regtest genesis hash before any mining request. RPC runs inside the isolated container rather than exposing a host port. A complete Zallet wallet/signing environment is still not connected.

The disposable wallet smoke test now passes too (`npm run sale:test:zcash-wallet`), using Zallet beta.1 at digest `sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d`. It verifies wallet initialization, RPC authentication/discovery, matching chain tips, and deterministic Orchard-only address derivation. Its known test RPC credentials are committed only in the isolated regtest configuration and must never be used elsewhere. Test keys are deleted with the labeled temporary volumes.

Important observed compatibility gap: this pinned image's discovery schema has no `pczt_*` staged-signing methods. The reviewed newer source/docs are not proof of capabilities in beta.1. Before withdrawal integration, either validate a newer reviewed build that actually exposes the required staged flow, or design and test another provider's durable signed-transaction recovery semantics. No public deposit address or real-money route is enabled by the smoke test.

The beta.1 non-broadcast fallback was also tested with regtest funds. Signing succeeded, but `getrawtransaction` failed to retrieve the unbroadcast transaction. Its release source explicitly queries the chain backend, not wallet transaction storage. Do not work around this by silently broadcasting first or constructing a second payment.

The upstream [beta.3 release](https://github.com/zcash/zallet/releases/tag/v0.1.0-beta.3) includes PCZT support. The harness now uses verified image index `sha256:54d1a774317371b1e88c8a54712cdfa4aa7d8f20ae2a0205f9a190e502aef0f6` for `zodlinc/zallet:v0.1.0-beta.3`. Its wallet smoke test passes and runtime discovery exposes the four staged-signing methods. The new remote plaintext opt-in is confined to the verified internal Docker test network; there are no published wallet/node ports. Upstream regtest defaults allow disposable unconfirmed-backup seeds, without altering production backup policy.

The PCZT signing integration test passed creation, recipient/fee inspection, proving, strict signing, extraction, persistence to a separate disposable PostgreSQL instance, database restart/reload, wallet restart, explicit broadcast and canonical block inclusion. Re-extraction produced different raw bytes in an earlier test: always retain the first committed raw artifact instead of recreating it for retries. The artifact database is loopback-only and removed after testing. A disabled-by-default signer worker and intent validation boundary are now implemented; production database privileges and the complete extraction-to-commit crash/recovery matrix remain unverified. No production migration or live-money enablement occurred.

The latest actual-wallet test also verifies the per-wallet signing lock and pending-note exclusion: a competing proposal callback cannot enter during signing, and Zallet rejects reuse of the sole confirmed deposit note after extraction but before broadcast. The recipient wallet is then stopped and restarted with its existing test volume; after verified tip synchronization it still rejects reuse of that note. Worker replay invokes no signing callback, and the original saved withdrawal broadcasts, settles and reconciles. This does not establish reservation behavior after expiry or reorg; those are separate remaining tests.
