import type { DocArticle } from './types'

export const gettingStartedArticles: DocArticle[] = [
  {
    id: 'overview', group: 'Get started', title: 'Build with ./AGENT.',
    description: 'The developer manual for agent-native execution. Three wallets, a shared tool layer, and a clear path from instruction to receipt.',
    blocks: [
      { type: 'flow', items: ['Connect your agent', 'Prepare an action', 'Authorize execution', 'Follow the receipt'] },
      { type: 'heading', id: 'start', text: 'Start with a connection.' },
      { type: 'text', text: './AGENT brings wallet, transaction, market, and DeFi tools into an MCP client. Your agent is the interface: it discovers typed tools, builds the request, and returns the result to the same conversation. Use the hosted connection from your client, or integrate the MCP server into your own application.' },
      { type: 'links', items: [
        { title: 'Connect your agent', description: 'Add the server and make your first tool call.', href: '/docs#connection' },
        { title: 'Build an MCP client', description: 'A complete TypeScript connection and discovery example.', href: '/docs#sdk' },
        { title: 'Explore the tool reference', description: '22 built-in tools, actions, parameters, and examples.', href: '/docs#tool-reference' },
        { title: 'Understand the architecture', description: 'Zcash, EVM, and native NEAR through one connection.', href: '/docs#architecture' },
        { title: 'Upcoming tools & roadmap', description: 'Wallet signing, shielded execution, and the next capabilities.', href: '/docs#roadmap' },
        { title: 'Execute a transaction', description: 'Follow a complete request from preparation to receipt.', href: '/docs#execution' },
      ] },
      { type: 'heading', id: 'three-wallets', text: 'Three wallets. One agent.' },
      { type: 'table', columns: ['Wallet', 'Responsibility', 'Account model'], rows: [
        ['Zcash', 'Shielded ZEC, private receiving, and payment settlement', 'Chain-specific receivers, keys, and wallet scanning'],
        ['EVM', 'Transfers, swaps, cross-chain execution, and DeFi', 'An EVM address with separate balances on each network'],
        ['Native NEAR', 'NEAR balances, account permissions, and native transactions', 'A separate account and access-key model'],
      ] },
      { type: 'text', text: 'One connection does not merge the wallets, their signatures, or their balances. Each adapter handles its own network rules. The shared execution layer gives the agent a consistent way to express intent and follow an operation across those boundaries.' },
      { type: 'heading', id: 'navigate', text: 'How to use this manual.' },
      { type: 'list', items: [
        'Get started: connector setup, authentication, and your first SDK integration.',
        'Guides: complete workflows with concrete tool arguments and result handling.',
        'Architecture: the three-wallet model, signing, settlement, and recovery.',
        'Reference: tool schemas, network identifiers, and terminology.',
        'Build & operate: the wire protocol, local development, extensions, the expanded roadmap, and troubleshooting.',
      ] },
      { type: 'note', title: 'Use the connected server as the source of truth', text: 'Architecture chapters describe the system’s responsibilities. Runnable tool examples use the built-in registry. Call tools/list on your environment before integrating: installed extensions, account permissions, and adapter capabilities determine the exact callable surface. A listed action is not a guarantee of execution on every network.' },
      { type: 'code', label: 'First instruction', language: 'text', code: 'Show my wallets and the selected account.\nRead its balances on Base. Do not submit a transaction.' },
    ],
  },
  {
    id: 'connection', group: 'Get started', title: 'Connect your agent.',
    description: 'Add a remote MCP connection, discover the tools, and begin with a read-only request.',
    blocks: [
      { type: 'heading', id: 'endpoint', text: 'The server address.' },
      { type: 'code', label: 'Streamable HTTP endpoint', language: 'text', code: 'https://mcp.agntmpp.xyz/mcp' },
      { type: 'text', text: 'Add a remote server named AGENT in your client’s MCP or connector settings. Choose Streamable HTTP. Use the authorized connector URL supplied for your environment when access is required; the public server address alone does not identify a wallet owner.' },
      { type: 'list', ordered: true, items: [
        'Open the agent’s connector settings and add a remote MCP server.',
        'Paste your authorized connection URL into the server URL field. Keep a token-bearing URL in private client settings.',
        'Save the connection and let the client initialize the session and discover the tool schemas.',
        'Ask to list your wallets. Check that the response belongs to the account you intended to connect.',
        'Read a balance or request market data before using transaction tools.',
      ] },
      { type: 'heading', id: 'first-call', text: 'Your first tool call.' },
      { type: 'text', text: 'An instruction such as “show my wallets” becomes a tools/call request. The registered name is wallet and the operation is an action argument. Do not rename it to create_wallet, get_wallets, or another inferred method.' },
      { type: 'code', label: 'MCP tool arguments', language: 'json', code: '{\n  "name": "wallet",\n  "arguments": {\n    "action": "list"\n  }\n}' },
      { type: 'code', label: 'A second read-only request', language: 'json', code: '{\n  "name": "market_data",\n  "arguments": {\n    "action": "price",\n    "token": "ethereum"\n  }\n}' },
      { type: 'heading', id: 'check', text: 'Confirm the connection.' },
      { type: 'list', items: [
        'The client reports a connected MCP server and shows discovered tool names.',
        'A read-only call produces content rather than an authorization error.',
        'The selected account and network are explicit before you prepare a transaction.',
        'If you see a 401 response, check the connection credential; reconnecting a bare URL does not grant account access.',
      ] },
      { type: 'links', items: [
        { title: 'Client configurations', description: 'Claude Code, Cursor, VS Code, and local stdio.', href: '/docs#clients' },
        { title: 'Connection & identity', description: 'Authorized URLs, headers, and secret handling.', href: '/docs#authentication' },
      ] },
    ],
  },
  {
    id: 'clients', group: 'Get started', title: 'Client configurations.',
    description: 'Connect from the tools you already use. Keep the MCP transport and the account credential together.',
    blocks: [
      { type: 'heading', id: 'claude', text: 'Claude Code.' },
      { type: 'text', text: 'Use the HTTP transport with your authorized connector URL. Replace the example token before running this command. For a URL that includes credentials, use private local configuration rather than committing a shared project file.' },
      { type: 'code', label: 'Terminal · replace the connector token', language: 'bash', code: 'claude mcp add --transport http agent \\\n  "https://mcp.agntmpp.xyz/mcp?agnt_connector_token=YOUR_CONNECTOR_TOKEN"\n\nclaude mcp list\nclaude mcp get agent' },
      { type: 'text', text: 'In the Claude Code conversation, /mcp shows connected servers. Confirm that AGENT is present, then ask for your wallet list. Client-level tool approval and transaction authorization are separate decisions.' },
      { type: 'links', items: [{ title: 'Claude Code MCP documentation', description: 'Official transport, scope, and configuration reference.', href: 'https://code.claude.com/docs/en/mcp' }] },
      { type: 'heading', id: 'cursor', text: 'Cursor.' },
      { type: 'text', text: 'Add the server to your personal MCP configuration in your home directory. This URL form keeps setup consistent with clients that do not support custom authorization headers. Protect the configuration file as a credential; a project-level .cursor/mcp.json must not contain this token.' },
      { type: 'code', label: 'Personal ~/.cursor/mcp.json', language: 'json', code: '{\n  "mcpServers": {\n    "agent": {\n      "url": "https://mcp.agntmpp.xyz/mcp?agnt_connector_token=YOUR_CONNECTOR_TOKEN"\n    }\n  }\n}' },
      { type: 'links', items: [{ title: 'Cursor MCP documentation', description: 'Official MCP configuration and tool controls.', href: 'https://cursor.com/docs/mcp' }] },
      { type: 'heading', id: 'vscode', text: 'VS Code.' },
      { type: 'text', text: 'For VS Code’s built-in MCP client, use a servers entry with type http. An input variable lets the client request the authorized URL without saving it in a checked-in workspace file. Input-based entries are not forwarded to Agent Host sessions; configure those sessions using the separate mechanism in the linked reference.' },
      { type: 'code', label: '.vscode/mcp.json · built-in MCP client', language: 'json', code: '{\n  "inputs": [\n    {\n      "id": "agentUrl",\n      "type": "promptString",\n      "description": "Your authorized AGENT connector URL",\n      "password": true\n    }\n  ],\n  "servers": {\n    "agent": {\n      "type": "http",\n      "url": "${input:agentUrl}"\n    }\n  }\n}' },
      { type: 'links', items: [{ title: 'VS Code MCP configuration', description: 'Server entries, inputs, and Agent Host differences.', href: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration' }] },
      { type: 'heading', id: 'stdio', text: 'Local stdio.' },
      { type: 'text', text: 'A local client can launch the server directly from a trusted checkout with Node.js 22 or newer. Install the repository dependencies first. The stdio entry point does not automatically load .env: supply AGNT_PASSPHRASE and the intended runtime settings through the client’s private environment configuration or the parent process environment. Use an absolute repository path so the process resolves its encrypted stores consistently.' },
      { type: 'code', label: 'MCP configuration · trusted local checkout', language: 'json', code: '{\n  "mcpServers": {\n    "agent-local": {\n      "command": "npm",\n      "args": ["--prefix", "/absolute/path/to/AGENT", "run", "--silent", "mcp"]\n    }\n  }\n}' },
      { type: 'note', title: 'Local execution boundary', text: 'The stdio process runs with your local permissions and configured wallet stores. Use a dedicated development environment. Client launchers differ on Windows; if npm is not executable directly, use the launcher supported by your client rather than assuming a shell is present.' },
      { type: 'heading', id: 'other-clients', text: 'Any compatible MCP client.' },
      { type: 'text', text: 'Choose the Streamable HTTP endpoint, provide the authorized connection, and let the client discover tool schemas. The fields may be called servers or mcpServers; use your client’s schema rather than copying another client’s file unchanged. The same tool names and action arguments apply after initialization.' },
    ],
  },
  {
    id: 'authentication', group: 'Get started', title: 'Connection & identity.',
    description: 'Associate the connection with the correct account without exposing credentials to the model or to your frontend bundle.',
    blocks: [
      { type: 'heading', id: 'connector', text: 'An authorized connection.' },
      { type: 'text', text: 'The usual client experience is a connector URL supplied through account provisioning. A connector token identifies an account to the MCP host. Treat the complete URL as a secret: it can appear in client configuration, shell history, browser history, and network logs.' },
      { type: 'code', label: 'Connector URL shape · placeholder only', language: 'text', code: 'https://mcp.agntmpp.xyz/mcp?agnt_connector_token=YOUR_CONNECTOR_TOKEN' },
      { type: 'text', text: 'The public dashboard is not part of this onboarding flow. If your environment has not issued an authorized connection, obtain one from its operator. A generic OAuth token from an unrelated login service does not establish an AGENT wallet identity.' },
      { type: 'heading', id: 'headers', text: 'Credentials for custom clients.' },
      { type: 'text', text: 'Server-to-server integrations can use an issued account API key in either the Authorization bearer header or x-agnt-api-key. Send one credential mechanism consistently. Keep the key in a server environment variable or secret store; do not add it to a VITE_ variable or a public client-side request.' },
      { type: 'code', label: 'TypeScript · alternative header authentication', language: 'typescript', code: `const endpoint = new URL('https://mcp.agntmpp.xyz/mcp');
const apiKey = process.env.AGNT_API_KEY;
if (!apiKey) throw new Error('Missing issued AGENT account key');

const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: {
    headers: { Authorization: 'Bearer ' + apiKey }
  }
});` },
      { type: 'heading', id: 'boundaries', text: 'Identity, permission, signature.' },
      { type: 'table', columns: ['Boundary', 'What it establishes'], rows: [
        ['Connection identity', 'Which account owns the MCP session and account-scoped records.'],
        ['Tool permission', 'Whether the account and runtime permit the requested action.'],
        ['Transaction approval', 'Which network, amount, recipient, fees, and expiry were accepted.'],
        ['Signing', 'The chain-specific authorization of the transaction itself.'],
      ] },
      { type: 'text', text: 'A valid connection does not imply unlimited transaction authority. Your client should preserve review boundaries and display actionable failures. Do not retry failed authentication with another user’s key or silently fall back to a different wallet.' },
      { type: 'heading', id: 'rotation', text: 'Rotation and separation.' },
      { type: 'list', items: [
        'Use distinct credentials for development and production.',
        'Replace a compromised connection credential and remove it from client settings and logs.',
        'Restart or reconnect sessions after rotation and confirm the expected account with account.me.',
        'Exclude connector URLs, authorization headers, private keys, and wallet backups from analytics and error reports.',
      ] },
      { type: 'code', label: 'Check the connected account', language: 'json', code: '{\n  "name": "account",\n  "arguments": { "action": "me" }\n}' },
    ],
  },
  {
    id: 'sdk', group: 'Get started', title: 'Build an MCP client.',
    description: 'A complete TypeScript example for connection, discovery, a read-only tool call, and cleanup.',
    blocks: [
      { type: 'heading', id: 'install', text: 'Prepare the project.' },
      { type: 'text', text: 'This example uses the v1 TypeScript MCP SDK, matching the server’s SDK family. Run it in a Node.js 22+ application. AGNT_MCP_URL is an environment variable for this example client; it contains your issued connection URL, not a public website URL.' },
      { type: 'code', label: 'Terminal · in your client project', language: 'bash', code: 'npm install @modelcontextprotocol/sdk@^1.30.0\nnpm install --save-dev typescript tsx @types/node\nnpx tsx client.ts' },
      { type: 'heading', id: 'client', text: 'Connect, discover, call.' },
      { type: 'code', label: 'client.ts · read-only example', language: 'typescript', code: `import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const connectionUrl = process.env.AGNT_MCP_URL;
if (!connectionUrl) throw new Error('Set AGNT_MCP_URL');

const client = new Client({ name: 'agent-example', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(connectionUrl));

try {
  await client.connect(transport);

  const tools = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  const wallet = tools.find(tool => tool.name === 'wallet');
  if (!wallet) throw new Error('This connection does not expose wallet');

  const result = await client.callTool({
    name: 'wallet',
    arguments: { action: 'list' }
  });

  if (result.isError) throw new Error('Wallet tool returned an error');
  // Preserve non-text blocks in your application if needed.
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') console.log(block.text);
    }
  }
} finally {
  await client.close();
}` },
      { type: 'text', text: 'The SDK handles initialization, protocol negotiation, JSON/SSE responses, and session headers. Do not assume every HTTP response is a single JSON object. Also distinguish a successful HTTP exchange from a successful tool: isError belongs to the tool result.' },
      { type: 'heading', id: 'schemas', text: 'Keep the discovered schema.' },
      { type: 'text', text: 'Pass each tool’s name, description, and inputSchema into your agent’s tool interface. Validate the model’s arguments against that schema before dispatching them. Do not turn a description into an executable capability that the server did not advertise.' },
      { type: 'code', label: 'Inspect schemas · inside a connected client', language: 'typescript', code: `const { tools } = await client.listTools();
const manifest = tools.map(tool => ({
  name: tool.name,
  description: tool.description ?? '',
  inputSchema: tool.inputSchema
}));

// Register this manifest with your agent framework.
// Keep your approval policy outside model-generated arguments.
console.log(JSON.stringify(manifest, null, 2));` },
      { type: 'heading', id: 'results', text: 'Render results deliberately.' },
      { type: 'code', label: 'Illustrative MCP result envelope', language: 'json', code: '{\n  "content": [\n    { "type": "text", "text": "Tool result text appears here." }\n  ],\n  "isError": false\n}' },
      { type: 'text', text: 'The built-in handlers primarily return text content. Treat that text as a human-readable result, not a stable JSON ledger. For durable application state, record validated operation identifiers and receipt fields at your integration boundary. Never infer settlement from a success emoji or a phrase in the model’s answer.' },
      { type: 'links', items: [{ title: 'MCP TypeScript SDK', description: 'Official v1 client and transport source.', href: 'https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x' }] },
    ],
  },
  {
    id: 'protocol', group: 'Build & operate', title: 'MCP protocol.',
    description: 'Understand the wire format, sessions, and transport behavior behind the connector.',
    blocks: [
      { type: 'heading', id: 'lifecycle', text: 'Session lifecycle.' },
      { type: 'flow', items: ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'] },
      { type: 'text', text: 'The client negotiates the protocol version during initialization. A Streamable HTTP server can return a session ID; include it on later requests with the negotiated protocol-version header. Prefer the SDK for this lifecycle. The following envelopes explain the protocol and are not a substitute for a session-aware client.' },
      { type: 'code', label: 'JSON-RPC · tool discovery', language: 'json', code: '{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "method": "tools/list",\n  "params": {}\n}' },
      { type: 'code', label: 'JSON-RPC · tool execution', language: 'json', code: '{\n  "jsonrpc": "2.0",\n  "id": 2,\n  "method": "tools/call",\n  "params": {\n    "name": "wallet",\n    "arguments": { "action": "list" }\n  }\n}' },
      { type: 'heading', id: 'headers', text: 'HTTP transport headers.' },
      { type: 'code', label: 'After initialization · illustrative HTTP headers', language: 'http', code: 'POST /mcp HTTP/1.1\nContent-Type: application/json\nAccept: application/json, text/event-stream\nMcp-Session-Id: SESSION_ID_FROM_INITIALIZATION\nMCP-Protocol-Version: NEGOTIATED_VERSION\nAuthorization: Bearer YOUR_ISSUED_ACCOUNT_KEY' },
      { type: 'text', text: 'Keep session state scoped to the authenticated account. On a session-not-found response, initialize a new session; reconcile any outstanding transaction before repeating a write. A new transport session does not mean an earlier transaction was cancelled.' },
      { type: 'heading', id: 'resources', text: 'Read the server resource.' },
      { type: 'code', label: 'Server metadata · connected SDK client', language: 'typescript', code: `const resources = await client.listResources();
const info = resources.resources.find(item => item.uri === 'agent://info');
if (info) {
  const result = await client.readResource({ uri: info.uri });
  console.log(result.contents);
}` },
      { type: 'heading', id: 'transport-choice', text: 'Choose the right transport.' },
      { type: 'table', columns: ['Transport', 'Use', 'Responsibility'], rows: [
        ['Streamable HTTP · /mcp', 'Remote MCP clients', 'Authenticated session, HTTP/SSE response handling'],
        ['stdio', 'A trusted local process', 'Process environment, newline-delimited JSON-RPC, clean stdout'],
        ['Legacy SSE · /sse', 'Clients requiring the older transport', 'Use the server’s legacy endpoint and matching client transport'],
      ] },
      { type: 'links', items: [{ title: 'MCP transport specification', description: 'Official lifecycle and Streamable HTTP requirements.', href: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports' }] },
    ],
  },
  {
    id: 'development', group: 'Build & operate', title: 'Local development.',
    description: 'Run the website and MCP service separately, with explicit environment settings and persistent state.',
    blocks: [
      { type: 'heading', id: 'setup', text: 'Set up a trusted checkout.' },
      { type: 'text', text: 'Use Node.js 22 or newer. Install from the lockfile, copy the environment template, and replace its placeholder passphrase with a unique local secret. The HTTP entry point loads .env; stdio requires those settings in its actual process environment. Keep .env and encrypted wallet stores outside version control. No wallet or funding is required to build the website.' },
      { type: 'code', label: 'Terminal · repository root', language: 'bash', code: 'npm ci\n# Copy .env.example to .env using your editor.\n# Set a unique AGNT_PASSPHRASE of at least 32 characters.\nnpm run typecheck\nnpm run build' },
      { type: 'heading', id: 'processes', text: 'Start the process you need.' },
      { type: 'table', columns: ['Command', 'Purpose', 'Default address'], rows: [
        ['npm run dev:client', 'Vite website development', 'http://localhost:5173'],
        ['npm run dev:server', 'Web API / proxy service', 'http://localhost:3000'],
        ['npm run mcp:serve', 'Persistent HTTP MCP service', 'http://localhost:3001/mcp'],
        ['npm run mcp', 'Local stdio MCP process', 'Client-managed stdin / stdout'],
        ['npm run dev', 'Combined development processes', 'All three local services'],
      ] },
      { type: 'code', label: 'Local environment · selected settings', language: 'dotenv', code: 'NODE_ENV=development\nAGNT_PORT=3001\nPORT=3000\nAGNT_MCP_HTTP_URL=http://localhost:3001\nAGNT_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000\nAGNT_SINGLE_INSTANCE=false' },
      { type: 'note', title: 'Keep development wallets separate', text: 'Development mode does not apply the production live-execution gate. Use isolated stores and read-only requests while testing the integration; do not point an experimental client at a funded production wallet.' },
      { type: 'heading', id: 'checks', text: 'Validate a change.' },
      { type: 'code', label: 'Focused repository checks', language: 'bash', code: 'npm run typecheck\nnpm test\nnpm run build\n\n# Against a separately started local HTTP MCP process:\ncurl http://localhost:3001/health\ncurl http://localhost:3001/ready' },
      { type: 'text', text: 'A successful frontend build validates the website bundle. It does not start the MCP runtime, validate RPC credentials, migrate a database, or prove a transaction adapter. Test an adapter’s input validation and receipt handling independently from page rendering.' },
      { type: 'heading', id: 'source-map', text: 'Find your way through the code.' },
      { type: 'table', columns: ['Path', 'Responsibility'], rows: [
        ['src/client', 'React website, documentation, toolkit, and visual components'],
        ['src/mcp/serve.ts', 'HTTP MCP sessions and authenticated server routes'],
        ['src/mcp/server.ts', 'stdio entry point and resource registration'],
        ['src/mcp/tools/index.ts', 'Tool registry, dispatch, and account context'],
        ['src/mcp/tools', 'Tool schemas and handlers'],
        ['src/mcp/chains.ts', 'Configured EVM networks and clients'],
        ['src/mcp/sale', 'Separate Zcash deposit, signing, and accounting infrastructure'],
      ] },
    ],
  },
  {
    id: 'deployment', group: 'Build & operate', title: 'Deployment boundaries.',
    description: 'Operate the web surface and the persistent execution service with the right state, secrets, and checks.',
    blocks: [
      { type: 'heading', id: 'services', text: 'Website and execution runtime.' },
      { type: 'text', text: 'The React site builds to static assets and can be hosted on Vercel. The HTTP MCP service owns sessions, account-scoped state, and transaction coordination. Deploying new website assets does not deploy or enable that persistent service.' },
      { type: 'flow', items: ['Agent client', 'Authenticated MCP service', 'Wallet / protocol adapter', 'RPC or provider'] },
      { type: 'heading', id: 'configuration', text: 'Production configuration.' },
      { type: 'table', columns: ['Setting', 'Purpose'], rows: [
        ['AGNT_PASSPHRASE', 'Encryption secret; a unique value of at least 32 characters'],
        ['AGNT_ALLOWED_ORIGINS', 'Explicit public origins; no production wildcard'],
        ['AGNT_SINGLE_INSTANCE=true', 'Acknowledges file-store operation with a single replica'],
        ['AGNT_EMAIL_PROVIDER=webhook', 'Production verification-code delivery'],
        ['AGNT_EMAIL_WEBHOOK_URL', 'Configured mail-delivery integration endpoint'],
        ['AGNT_LIVE_EXECUTION_ENABLED', 'Production transaction gate, distinct from tool registration'],
      ] },
      { type: 'text', text: 'The current encrypted file stores require a persistent volume and a single process/replica. Back up the stores and their encryption secret with separate access controls. Migrating shared execution state to a transactional store is a prerequisite for scaling that state across replicas.' },
      { type: 'heading', id: 'health', text: 'Check readiness and recovery.' },
      { type: 'list', items: [
        'Verify /health for process health and /ready for configured readiness.',
        'Establish an authenticated MCP connection and inspect tools/list.',
        'Confirm the intended account scope using a read-only request.',
        'Verify persistent storage survives a process restart.',
        'Track unsettled operations and reconcile existing submissions before retrying writes.',
      ] },
      { type: 'heading', id: 'logging', text: 'Keep useful logs, not secrets.' },
      { type: 'code', label: 'Application-side log record · example', language: 'json', code: '{\n  "requestId": "req_example_01",\n  "tool": "wallet_send",\n  "action": "status",\n  "network": "base",\n  "durationMs": 240,\n  "outcome": "receipt_pending"\n}' },
      { type: 'text', text: 'Use request and operation identifiers to investigate failures. Redact authorized connector URLs, tokens, private keys, backups, viewing keys, and sensitive memos. Avoid logging raw tool arguments by default: wallet recovery and signing-related inputs can contain secrets.' },
    ],
  },
  {
    id: 'extensions', group: 'Build & operate', title: 'Tools & extensions.',
    description: 'Extend the capability catalog without changing the contract between your agent and the MCP server.',
    blocks: [
      { type: 'heading', id: 'catalog', text: 'Discover capabilities at runtime.' },
      { type: 'text', text: 'The base registry combines wallet, execution, DeFi, analytics, memory, and account modules. The skill loader can add tools. Clients should discover the current catalog at connection time instead of hard-coding a tool count or assuming a feature from its marketing name.' },
      { type: 'code', label: 'Inspect installed skills', language: 'json', code: '{\n  "name": "skill_manager",\n  "arguments": { "action": "list" }\n}' },
      { type: 'heading', id: 'definition', text: 'Design a small, typed surface.' },
      { type: 'text', text: 'Start with a read-only operation and a narrow input schema. This JSON is an example tool definition for your own integration, not a registered AGENT method. A production extension also needs a handler, validation, account isolation, permission checks, and tests.' },
      { type: 'code', label: 'Example extension schema · application design', language: 'json', code: '{\n  "name": "example_receipt_reader",\n  "description": "Read an existing receipt on an explicitly selected network",\n  "inputSchema": {\n    "type": "object",\n    "properties": {\n      "chain": { "type": "string", "enum": ["base", "ethereum"] },\n      "hash": { "type": "string", "pattern": "^0x[a-fA-F0-9]{64}$" }\n    },\n    "required": ["chain", "hash"],\n    "additionalProperties": false\n  }\n}' },
      { type: 'heading', id: 'adapter-contract', text: 'Make each capability specific.' },
      { type: 'list', items: [
        'Name the exact action, supported network, asset types, and account model.',
        'Separate reads, preparation, transaction submission, and administrative operations.',
        'Keep amounts precise; explicitly document whether an input uses human or atomic units.',
        'Return durable operation or transaction identifiers where the handler supports them.',
        'Document error states, quote expiry, confirmation rules, and recovery behavior.',
      ] },
      { type: 'heading', id: 'trust', text: 'Install code as an operator.' },
      { type: 'text', text: 'Runtime skill installation imports executable code into the server. Treat installation, removal, and reload as privileged deployment operations. Review the source and its dependencies, pin the artifact, and test it with isolated accounts before making its tools available to agents.' },
      { type: 'text', text: 'This checkout refreshes the advertised tool list during HTTP service initialization. Installing, removing, or reloading a skill does not rebuild that list in the running process. Restart the HTTP service, reconnect the client, and verify tools/list after changing the installed catalog.' },
      { type: 'links', items: [
        { title: 'Tool reference', description: 'Inspect the built-in interfaces before adding another.', href: '/docs#tool-reference' },
        { title: 'Execution controls', description: 'Keep policy outside model-generated instructions.', href: '/docs#control' },
      ] },
    ],
  },
]
