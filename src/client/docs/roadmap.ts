import type { DocArticle } from './types'

export const roadmapArticles: DocArticle[] = [
  {
    id: 'roadmap',
    group: 'Build & operate',
    title: 'Upcoming tools & roadmap.',
    description: 'The next layer of agent execution: connected wallets, shielded payments, native NEAR, precise permissions, and receipts that survive interruptions.',
    blocks: [
      { type: 'text', text: 'The roadmap expands the execution architecture around the existing wallet, transfer, swap, bridge, lending, staking, and data tools. Its purpose is to make a complete instruction reliable from the first review through the final receipt. That means extending wallet access, publishing precise capabilities, and giving each operation a durable identity across chains and service restarts.' },
      { type: 'note', title: 'Architecture coverage, with an explicit API boundary', text: 'The capabilities below describe the integration roadmap, including native NEAR work already underway. The code illustrates application contracts; it does not introduce additional callable MCP methods. Use the tool reference and your connected server’s tools/list response for executable requests. Rollout follows verification milestones rather than announced dates.' },
      { type: 'heading', id: 'roadmap-tracks', text: 'What the expanded toolkit covers.' },
      { type: 'table', columns: ['Track', 'Capability', 'What it gives the agent'], rows: [
        ['Capability catalog', 'Action, network, asset, signer, and execution status in one description.', 'A precise answer to whether this wallet can perform this action here.'],
        ['Connected signing', 'Transaction-bound approval and a chain-specific user signer.', 'A reviewable execution plan without putting signing credentials into the conversation.'],
        ['Zcash wallet', 'Receiver validation, shielded payment preparation, and wallet-confirmed receipt.', 'Native ZEC instructions with an explicit shielded destination requirement.'],
        ['Zcash gateway', 'Validated conversion orders with minimum output, expiry, and recovery.', 'A coordinated journey between ZEC and supported EVM assets.'],
        ['Native NEAR', 'Native account context, authorized actions, and receipt tracking.', 'Execution through a NEAR wallet alongside the EVM and Zcash domains.'],
        ['Operation history', 'Durable step records, reconciliation, and destination evidence.', 'A useful answer to “What happened?” even after a client disconnects.'],
      ] },
      { type: 'heading', id: 'roadmap-capabilities', text: 'A catalog that describes what execution means.' },
      { type: 'text', text: 'A tool name alone cannot describe an integration. One action may read positions on several networks while its write path supports only one. Another may return provider instructions instead of submitting a transaction. The expanded catalog brings these distinctions into a shared record used by the interface, planner, and dispatch boundary.' },
      { type: 'text', text: 'Each record identifies the action, network, assets, verified contracts, custody mode, fee units, simulation coverage, and exit behavior. A read, write, and privileged administrative operation have different permission requirements. Capability status also separates implementation evidence from approval to use a particular deployment. The agent can explain a missing prerequisite instead of guessing another network or silently changing the requested action.' },
      { type: 'code', label: 'Proposed application contract · capability descriptor', language: 'typescript', code: `type CapabilityDescriptor = {
  tool: string;          // An actual name discovered from the server
  action: string;        // An action advertised by that tool
  network: string;
  assets: string[];
  operation: 'read' | 'write' | 'admin';
  signer: 'none' | 'managed' | 'user';
  status:
    | 'preview-only'
    | 'disabled'
    | 'implemented'
    | 'integration-tested'
    | 'production-approved';
  simulation: 'available' | 'partial' | 'unavailable';
  exitDescription: string;
  privacyDescription: string;
};

// This metadata complements inputSchema.
// It is an application model, not an extra tools/list field today.` },
      { type: 'heading', id: 'roadmap-signing', text: 'Approval that follows the exact transaction.' },
      { type: 'text', text: 'The signing track separates preparing an operation from authorizing it. An agent can assemble a plan and explain its consequences while a user-controlled signer verifies the payload. Existing managed EVM wallets remain a separate custody mode; the connection must identify which signer controls each wallet rather than treating all wallet connections as interchangeable.' },
      { type: 'text', text: 'A review binds the selected network, sender, recipient, asset, amount bounds, fees, expiry, and refund destination. A material change produces a new review. Approval of one transfer does not authorize a different recipient, a larger amount, or a later quote. Permissions are checked again at submission so that an expired approval cannot become valid merely because the conversation still contains it.' },
      { type: 'code', label: 'Proposed application contract · transaction-bound review', language: 'typescript', code: `type ApprovedPlan = {
  operationId: string;
  ownerRef: string;
  planDigest: string;
  network: string;
  sender: string;
  recipient: string;
  assetId: string;
  maximumInputAtomic: string;
  minimumOutputAtomic: string;
  maximumFeeAtomic: string;
  expiresAt: string;
  refundRecipient: string | null;
};

// The signer verifies the canonical plan and exact payload.
// A digest supplied by the model is not proof of approval.
// Keep integer amounts as strings across JSON boundaries.` },
      { type: 'heading', id: 'roadmap-zcash', text: 'Shielded wallet tools and the gateway.' },
      { type: 'text', text: 'Zcash wallet integration covers address and network validation, payment preparation, proving and signing, balance context, and confirmed receipt. Receiver selection is part of the instruction: if the user asks for shielded delivery, the selected receiver must satisfy that requirement. Spending keys and full viewing keys stay outside ordinary hosted API payloads and agent prompts.' },
      { type: 'text', text: 'The repository contains concrete Zallet and Zebra work: isolated regtest deposits, receiver attribution, staged PCZT signing, persistence of signed artifacts, payout reconciliation, and funded-fork tests. These components provide useful implementation evidence. The current treasury and access-pass accounting flow is distinct from connecting a user-owned wallet or offering a general-purpose ZEC conversion route.' },
      { type: 'text', text: 'The gateway adds an independently validated conversion adapter. Its contract must establish supported source assets, deposit type, destination receiver, output bounds, fees, expiry, and refund behavior. Provider selection remains an implementation decision; existing EVM bridge adapters do not automatically establish Zcash support. The first complete journey includes the outward conversion and a verified shielded return, including the route’s failure paths.' },
      { type: 'text', text: 'A successful provider order and a shielded receipt are different milestones. The agent can report conversion progress while the destination wallet confirms the actual output. Public source transactions remain public, and shielding a return does not erase earlier EVM activity. This context belongs in the review and receipt, where it helps the user understand the operation.' },
      { type: 'heading', id: 'roadmap-near', text: 'Native NEAR as a complete wallet domain.' },
      { type: 'text', text: 'Native NEAR integration extends the three-wallet architecture with an account ID, explicit network, authorized access key, native amount units, and chain-specific transaction actions. It is separate from the EVM chain registry and from routes using NEAR infrastructure. A connection should resolve the intended native account before preparing a transfer or contract call.' },
      { type: 'text', text: 'The execution interface carries the receiver, method and arguments where applicable, attached deposit, gas budget, and access-key permissions into the review. Its result retains transaction and receipt outcomes so the agent can distinguish submission from completion. Integration examples should use the native wallet boundary instead of passing near to an EVM tool or assuming an EVM balance can pay native fees.' },
      { type: 'heading', id: 'roadmap-receipts', text: 'Receipts that preserve progress and recovery.' },
      { type: 'text', text: 'A durable operation contains ordered steps with their own identifiers and outcomes. Source confirmation, conversion settlement, destination receipt, and a subsequent DeFi deposit cannot be compressed into a single success flag. If the conversion completes and the deposit fails, the record explains where the funds are and which action remains.' },
      { type: 'text', text: 'Recovery resumes from saved evidence. A timeout after submission means the outcome is unresolved, not that nothing happened. For the Zcash signing path, retain the first committed raw transaction artifact and reconcile or rebroadcast those exact bytes when appropriate. An ambiguous signing claim without an artifact needs review; creating a replacement payment is not an automatic recovery step.' },
      { type: 'code', label: 'Proposed application model · recover an existing operation', language: 'typescript', code: `type RecoveryEvidence = {
  transactionId: string | null;
  savedArtifactRef: string | null;
  unresolvedSigningClaim: boolean;
  destinationConfirmed: boolean;
};

function recoveryAction(evidence: RecoveryEvidence) {
  if (evidence.destinationConfirmed) return 'record-destination-receipt';
  if (evidence.transactionId) return 'reconcile-existing-submission';
  if (evidence.savedArtifactRef) return 'inspect-saved-artifact';
  if (evidence.unresolvedSigningClaim) return 'request-operator-review';
  return 'resume-preparation';
}

// Illustrates the decision boundary, not a transaction executor.
// Production recovery reads durable, owner-bound records under locks.
// No branch creates a replacement signature after an ambiguous claim.` },
      { type: 'heading', id: 'roadmap-sequence', text: 'Expansion follows complete journeys.' },
      { type: 'text', text: 'The existing architecture orders the work by dependencies. First, publish and enforce current capabilities across entry points. Next, establish user signing and durable operation state. Then validate the Zcash wallet and conversion interface, complete one round trip, and extend that journey with a verified EVM deposit and withdrawal. Broader network and protocol coverage follows the same evidence rather than a larger list of logos.' },
      { type: 'flow', items: ['Capability enforcement', 'Approval & signing', 'Wallet integration', 'Round-trip settlement', 'DeFi entry & exit', 'Broader coverage'] },
      { type: 'code', label: 'Integration specification · example acceptance scenarios', language: 'yaml', code: `journey: shielded-wallet-to-evm-and-back
scenarios:
  - given: a quote expires before funding
    expect: a fresh quote and a new approval
  - given: the source payment is sent and the provider times out
    expect: reconciliation of the existing order, no second payment
  - given: conversion succeeds but the DeFi deposit fails
    expect: the destination balance and remaining step are reported
  - given: the destination changes to a transparent receiver
    expect: rejection of the shielded-delivery requirement mismatch
  - given: a worker restarts after signed bytes are committed
    expect: recovery uses the saved artifact without re-signing
  - given: a confirmed source block is reorganized
    expect: dependent steps pause until reconciliation completes

# Application acceptance criteria, not server configuration.` },
      { type: 'text', text: 'These scenarios make the roadmap actionable for client developers: preserve operation IDs, display separate step states, refresh expired reviews, and leave room for recovery instructions. A client that already handles these boundaries can adopt new wallet domains without redesigning the whole conversation. Final method names and schemas come from the deployment when those integrations join its tool catalog.' },
      { type: 'links', items: [
        { title: 'Tool reference', description: 'Build against the currently registered names, parameters, and action behavior.', href: '/docs#tool-reference' },
        { title: 'Three-wallet architecture', description: 'Understand the Zcash, EVM, and native NEAR boundaries.', href: '/docs#architecture' },
        { title: 'Settlement and recovery', description: 'Keep source, provider, and destination evidence distinct.', href: '/docs#operations' },
      ] },
    ],
  },
]
