# AGENT

AGENT is an agent-native DeFi MCP server and web dashboard for EVM wallets, swaps, bridges, lending, market data. Zcash gateway support is planned, not live.

The product has two local surfaces:

- MCP server: exposes tools to agent clients over Streamable HTTP and legacy SSE.
- Web app: dashboard, toolkit, and docs UI.

## Run Locally

Install dependencies:

```bash
npm install
```

Create a local env file:

```bash
cp .env.example .env
```

Start the full local app:

```bash
npm run dev
```

Start only the MCP server:

```bash
npm run mcp:serve
```

Start only the frontend:

```bash
npm run dev:client
```

Default local URLs:

- Website: `http://localhost:5173`
- MCP: `http://localhost:3001/mcp`
- SSE: `http://localhost:3001/sse`
- Health: `http://localhost:3001/health`
- Readiness: `http://localhost:3001/ready`
- Pricing: `http://localhost:3001/pricing`

## Agent Client Setup

For clients that support headers, connect to:

```text
http://localhost:3001/mcp
```

Use this header:

```text
x-agnt-api-key: <your AGENT API key>
```

For clients that cannot set headers, generate a connector URL from the dashboard and use that URL directly.

## Wallet Model

Wallets are encrypted at rest and scoped to the authenticated user id. Reconnecting later with the same API key or connector token resolves to the same wallet scope.

Transaction tools do not create fallback execution wallets. Create or switch to a user wallet before sending swaps, bridges, approvals, or trades.

## Supported Networks

The EVM registry contains Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, Abstract, BNB Chain, Linea, and zkSync Era. Tool and protocol support varies by network. Base is the default wallet network.

Automation creation and background execution have been removed. Existing history remains readable.

## Account Access

Account access uses API keys or connector URLs. Checkout and paid plans have been removed.

## Useful Checks

```bash
npm run check
```

## Local Smoke Checklist

1. Open `http://localhost:5173/dashboard`.
2. Create or log in to a dashboard account.
3. Create one API key and one connector URL.
4. Create or switch to a wallet through the MCP client.
5. Check balances for the active wallet.
6. Run one read-only quote before any live transaction, for example a Jumper quote.
7. For native ETH `all` or `max` routes, leave `AGNT_NATIVE_MAX_RESERVE_ETH` set so gas is reserved automatically.
8. Confirm dashboard History shows quotes, failed write attempts, approvals, swaps, bridges, and automation runs for the logged-in user only.

## Production Notes

The supported production topology is currently one MCP process/replica with a persistent encrypted `.agnt` volume. Horizontal replicas require replacing the file stores with a transactional database and distributed scheduler/locking first.

Copy `.env.example`, then set at minimum:

- `NODE_ENV=production`
- a unique `AGNT_PASSPHRASE` of at least 32 characters
- `AGNT_ALLOWED_ORIGINS` to the exact public dashboard origin(s)
- `AGNT_SINGLE_INSTANCE=true`
- `AGNT_EMAIL_PROVIDER=webhook` and `AGNT_EMAIL_WEBHOOK_URL`

The email webhook receives `{ to, template, code, expiresAt }` as JSON. If `AGNT_EMAIL_WEBHOOK_SECRET` is set, it is sent as a Bearer token.

Live transaction execution is off by default in production. Enable `AGNT_LIVE_EXECUTION_ENABLED=true` only after wallet funding, RPC, monitoring, incident response, and transaction policy review. This gate controls explicit transaction tools.

Build and run the MCP backend and web proxy as separate supervised processes:

```bash
npm ci
npm run check
npm run mcp:serve
npm run start:web
```

Use `/health` for liveness and `/ready` for readiness. Termination signals flush memory and drain HTTP connections.

Do not commit `.env`, `.agnt/`, encrypted wallet files, logs, build output, or wallet recovery exports.

Hosted deployments need persistent storage or external encrypted storage for:

- access store
- wallet vaults
- wallet export password vaults
- legacy automation history, if present
- activity logs
- historical payment records and call tracking

Use a strong `AGNT_PASSPHRASE` in every environment. Losing or changing it can make encrypted local state unreadable.
