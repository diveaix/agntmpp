# AGNT MPP

AGNT is an agent-native DeFi MCP server and web dashboard for wallets, swaps, bridges, Polymarket, Hyperliquid, market data, and automations.

The product has two local surfaces:

- MCP server: exposes tools to agent clients over Streamable HTTP and legacy SSE.
- Web app: dashboard, toolkit, plans, docs, and checkout UI.

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
- Pricing: `http://localhost:3001/pricing`

## Agent Client Setup

For clients that support headers, connect to:

```text
http://localhost:3001/mcp
```

Use this header:

```text
x-agnt-api-key: <your AGNT API key>
```

For clients that cannot set headers, generate a connector URL from the dashboard and use that URL directly.

## Wallet Model

Wallets are encrypted at rest and scoped to the authenticated user id. Reconnecting later with the same API key or connector token resolves to the same wallet scope.

Transaction tools do not create fallback execution wallets. Create or switch to a user wallet before sending swaps, bridges, approvals, or trades.

## Useful Checks

```bash
npx tsc --noEmit
node --import tsx/esm --test src/mcp/tools/wallet-scope.test.ts
node --import tsx/esm --test src/mcp/tools/payments-access.test.ts
npm run build
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

Do not commit `.env`, `.agnt/`, encrypted wallet files, logs, or build output.

Hosted deployments need persistent storage or external encrypted storage for:

- access store
- wallet vaults
- wallet export password vaults
- automations
- activity logs
- payment/session tracking

Use a strong `AGNT_PASSPHRASE` in every environment. Losing or changing it can make encrypted local state unreadable.
