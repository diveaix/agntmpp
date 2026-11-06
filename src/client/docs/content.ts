import type { DocArticle } from './types'
import { gettingStartedArticles } from './getting-started'
import { guideArticles } from './guides'
import { architectureArticles } from './architecture'
import { roadmapArticles } from './roadmap'

const referenceArticles: DocArticle[] = [
  {
    id: 'tool-reference', group: 'Reference', title: 'Tool reference.',
    description: 'The complete built-in catalog: names, actions, input parameters, examples, and adapter behavior.',
    blocks: [
      { type: 'note', title: 'Read the schema and the action notes together', text: 'Required marks describe the tool’s top-level input schema. Individual actions can require additional fields. Examples below use reads or preparation rather than transaction submission. The connected server’s tools/list response is authoritative for your environment.' },
      { type: 'catalog' },
    ],
  },
  {
    id: 'glossary', group: 'Reference', title: 'Concepts & glossary.',
    description: 'A shared vocabulary for agent instructions, wallet boundaries, execution, and settlement.',
    blocks: [
      { type: 'heading', id: 'connection', text: 'Connection and tools.' },
      { type: 'table', columns: ['Term', 'Meaning'], rows: [
        ['MCP', 'Model Context Protocol: the interface through which an agent discovers and calls tools.'],
        ['Client', 'The application hosting your agent and managing its connection to the server.'],
        ['Tool', 'A named operation with an input schema. Many AGENT tools contain an action argument.'],
        ['Connector', 'A configured server connection, including the account credential where required.'],
        ['Capability', 'A specific action on a network and asset, with defined permissions and execution behavior.'],
      ] },
      { type: 'heading', id: 'wallet', text: 'Wallet and identity.' },
      { type: 'table', columns: ['Term', 'Meaning'], rows: [
        ['Account scope', 'The identity boundary separating one user’s wallets, history, and stored data from another’s.'],
        ['EVM wallet', 'A key/address used on EVM networks; each chain maintains its own balance and transaction history.'],
        ['NEAR access key', 'A native NEAR account credential with full-access or constrained function-call permissions.'],
        ['Unified Address', 'A Zcash address format that can contain multiple receiver types. The chosen receiver matters for privacy.'],
        ['Viewing key', 'A key that can disclose wallet activity without authorizing spending. Treat it as sensitive.'],
        ['Signer', 'The component that authorizes chain-specific transactions with the appropriate key.'],
      ] },
      { type: 'heading', id: 'execution', text: 'Execution and recovery.' },
      { type: 'table', columns: ['Term', 'Meaning'], rows: [
        ['Human amount', 'An amount such as "1.25" tokens. The handler converts it using the asset’s decimals.'],
        ['Atomic amount', 'An integer number of the smallest unit, represented as a string when stored or transmitted.'],
        ['Slippage', 'The permitted difference between an expected price and execution output; check the adapter’s units.'],
        ['Quote expiry', 'The point after which a route must be refreshed and, if changed, reapproved.'],
        ['Approval', 'Acceptance of a specific action and its bounds. Distinct from both login and signing.'],
        ['Submission', 'Sending a signed transaction or instruction to a network or provider.'],
        ['Confirmation', 'Evidence that the chain accepted a transaction under the required finality policy.'],
        ['Settlement', 'Completion of the intended asset delivery; a source transaction alone does not prove it.'],
        ['Reconciliation', 'Checking an existing operation’s state after delays, restarts, or ambiguous responses.'],
        ['Idempotency', 'Preventing a repeated request from creating a second unintended operation.'],
      ] },
    ],
  },
]

export const docGroups = ['Get started', 'Guides', 'Architecture', 'Reference', 'Build & operate']
export const articles: DocArticle[] = [...roadmapArticles, ...gettingStartedArticles, ...guideArticles, ...architectureArticles, ...referenceArticles]
  .sort((a, b) => docGroups.indexOf(a.group) - docGroups.indexOf(b.group))
