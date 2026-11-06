import type { DocArticle } from './types'

export const architectureArticles: DocArticle[] = [
  {
    id: 'architecture',
    group: 'Architecture',
    title: 'Three wallets. One execution layer.',
    description: 'How Zcash, EVM networks, and native NEAR share one agent connection while keeping their own accounts, signers, and settlement rules.',
    blocks: [
      { type: 'text', text: './AGENT connects the agent conversation to three wallet domains: a shielded Zcash wallet, a multichain EVM wallet, and a native NEAR wallet. The connection gives the agent a common way to discover tools and return results. Each domain retains its own account identity, transaction format, signing process, and definition of settlement.' },
      { type: 'note', title: 'Architecture and integration examples', text: 'These guides describe the execution architecture. TypeScript models are application-side integration examples, not additional published MCP methods. The connected deployment’s tools/list response is authoritative for callable tool names, arguments, and available actions.' },
      { type: 'heading', id: 'architecture-wallet-domains', text: 'Three distinct wallet domains' },
      { type: 'table', columns: ['Wallet', 'Identity and units', 'Execution boundary'], rows: [
        ['Zcash', 'Wallet account and validated receiver; ZEC represented in zatoshis.', 'Shielded payment preparation, proof/signature handling, and wallet-confirmed receipt.'],
        ['EVM', '0x address plus explicit chain identity; native and token-specific decimals.', 'Transfers and contract calls on the selected network. A shared address does not combine balances across chains.'],
        ['Native NEAR', 'Account ID and authorized access key; NEAR represented in yoctoNEAR.', 'Native actions and contract receipts, with NEAR-specific signing and outcome tracking.'],
      ] },
      { type: 'text', text: 'The EVM registry includes Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, Abstract, BNB Chain, Linea, and zkSync Era. Network support and protocol support are separate questions: an RPC connection establishes access to a chain, while an adapter defines the actions and contracts used there. Keep network identity attached to every asset, balance, quote, and receipt.' },
      { type: 'code', label: 'Application model · keep wallet identities distinct', language: 'typescript', code: `type WalletIdentity =
  | { family: 'zcash'; network: 'mainnet' | 'testnet'; accountRef: string }
  | { family: 'evm'; chainId: number; address: string }
  | { family: 'near'; network: 'mainnet' | 'testnet'; accountId: string };

type WalletSet = {
  zcash: Extract<WalletIdentity, { family: 'zcash' }>;
  evm: Extract<WalletIdentity, { family: 'evm' }>;
  near: Extract<WalletIdentity, { family: 'near' }>;
};

type AssetAmount = {
  wallet: WalletIdentity;
  assetId: string;       // Contract, native asset, or domain-specific ID
  atomicAmount: string; // Integer string; never a floating-point balance
  decimals: number;
};` },
      { type: 'heading', id: 'architecture-execution-path', text: 'The path from instruction to result' },
      { type: 'flow', items: ['Instruction', 'Prepare', 'Policy checks', 'Review', 'Sign', 'Submit', 'Reconcile'] },
      { type: 'text', text: 'The agent interprets intent: the asset, amount, destination, and desired action. Deterministic adapter code resolves that intent into a concrete transaction or route. Policy evaluates the selected wallet, available balance, fees, recipient, and permissions. The review presents the actual transaction. Signing authorizes the approved payload; submission sends it to the network or provider; reconciliation establishes what happened.' },
      { type: 'text', text: 'MCP carries requests and results across this boundary. It does not itself hold funds, sign a transaction, or guarantee finality. A connected client can discover a tool without having authority to spend from a particular wallet. Likewise, a valid signature authorizes a transaction but does not prove that the network accepted or completed it.' },
      { type: 'code', label: 'Application model · preserve each execution boundary', language: 'typescript', code: `type ExecutionContext = {
  operationId: string;
  ownerRef: string;
  wallet: WalletIdentity;
  request: { action: string; assetId: string; atomicAmount: string };
  destination: { network: string; recipient: string };
  approval: { planDigest: string; expiresAt: string } | null;
  submission: { transactionId: string; submittedAt: string } | null;
  outcome: 'unresolved' | 'confirmed' | 'failed';
};

// A receipt belongs to a particular operation, owner, and network.
// A transaction hash alone does not establish destination settlement.` },
      { type: 'heading', id: 'architecture-components', text: 'Components and responsibilities' },
      { type: 'table', columns: ['Component', 'Responsibility'], rows: [
        ['Agent client', 'Collect the instruction, show the review, and explain the returned result.'],
        ['MCP boundary', 'Discover tools, validate arguments, resolve account context, and return structured tool results.'],
        ['Wallet and protocol adapters', 'Resolve assets and networks, prepare exact transaction details, and interpret chain-specific outcomes.'],
        ['Policy and approval', 'Bind authorization to the transaction being reviewed and reject material changes.'],
        ['Signer', 'Authorize with the appropriate wallet credentials inside the signer’s trust boundary.'],
        ['Operation store and reconciler', 'Retain identifiers, follow confirmations, and recover existing work after interruption.'],
      ] },
      { type: 'text', text: 'The EVM tool set includes wallet transfers, Jumper/LI.FI and Relay routes, lending and staking adapters, market information, memory, and safety utilities. Its action catalog identifies which operations are execution paths, reads, or guidance. The same architectural boundaries apply across the three wallet domains without pretending their underlying protocols behave identically.' },
      { type: 'heading', id: 'architecture-cross-chain', text: 'A cross-chain operation contains multiple steps' },
      { type: 'text', text: 'Moving value between domains combines independently observable events. Source submission, source confirmation, provider settlement, and destination receipt are separate records. A completed source transaction does not establish that the destination wallet received funds. A DeFi action after conversion adds another step, and a failed deposit does not undo an already completed conversion.' },
      { type: 'text', text: 'This separation also defines the privacy boundary. Shielded Zcash activity and public EVM or NEAR activity have different visibility. The operation can end at a shielded receiver while its source transaction remains public. Keep those facts explicit in the review and in the final receipt.' },
      { type: 'links', items: [
        { title: 'Zcash wallet and gateway', description: 'Receivers, shielded signing, and cross-chain boundaries.', href: '/docs#zcash' },
        { title: 'Native NEAR wallet', description: 'Accounts, access keys, amounts, and outcomes.', href: '/docs#near' },
        { title: 'Approval and control', description: 'What the user authorizes and what the signer verifies.', href: '/docs#control' },
      ] },
    ],
  },
  {
    id: 'zcash',
    group: 'Architecture',
    title: 'Zcash wallet and shielded execution',
    description: 'Receiver selection, exact amounts, signing, conversion, and the evidence behind a shielded receipt.',
    blocks: [
      { type: 'text', text: 'The Zcash wallet domain covers receiving ZEC, inspecting wallet balances, preparing payments, and following their confirmation. A shielded destination is an execution requirement that survives every stage of the operation. Address handling, input selection, transaction construction, and receipt attribution all participate in satisfying that requirement.' },
      { type: 'heading', id: 'zcash-receivers', text: 'Validate the receiver, not just the address string' },
      { type: 'text', text: 'A Unified Address can carry receiver information for multiple pools. The adapter decodes it using the selected network and records the receiver used by the transaction. A label saying “Zcash address” is insufficient when the user asks for shielded delivery. The review retains the original address and identifies the chosen pool; it rejects an incompatible destination instead of silently changing the privacy requirement.' },
      { type: 'text', text: 'Receiving addresses belong to a wallet account and derivation context. Receipt attribution matches the exact output, recipient, amount, and canonical inclusion. It does not infer ownership from an approximate balance change or from an address-filtered result that also contains other receivers belonging to the account. Internal change remains distinct from a payment received from another party.' },
      { type: 'code', label: 'Application model · review a decoded receiver', language: 'typescript', code: `type ReceiverReview = {
  network: 'mainnet' | 'testnet';
  originalAddress: string;
  selectedPool: 'orchard' | 'sapling' | 'transparent';
  decodedByWallet: boolean;
};

function requireShieldedDestination(
  review: ReceiverReview,
  expectedNetwork: ReceiverReview['network'],
) {
  if (!review.decodedByWallet) throw new Error('Decode the receiver first');
  if (review.network !== expectedNetwork) throw new Error('Network mismatch');
  if (review.selectedPool === 'transparent') {
    throw new Error('This destination does not satisfy shielded delivery');
  }
  return review;
}

// The wallet adapter supplies verified decoding results.
// Caller-supplied booleans are not address validation.` },
      { type: 'heading', id: 'zcash-amounts', text: 'Keep ZEC amounts exact' },
      { type: 'text', text: 'One ZEC is 100,000,000 zatoshis. Store and compare integer amounts, and serialize them as decimal strings when crossing JSON boundaries. The displayed ZEC value is a formatting decision. Fee reserves, minimum output, and refund values use the same exact accounting rules. Reject excess decimal precision rather than rounding a requested payment without review.' },
      { type: 'code', label: 'Application utility · decimal ZEC to zatoshis', language: 'typescript', code: `function zecToZatoshis(input: string): string {
  if (!/^(0|[1-9][0-9]*)(\\.[0-9]{1,8})?$/.test(input)) {
    throw new Error('Use a positive decimal with at most 8 decimal places');
  }
  const [whole, fraction = ''] = input.split('.');
  const atomic = BigInt(whole) * 100_000_000n
    + BigInt(fraction.padEnd(8, '0'));
  if (atomic === 0n) throw new Error('Payment amount must be greater than zero');
  return atomic.toString();
}

zecToZatoshis('0.125'); // '12500000'
zecToZatoshis('1');     // '100000000'` },
      { type: 'heading', id: 'zcash-signing', text: 'Preparation, proving, and signing are separate' },
      { type: 'text', text: 'A Partially Created Zcash Transaction, or PCZT, separates proposal construction, inspection, proving, signing, and final extraction. That separation makes the approval boundary explicit. The signing path checks the destination, amount, fee, privacy requirement, and transaction commitments before accepting a signature. Proving and signing can have different execution costs and trust boundaries.' },
      { type: 'code', label: 'Zallet adapter lifecycle · method names, not MCP calls', language: 'text', code: `pczt_create
  → pczt_inspect   (review recipient, amount, fee, and privacy metadata)
  → pczt_prove
  → pczt_inspect   (check the proposal has not changed)
  → pczt_sign
  → pczt_extract
  → persist the resulting transaction artifact
  → broadcast those exact saved bytes
  → verify canonical inclusion and wallet receipt` },
      { type: 'text', text: 'Inspection metadata is a review input, not independent proof that arbitrary transaction content is safe. The repository’s Zallet signer accepts its own trusted-wallet proposal, checks consistency through proving, and retains the first committed raw transaction for replay. Rebuilding a payment after a timeout risks selecting different inputs or producing another transaction.' },
      { type: 'links', items: [{ title: 'Zallet RPC reference', description: 'Official PCZT method semantics, inspection limits, and privacy policies.', href: 'https://zcash.github.io/zallet/rpc/index.html' }] },
      { type: 'heading', id: 'zcash-gateway', text: 'The gateway preserves route and privacy context' },
      { type: 'text', text: 'A conversion review identifies both assets, both networks, the receiving wallet, expected output, minimum output, fees, expiry, and refund destination. The source deposit and the destination payment have different identifiers. The operation tracks both. Provider success and wallet-confirmed shielded receipt are separate milestones, and an expired quote requires a fresh review before funding.' },
      { type: 'table', columns: ['Stage', 'What the user can verify'], rows: [
        ['Before funding', 'Input asset and amount, selected source network, quote expiry, minimum output, fees, and recovery destination.'],
        ['After source submission', 'The source transaction identifier and its confirmation state.'],
        ['During conversion', 'The provider order identifier, observed status, and any recovery requirement.'],
        ['At the destination', 'The receiving wallet, actual shielded output, amount, and confirmation evidence.'],
      ] },
      { type: 'heading', id: 'zcash-privacy-boundary', text: 'Privacy follows the funds across boundaries' },
      { type: 'text', text: 'Shielding protects the shielded portion of a journey; it does not erase an earlier public transfer or contract interaction. A conversion provider can observe information about the route. Account identifiers, amounts, timing, and application logs can also link steps. The agent receives the information needed to explain the action, while spending keys, recovery phrases, full viewing keys, and sensitive memos stay outside ordinary conversation context.' },
      { type: 'text', text: 'The repository also contains Zcash deposit, treasury-signing, and receipt-verification infrastructure for access-pass accounting. That custody boundary is separate from a user-controlled wallet connection. Treasury payout tests establish evidence for those payout components; they do not establish ownership of a user’s wallet or turn sale-credit accounting into a general conversion provider.' },
      { type: 'links', items: [
        { title: 'Approval and control', description: 'Bind signing to a concrete review.', href: '/docs#control' },
        { title: 'Settlement and recovery', description: 'Track destination evidence and recover uncertain submissions.', href: '/docs#operations' },
      ] },
    ],
  },
  {
    id: 'near',
    group: 'Architecture',
    title: 'Native NEAR is the third wallet',
    description: 'A native account connection with its own keys, units, transaction actions, and receipt lifecycle.',
    blocks: [
      { type: 'text', text: 'The three-wallet architecture gives NEAR its own wallet domain alongside Zcash and EVM. Native NEAR account access remains distinct from an EVM address and from a cross-chain route that happens to use NEAR infrastructure. The account selected for a request determines the signer, network, balance model, and transaction format used to execute it.' },
      { type: 'heading', id: 'near-account-identity', text: 'Account identity comes before execution' },
      { type: 'text', text: 'NEAR accounts have account IDs and authorized access keys. Named accounts such as studio.near coexist with other account forms. The integration records the explicit network and validates the recipient there; a familiar-looking name is not proof that the intended account exists. Keep the account ID intact rather than coercing it into a 0x address or passing near as an EVM chain alias.' },
      { type: 'text', text: 'The connection can present all three wallets together while preserving separate balances. A NEAR balance does not fund EVM gas, and a token represented on another network is not automatically native NEAR. Network, account, asset identifier, and units travel together in the application model.' },
      { type: 'code', label: 'Application model · native account context', language: 'typescript', code: `type NearWalletContext = {
  family: 'near';
  network: 'mainnet' | 'testnet';
  accountId: string;
  publicKey: string;
};

type NearTransferIntent = {
  wallet: NearWalletContext;
  receiverId: string;
  amountYocto: string;
};

// Public identity only. The connected signer retains its private key.
// Validate account existence and permissions on wallet.network.` },
      { type: 'links', items: [{ title: 'NEAR account model', description: 'Official account identities and access-key model.', href: 'https://docs.near.org/protocol/accounts-contracts/account-model' }] },
      { type: 'heading', id: 'near-exact-units', text: 'Amounts and gas use different units' },
      { type: 'text', text: 'One NEAR equals 10²⁴ yoctoNEAR. Application code uses integer strings or BigInt for transfers, attached deposits, and balance checks. Gas is a separate quantity: one Tgas equals 10¹² gas units. A gas budget is not the transfer amount, and neither value should be inferred from the other. Keep room for the transaction’s execution costs rather than assuming the displayed balance is entirely transferable.' },
      { type: 'code', label: 'Application utility · exact NEAR amount conversion', language: 'typescript', code: `function nearToYocto(input: string): string {
  if (!/^(0|[1-9][0-9]*)(\\.[0-9]{1,24})?$/.test(input)) {
    throw new Error('Invalid NEAR amount or too many decimal places');
  }
  const [whole, fraction = ''] = input.split('.');
  return (BigInt(whole) * 10n ** 24n
    + BigInt(fraction.padEnd(24, '0'))).toString();
}

const amountYocto = nearToYocto('2.5');
// '2500000000000000000000000'

const gasUnits = (30n * 10n ** 12n).toString();
// An illustrative 30 Tgas budget; estimate the actual method separately.` },
      { type: 'links', items: [{ title: 'Handling NEAR types', description: 'Official balance, deposit, timestamp, and gas representations.', href: 'https://docs.near.org/web3-apps/tutorials/data-types' }] },
      { type: 'heading', id: 'near-signing-permissions', text: 'The selected key determines permission' },
      { type: 'text', text: 'Full-access keys control an account. Function-call keys restrict execution to a contract and permitted methods; they do not authorize an ordinary native transfer or an attached NEAR deposit. A function-call allowance concerns gas rather than a general asset-spending budget. The signer checks the actual key permission before presenting or signing an action.' },
      { type: 'text', text: 'A native transaction identifies the signer, receiver, public key, actions, nonce, and a recent block reference. The application obtains the relevant nonce from the selected access key and binds the review to the serialized actions. A wallet reconnect or account switch invalidates any review that names the previous signer.' },
      { type: 'links', items: [
        { title: 'NEAR access keys', description: 'Full-access and restricted function-call permissions.', href: 'https://docs.near.org/protocol/accounts-contracts/access-keys' },
        { title: 'Transaction anatomy', description: 'Signer, receiver, actions, key, nonce, and block reference.', href: 'https://docs.near.org/protocol/transactions/transaction-anatomy' },
      ] },
      { type: 'heading', id: 'near-receipt-outcomes', text: 'A submitted transaction is not the final outcome' },
      { type: 'text', text: 'Native NEAR execution can produce receipts after transaction submission. The operation records the transaction hash and sender, then follows the relevant execution outcomes. Inclusion, execution, and finality describe different milestones. A final transaction can still contain a failed action; the receipt view evaluates the outcome as well as the finality level.' },
      { type: 'code', label: 'NEAR node RPC · read the status of an existing transaction', language: 'json', code: `{
  "jsonrpc": "2.0",
  "id": "receipt-check",
  "method": "tx",
  "params": {
    "tx_hash": "<transaction hash returned after submission>",
    "sender_account_id": "<the account that signed>",
    "wait_until": "FINAL"
  }
}` },
      { type: 'text', text: 'This is a NEAR node request, not an ./AGENT MCP call. A timeout means the requested milestone was not observed within the request deadline. Preserve the existing transaction identity and query it again before deciding whether another signature is necessary. The resulting account update belongs to the NEAR wallet, even when the agent displays it alongside Zcash and EVM activity.' },
      { type: 'links', items: [
        { title: 'NEAR transaction RPC', description: 'Status requests, receipt outcomes, and wait_until milestones.', href: 'https://docs.near.org/api/rpc/transactions' },
        { title: 'Operation recovery', description: 'Handle timeouts and uncertain submissions without repeating a payment.', href: '/docs#operations' },
      ] },
    ],
  },
  {
    id: 'control',
    group: 'Architecture',
    title: 'Approval, signing, and user control',
    description: 'Separate the request to perform an action from the authority to sign its exact transaction.',
    blocks: [
      { type: 'text', text: 'An instruction expresses intent. Approval accepts a concrete plan. A signature authorizes a chain-specific payload. These are distinct events. Keeping them distinct lets the user understand what moves, where it goes, what it costs, and which wallet authorizes it before the action is submitted.' },
      { type: 'heading', id: 'control-connection-boundary', text: 'A connection does not transfer signing authority' },
      { type: 'text', text: 'MCP account access identifies the user and exposes the tools available to that connection. Wallet authorization identifies the signer allowed to act for a particular account. The application keeps those checks separate. A client’s decision to trust a tool server does not authorize every transaction that the server can prepare.' },
      { type: 'text', text: 'The user-controlled architecture keeps private keys and recovery material within the chosen signer. Existing host-managed EVM wallets have a different custody boundary because the server signs for them. The application identifies the wallet’s signing mode explicitly; it does not describe host-managed storage as proof of non-custodial control.' },
      { type: 'heading', id: 'control-approval-fields', text: 'Bind approval to the complete plan' },
      { type: 'table', columns: ['Review field', 'Why it is bound to approval'], rows: [
        ['Network and signer', 'Prevent the right action from being signed by the wrong wallet or on the wrong network.'],
        ['Asset, amount, and recipient', 'Identify what the user spends and the destination that receives it.'],
        ['Minimum received and fee cap', 'Define the accepted execution bounds.'],
        ['Transaction or intent digest', 'Bind the review to the actual contract call or chain-specific payload.'],
        ['Expiry and refund destination', 'Limit stale authorization and preserve the recovery route.'],
        ['Privacy requirement', 'Keep an approved shielded destination from being replaced by a transparent one.'],
      ] },
      { type: 'code', label: 'Application model · the reviewable authorization envelope', language: 'typescript', code: `type ApprovalPlan = Readonly<{
  version: 1;
  operationId: string;
  network: string;
  signerRef: string;
  assetId: string;
  amountAtomic: string;
  recipient: string;
  minimumReceivedAtomic: string | null;
  maximumFeeAtomic: string;
  feeAssetId: string;
  payloadDigest: string;
  expiresAt: string;
  refundRecipient: string | null;
  privacy: 'shielded-destination' | 'public';
}>;

// Build from validated adapter data and display before asking the signer.
// Any material change creates a new review and a new approval binding.` },
      { type: 'text', text: 'The payload digest covers the serialized transaction or intent reviewed by the adapter. Human-readable fields make the decision understandable, while the digest prevents an unchanged screen from masking changed execution data. The application uses a documented canonical representation rather than relying on arbitrary object-key ordering.' },
      { type: 'code', label: 'Application utility · deterministic review digest', language: 'typescript', code: `async function digestApproval(plan: ApprovalPlan): Promise<string> {
  const canonical = JSON.stringify([
    'agnt-application-approval-v1',
    plan.version, plan.operationId, plan.network, plan.signerRef,
    plan.assetId, plan.amountAtomic, plan.recipient,
    plan.minimumReceivedAtomic, plan.maximumFeeAtomic, plan.feeAssetId,
    plan.payloadDigest, plan.expiresAt, plan.refundRecipient, plan.privacy,
  ]);
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

// A matching digest establishes payload equality, not user authorization.
// The signer still verifies identity, permissions, expiry, and consent.` },
      { type: 'heading', id: 'control-policy-boundary', text: 'Policy runs where execution happens' },
      { type: 'text', text: 'Policy evaluates the actual action rather than the agent’s summary. It checks account ownership, enabled capability, chain and asset identity, recipient, available balance, gas reserve, route constraints, and spending limits. Network and provider responses remain untrusted inputs until the adapter validates their structure and meaning.' },
      { type: 'text', text: 'A preview helps the user decide, but conditions can change before submission. Quotes expire, balances move, allowances change, and gas estimates become stale. The execution path rechecks the facts that affect the approved bounds. When a new plan exceeds those bounds, it returns to review instead of treating the earlier approval as open-ended permission.' },
      { type: 'heading', id: 'control-simulation-boundary', text: 'Simulation supports review; it does not replace it' },
      { type: 'text', text: 'An EVM simulation can expose a revert or show how a call behaves against a particular state. It is not a guarantee of future inclusion, price, or settlement. Zcash proving and NEAR receipt execution have different semantics. Each adapter reports the evidence it obtains and preserves the distinction between a prepared transaction, a signed transaction, and a confirmed result.' },
      { type: 'text', text: 'The resulting user experience is direct: explain the intended action, show the concrete details, request authorization from the appropriate signer, and return the observed result. A rejection ends that signing attempt. A lost response leaves an operation to reconcile; it does not imply permission to repeat it.' },
      { type: 'links', items: [
        { title: 'Three-wallet architecture', description: 'Account and signer boundaries across all three domains.', href: '/docs#architecture' },
        { title: 'Durable operations', description: 'Preserve approved work through submission and recovery.', href: '/docs#operations' },
      ] },
    ],
  },
  {
    id: 'operations',
    group: 'Architecture',
    title: 'Settlement, receipts, and recovery',
    description: 'Keep an exact record of each operation and resolve interrupted work without duplicating an action.',
    blocks: [
      { type: 'text', text: 'Execution continues after the agent submits a request. RPC calls can time out, browsers can close, providers can become unavailable, and blocks can be reorganized. A durable operation record separates what the user asked for, what they approved, what was submitted, and what the system has actually observed.' },
      { type: 'heading', id: 'operations-state-model', text: 'State describes evidence, not optimism' },
      { type: 'text', text: 'The operation advances when there is evidence for the next state. Preparation records a concrete plan; signing records the authorized artifact; submission records a transaction or provider reference. Confirmation requires chain-specific evidence. A final receipt includes the actual outcome, so a confirmed failed transaction is not displayed as a successful payment.' },
      { type: 'code', label: 'Application model · a durable operation record', language: 'typescript', code: `type OperationState =
  | 'DRAFT' | 'QUOTED' | 'AWAITING_APPROVAL' | 'AWAITING_SIGNATURE'
  | 'SIGNED' | 'SUBMITTED' | 'CONFIRMING' | 'SETTLED'
  | 'EXPIRED' | 'REJECTED' | 'FAILED' | 'UNKNOWN_SUBMISSION'
  | 'PARTIALLY_COMPLETED' | 'REFUND_PENDING' | 'REFUNDED'
  | 'NEEDS_USER_ACTION';

type OperationRecord = {
  id: string;
  ownerRef: string;
  requestKey: string;
  requestDigest: string;
  revision: number;
  state: OperationState;
  approvalDigest: string | null;
  signedArtifactRef: string | null;
  sourceTransactionId: string | null;
  providerOrderId: string | null;
  destinationTransactionId: string | null;
  observedAt: string | null;
};` },
      { type: 'heading', id: 'operations-idempotency', text: 'Retain the same identity across retries' },
      { type: 'text', text: 'An idempotency key identifies one logical request. Repeating the same key and payload retrieves or resumes the same operation. Reusing it with a changed payload is a conflict, not a second interpretation of the original request. Bind request lookup to the owner so a guessed identifier cannot reveal another account’s history.' },
      { type: 'text', text: 'The durable store serializes competing updates and records a revision or equivalent concurrency boundary. Two workers must not independently sign or submit the same logical step. Where a signer produces a transaction artifact, persist the accepted artifact before broadcast and retain enough evidence to distinguish a lost response from a request that never reached the signer.' },
      { type: 'heading', id: 'operations-uncertain-submission', text: 'A timeout is an observation gap' },
      { type: 'text', text: 'If the network accepted a transaction but the response was lost, repeating the payment can spend twice. Recovery begins by looking up the existing transaction, signed artifact, or provider order. If the outcome remains unknown, preserve that uncertainty and the funds reservation. Do not convert UNKNOWN into FAILED merely because a request deadline expired.' },
      { type: 'code', label: 'Application policy · decide what to recover', language: 'typescript', code: `function recoveryAction(record: OperationRecord): string {
  switch (record.state) {
    case 'SETTLED':
    case 'REFUNDED':
      return 'Return the saved receipt';
    case 'SUBMITTED':
    case 'CONFIRMING':
      return 'Reconcile the existing transaction or provider order';
    case 'SIGNED':
      return 'Check chain state before rebroadcasting exact saved bytes';
    case 'UNKNOWN_SUBMISSION':
      return 'Resolve the existing attempt; do not create another payment';
    case 'EXPIRED':
      return 'Prepare a fresh quote and request fresh approval';
    case 'PARTIALLY_COMPLETED':
    case 'REFUND_PENDING':
      return 'Recover only the unfinished step';
    default:
      return 'Inspect the persisted plan and required user action';
  }
}` },
      { type: 'heading', id: 'operations-receipt-evidence', text: 'Record source and destination evidence separately' },
      { type: 'table', columns: ['Evidence', 'What it establishes'], rows: [
        ['Submitted transaction identifier', 'A reference for tracking the attempted action; not proof of success.'],
        ['Canonical source inclusion', 'The source transaction belongs to the currently accepted chain.'],
        ['Provider order status', 'The route provider’s view of conversion or transfer progress.'],
        ['Destination output or execution receipt', 'The receiving chain or wallet observed the relevant result.'],
        ['Finalized operation receipt', 'The required outcomes and confirmation conditions are satisfied for this operation.'],
      ] },
      { type: 'text', text: 'Confirmation policies are specific to the network and operation. Store the threshold used with the observation rather than retroactively guessing it from a new configuration. For a Zcash receipt, retain output identity and wallet attribution alongside canonical block evidence. For NEAR, retain the relevant receipt outcome. For an EVM action, inspect the transaction receipt and intended effect rather than relying only on the presence of a hash.' },
      { type: 'heading', id: 'operations-partial-results', text: 'Partial completion has its own recovery path' },
      { type: 'text', text: 'A successful swap followed by a failed deposit leaves a different situation from a swap that never executed. The operation records the completed step and the resulting asset location. Recovery can offer a retry of the remaining action, a hold in the wallet, or a separately approved return route. It does not silently roll the entire journey forward with new amounts or destinations.' },
      { type: 'list', items: [
        'Expired quote: obtain fresh terms and renew approval before funding.',
        'Provider timeout after deposit: reconcile the existing order before considering another transfer.',
        'Insufficient destination gas: resolve the gas requirement through an explicitly reviewed action.',
        'Reorganized confirmation: pause dependent steps and re-evaluate the affected evidence.',
        'Pending withdrawal or refund: track its own state until the receiving wallet confirms the result.',
        'Missing signed artifact after a signing claim: preserve the claim for investigation rather than signing again automatically.',
      ] },
      { type: 'heading', id: 'operations-data-boundary', text: 'Preserve evidence without exposing wallet secrets' },
      { type: 'text', text: 'The user-facing record contains the operation identifier, relevant networks, asset amounts, transaction references, outcome, and last observation. Signer secrets, private artifacts, and internal authorization references stay behind their own access boundary. Error messages explain the state without echoing recovery phrases, wallet credentials, raw signed payloads, or sensitive memos.' },
      { type: 'text', text: 'The same separation supports monitoring. A delayed confirmation is different from a failed provider request or a rejected signature. Report the state that needs attention and the evidence already available. Stopping new submissions can leave reconciliation running, so previously submitted transactions and refunds still reach an observed outcome.' },
      { type: 'links', items: [
        { title: 'Approval and control', description: 'Preserve the plan the user actually authorized.', href: '/docs#control' },
        { title: 'Zcash receipt boundaries', description: 'Shielded output attribution and source-chain visibility.', href: '/docs#zcash' },
        { title: 'Native NEAR settlement', description: 'Transaction inclusion, execution outcomes, and finality.', href: '/docs#near' },
      ] },
    ],
  },
]
