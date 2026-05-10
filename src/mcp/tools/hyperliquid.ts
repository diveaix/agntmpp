/**
 * ./AGNT Protocol — Hyperliquid Perps Trading Tools
 * 8 tools for perpetual futures trading on Hyperliquid.
 * Uses Hyperliquid's REST API with EIP-712 signing via the existing wallet key.
 */

import type { ToolModule } from './index.js'
import { getActiveWallet, getOrCreateWallet, getAccount } from '../wallet.js'
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import { SymbolConverter } from '@nktkas/hyperliquid/utils'
import {
  formatHyperliquidSetupGuide,
  getHyperliquidSetupBlocker,
  isHyperliquidSetupGuideQuery,
  simulateHyperliquidOrder,
  type HyperliquidOrderKind,
  type HyperliquidSetupStatus,
} from './hyperliquid-helpers.js'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (e: string) => ({ content: [{ type: 'text' as const, text: `❌ ${e}` }], isError: true })

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info'
const LIVE_CONFIRM_FLAG = 'execute'

function floatToWire(x: number): string {
  const s = x.toPrecision(5)
  return parseFloat(s).toString()
}

// ─── Hyperliquid API Helpers ─────────────────────────────

async function hlPost(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`)
  return res.json()
}

async function getHlMeta(): Promise<{ universe: { name: string; szDecimals: number }[]; assetCtxs: { funding: string; openInterest: string; markPx: string; dayNtlVlm: string }[] }> {
  const data = await hlPost(HL_INFO_URL, { type: 'metaAndAssetCtxs' }) as [{ universe: { name: string; szDecimals: number }[] }, { funding: string; openInterest: string; markPx: string; dayNtlVlm: string }[]]
  return { universe: data[0].universe, assetCtxs: data[1] }
}

function resolveAssetIndex(universe: { name: string }[], symbol: string): number {
  const idx = universe.findIndex((u) => u.name.toLowerCase() === symbol.toLowerCase())
  if (idx === -1) throw new Error(`Market "${symbol}" not found on Hyperliquid. Available: ${universe.slice(0, 20).map((u) => u.name).join(', ')}...`)
  return idx
}

async function getHyperliquidSetupStatus(): Promise<HyperliquidSetupStatus> {
  const w = getActiveWallet()
  if (!w) return { hasWallet: false }

  try {
    const data = await hlPost(HL_INFO_URL, { type: 'clearinghouseState', user: w.address }) as {
      marginSummary?: { accountValue?: string; totalMarginUsed?: string }
      assetPositions?: { position: { szi: string } }[]
    }
    const accountValue = parseFloat(data.marginSummary?.accountValue || '0')
    const marginUsed = parseFloat(data.marginSummary?.totalMarginUsed || '0')
    const openPositions = data.assetPositions?.filter((p) => parseFloat(p.position.szi) !== 0).length || 0
    return {
      hasWallet: true,
      walletName: w.name,
      address: w.address,
      accountValue,
      availableMargin: accountValue - marginUsed,
      openPositions,
    }
  } catch {
    return {
      hasWallet: true,
      walletName: w.name,
      address: w.address,
      accountValue: 0,
      availableMargin: 0,
      openPositions: 0,
    }
  }
}

function getHlExchangeClient() {
  const w = getOrCreateWallet()
  const wallet = getAccount(w)
  const transport = new HttpTransport()
  return { w, exchange: new ExchangeClient({ transport, wallet }) }
}

function getHlInfoClient() {
  const transport = new HttpTransport()
  return new InfoClient({ transport })
}

async function getHlSymbolConverter() {
  const transport = new HttpTransport()
  return SymbolConverter.create({ transport })
}

function wantsLiveExecution(args: Record<string, unknown>) {
  return args[LIVE_CONFIRM_FLAG] === true || args.live === true || args.confirm === true
}

function getOrderKind(args: Record<string, unknown>): HyperliquidOrderKind {
  const raw = ((args.orderKind || args.type || (args.price ? 'limit' : 'market')) as string).toLowerCase()
  if (['market', 'limit', 'scale', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'twap'].includes(raw)) {
    return raw as HyperliquidOrderKind
  }
  throw new Error('orderKind must be market, limit, scale, stop_market, stop_limit, take_market, take_limit, or twap.')
}

async function buildHyperliquidSimulation(args: Record<string, unknown>) {
  const market = ((args.market as string | undefined) || 'BTC').toUpperCase()
  const side = ((args.side as string | undefined) || 'buy').toLowerCase() as 'buy' | 'sell'
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be buy or sell.')
  const meta = await getHlMeta()
  const assetIdx = resolveAssetIndex(meta.universe, market)
  const markPrice = parseFloat(meta.assetCtxs[assetIdx].markPx)
  return simulateHyperliquidOrder({
    kind: getOrderKind(args),
    market,
    side,
    markPrice,
    amountUsd: args.amount as number | undefined,
    size: args.size as number | undefined,
    price: args.price as number | undefined,
    leverage: args.leverage as number | undefined,
    stopPrice: args.stopPrice as number | undefined,
    stopLoss: args.stopLoss as number | undefined,
    takeProfit: args.takeProfit as number | undefined,
    startPrice: args.startPrice as number | undefined,
    endPrice: args.endPrice as number | undefined,
    totalOrders: args.totalOrders as number | undefined,
    durationMinutes: args.durationMinutes as number | undefined,
    reduceOnly: args.reduceOnly as boolean | undefined,
  })
}

function formatSimulationResult(result: ReturnType<typeof simulateHyperliquidOrder>) {
  const lines = [
    'Hyperliquid Trade Simulation',
    '',
    result.summary,
  ]
  if (result.childOrders.length) {
    lines.push('', 'Child orders:')
    for (const child of result.childOrders) {
      lines.push(`  ${child.index}. $${child.price.toLocaleString()} | ${child.size} ${result.market} | ~$${child.notional.toFixed(2)}`)
    }
  }
  lines.push('', 'No live order was placed.')
  return lines.join('\n')
}

function wirePrice(value: number): string {
  return floatToWire(value)
}

function wireSize(value: number): string {
  return floatToWire(value)
}

async function executePerpOrderWithSdk(args: Record<string, unknown>, result: ReturnType<typeof simulateHyperliquidOrder>) {
  const { exchange } = getHlExchangeClient()
  const meta = await getHlMeta()
  const assetIdx = resolveAssetIndex(meta.universe, result.market)
  const mark = parseFloat(meta.assetCtxs[assetIdx].markPx)
  const sideIsBuy = result.side === 'buy'
  const reduceOnly = args.reduceOnly === true
  const slippage = ((args.slippage as number | undefined) ?? 0.5) / 100
  const kind = result.kind

  if (kind === 'twap') {
    return exchange.twapOrder({
      twap: {
        a: assetIdx,
        b: sideIsBuy,
        s: wireSize(result.size),
        r: reduceOnly,
        m: Math.max(5, Math.floor((args.durationMinutes as number | undefined) ?? 10)),
        t: args.randomize !== false,
      },
    })
  }

  const baseOrder = (price: number, size = result.size) => ({
    a: assetIdx,
    b: sideIsBuy,
    p: wirePrice(price),
    s: wireSize(size),
    r: reduceOnly,
  })

  if (kind === 'scale') {
    return exchange.order({
      orders: result.childOrders.map(child => ({
        ...baseOrder(child.price, child.size),
        t: { limit: { tif: 'Gtc' as const } },
      })),
      grouping: 'na',
    })
  }

  if (kind === 'stop_market' || kind === 'stop_limit' || kind === 'take_market' || kind === 'take_limit') {
    const isMarket = kind.endsWith('market')
    const triggerPx = (args.stopPrice as number | undefined) ?? (kind.startsWith('stop') ? args.stopLoss as number | undefined : args.takeProfit as number | undefined) ?? (args.price as number | undefined)
    if (!triggerPx) throw new Error('Trigger orders require stopPrice, stopLoss, takeProfit, or price.')
    const limitPx = (args.price as number | undefined) ?? triggerPx
    return exchange.order({
      orders: [{
        ...baseOrder(limitPx),
        t: {
          trigger: {
            isMarket,
            triggerPx: wirePrice(triggerPx),
            tpsl: kind.startsWith('stop') ? 'sl' as const : 'tp' as const,
          },
        },
      }],
      grouping: 'normalTpsl',
    })
  }

  const orderPrice = kind === 'market'
    ? (sideIsBuy ? mark * (1 + slippage) : mark * (1 - slippage))
    : ((args.price as number | undefined) ?? mark)
  return exchange.order({
    orders: [{
      ...baseOrder(orderPrice),
      t: { limit: { tif: kind === 'market' ? 'FrontendMarket' as const : 'Gtc' as const } },
    }],
    grouping: 'na',
  })
}

function formatLiveExchangeResponse(title: string, response: unknown) {
  return `${title}\n\n${JSON.stringify(response, null, 2)}`
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'hyperliquid',
    description: 'Hyperliquid perps: trade, bracket orders (entry+SL+TP), copy trading, DCA, trailing stops, risk calc, P&L, funding scanner. Natural language: "long BTC 76k sl 75.8k tp 78k 10x"',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['order', 'simulate', 'scale', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'twap', 'bracket', 'close', 'cancel', 'positions', 'orderbook', 'account', 'markets', 'leverage', 'funding', 'setup', 'guide', 'help', 'enable_trading', 'fund', 'withdraw', 'trailing_stop', 'copy_trade', 'dca', 'pnl', 'risk', 'scanner', 'spot', 'earn', 'vaults', 'staking'],
          description: 'Action to perform',
        },
        market: { type: 'string', description: 'Market symbol (e.g. BTC, ETH)' },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'Buy (long) or sell (short)' },
        size: { type: 'number', description: 'Position size' },
        price: { type: 'number', description: 'Entry/limit price' },
        leverage: { type: 'number', description: 'Leverage 1-50' },
        reduceOnly: { type: 'boolean', description: 'Reduce only' },
        orderId: { type: 'number', description: 'Order ID (for cancel)' },
        depth: { type: 'number', description: 'Orderbook depth' },
        sortBy: { type: 'string', enum: ['volume', 'funding', 'oi'], description: 'Sort (for markets, scanner)' },
        limit: { type: 'number', description: 'Max results' },
        marginMode: { type: 'string', enum: ['cross', 'isolated'], description: 'Margin mode' },
        amount: { type: 'number', description: 'USDC amount (fund, dca)' },
        destination: { type: 'string', description: 'Destination address for withdrawals' },
        toAddress: { type: 'string', description: 'Destination address for withdrawals' },
        token: { type: 'string', description: 'Token symbol or ID (for spot/earn)' },
        operation: { type: 'string', enum: ['supply', 'withdraw', 'repay', 'borrow', 'deposit', 'delegate', 'undelegate'], description: 'Earn, vault, or staking operation' },
        vaultAddress: { type: 'string', description: 'Hyperliquid vault address' },
        validator: { type: 'string', description: 'Hyperliquid validator address' },
        orderKind: { type: 'string', enum: ['market', 'limit', 'scale', 'stop_market', 'stop_limit', 'take_market', 'take_limit', 'twap'], description: 'Order style to simulate or place.' },
        execute: { type: 'boolean', description: 'When true, send the live Hyperliquid action after simulation checks. Default false.' },
        slippage: { type: 'number', description: 'Market-order slippage guard in percent. Default 0.5.' },
        randomize: { type: 'boolean', description: 'Randomize TWAP slice timing. Default true.' },
        source: { type: 'string', description: 'Source chain (for fund)' },
        stopPrice: { type: 'number', description: 'Trigger price for stop/take orders' },
        stopLoss: { type: 'number', description: 'Stop-loss price (for bracket)' },
        takeProfit: { type: 'number', description: 'Take-profit price (for bracket)' },
        startPrice: { type: 'number', description: 'Start price for scale orders' },
        endPrice: { type: 'number', description: 'End price for scale orders' },
        totalOrders: { type: 'number', description: 'Number of child orders for scale orders' },
        durationMinutes: { type: 'number', description: 'TWAP duration in minutes' },
        percent: { type: 'number', description: 'Close this % of position (for close). 100=full' },
        trailPercent: { type: 'number', description: 'Trail distance in % (for trailing_stop). E.g. 2 = 2%' },
        trader: { type: 'string', description: 'Wallet address to copy (for copy_trade)' },
        maxPerTrade: { type: 'number', description: 'Max USDC per copied trade (for copy_trade)' },
        interval: { type: 'string', description: 'DCA interval e.g. "1h", "4h", "1d" (for dca)' },
        rounds: { type: 'number', description: 'Number of DCA rounds (for dca)' },
        prompt: { type: 'string', description: 'Natural language trade description (for bracket). E.g. "long BTC 76k sl 75.8k tp 78k 10x"' },
      },
      required: ['action'],
    },
  },
]

// ─── Handlers ────────────────────────────────────────────

async function handle(name: string, args: Record<string, unknown>) {
  if (name !== 'hyperliquid') return null

  switch (args.action) {
    case 'guide':
    case 'help':
    case 'setup': {
      const status = await getHyperliquidSetupStatus()
      const blocker = getHyperliquidSetupBlocker('order', status)
      return text(formatHyperliquidSetupGuide(status, blocker))
    }

    case 'simulate': {
      try {
        const result = await buildHyperliquidSimulation(args)
        return text(formatSimulationResult(result))
      } catch (e) {
        return err(`Simulation failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'scale':
    case 'stop_market':
    case 'stop_limit':
    case 'take_market':
    case 'take_limit':
    case 'twap': {
      try {
        const action = args.action as HyperliquidOrderKind
        const result = await buildHyperliquidSimulation({ ...args, orderKind: action })
        if (wantsLiveExecution(args)) {
          const live = await executePerpOrderWithSdk({ ...args, orderKind: action }, result)
          return text(formatSimulationResult(result) + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid action submitted', live))
        }
        return text(formatSimulationResult(result))
      } catch (e) {
        return err(`Hyperliquid action failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'enable_trading': {
      const status = await getHyperliquidSetupStatus()
      const blocker = getHyperliquidSetupBlocker('order', status)
      if (blocker) return text(formatHyperliquidSetupGuide(status, blocker))
      return text(
        `Hyperliquid Trading Readiness\n\n` +
        `Wallet: ${status.walletName} (${status.address})\n` +
        `Account value: $${(status.accountValue ?? 0).toFixed(2)}\n` +
        `Available to trade: $${(status.availableMargin ?? 0).toFixed(2)}\n\n` +
        `Trading is funded and ready.\n` +
        `Live actions require execute=true; otherwise the tool simulates first.`
      )
    }

    case 'order': {
      if (!args.market || !args.side || (args.size === undefined && args.amount === undefined)) return err('Missing market, side, and either size or amount')
      try {
        const status = await getHyperliquidSetupStatus()
        const blocker = getHyperliquidSetupBlocker('order', status)
        if (blocker) return text(formatHyperliquidSetupGuide(status, blocker))

        const result = await buildHyperliquidSimulation(args)
        if (wantsLiveExecution(args)) {
          const live = await executePerpOrderWithSdk(args, result)
          return text(formatSimulationResult(result) + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid order submitted', live))
        }
        return text(
          formatSimulationResult(result) +
          '\n\nPreview only. Add execute=true when you want to place the live order.'
        )
      } catch (e) {
        return err(`Order failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'cancel': {
      if (!args.market) return err('Missing market')
      const w = getActiveWallet()
      if (!w) return err('No wallet. Create one first.')
      const market = (args.market as string).toUpperCase()
      const orderId = args.orderId as number | undefined

      try {
        const meta = await getHlMeta()
        const assetIdx = resolveAssetIndex(meta.universe, market)
        const { exchange } = getHlExchangeClient()

        if (orderId) {
          const live = await exchange.cancel({ cancels: [{ a: assetIdx, o: orderId }] })
          return text(formatLiveExchangeResponse(`Cancelled order #${orderId} on ${market}-PERP`, live))
        }

        const openOrders = await hlPost(HL_INFO_URL, { type: 'openOrders', user: w.address }) as { coin: string; oid: number }[]
        const marketOrders = openOrders.filter(o => o.coin.toUpperCase() === market)
        if (!marketOrders.length) return text(`No open orders on ${market}-PERP.`)

        const live = await exchange.cancel({ cancels: marketOrders.map(o => ({ a: assetIdx, o: o.oid })) })
        return text(formatLiveExchangeResponse(`Cancelled ${marketOrders.length} order(s) on ${market}-PERP`, live))
      } catch (e) {
        return err(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'positions': {
      const w = getActiveWallet()
      if (!w) return text('No wallet. Create one first to view Hyperliquid positions.')

      try {
        const data = await hlPost(HL_INFO_URL, { type: 'clearinghouseState', user: w.address }) as {
          marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string }
          assetPositions: { position: { coin: string; entryPx: string; positionValue: string; unrealizedPnl: string; liquidationPx: string | null; leverage: { type: string; value: number }; szi: string } }[]
        }

        const positions = data.assetPositions.filter((p) => parseFloat(p.position.szi) !== 0)
        if (!positions.length) return text(`No open positions on Hyperliquid.\n\nWallet: ${w.name} (${w.address})`)

        const lines: string[] = ['📊 Hyperliquid Positions:\n']
        lines.push(`${'Market'.padEnd(10)} ${'Side'.padEnd(6)} ${'Size'.padEnd(12)} ${'Entry'.padEnd(12)} ${'Mark'.padEnd(12)} ${'uPnL'.padEnd(12)} Liq Price`)
        lines.push('─'.repeat(78))

        const meta = await getHlMeta()

        for (const { position: p } of positions) {
          const sz = parseFloat(p.szi)
          const side = sz > 0 ? 'LONG' : 'SHORT'
          const entryPx = parseFloat(p.entryPx)
          const assetIdx = meta.universe.findIndex((u) => u.name === p.coin)
          const markPx = assetIdx >= 0 ? parseFloat(meta.assetCtxs[assetIdx].markPx) : 0
          const upnl = parseFloat(p.unrealizedPnl)
          const liqPx = p.liquidationPx ? `$${parseFloat(p.liquidationPx).toFixed(2)}` : 'N/A'

          lines.push(
            `${p.coin.padEnd(10)} ${side.padEnd(6)} ${Math.abs(sz).toString().padEnd(12)} ${'$' + entryPx.toFixed(2).padEnd(11)} ${'$' + markPx.toFixed(2).padEnd(11)} ${(upnl >= 0 ? '+' : '') + '$' + upnl.toFixed(2).padEnd(11)} ${liqPx}`
          )
        }

        const acctVal = parseFloat(data.marginSummary.accountValue)
        const marginUsed = parseFloat(data.marginSummary.totalMarginUsed)
        lines.push(`\nAccount: $${acctVal.toFixed(2)} | Margin Used: $${marginUsed.toFixed(2)} | Available: $${(acctVal - marginUsed).toFixed(2)}`)

        return text(lines.join('\n'))
      } catch (e) {
        return err(`Failed to fetch positions: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'orderbook': {
      if (!args.market) return err('Missing market')
      const market = (args.market as string).toUpperCase()
      const depth = (args.depth as number) || 5

      try {
        const meta = await getHlMeta()
        const assetIdx = resolveAssetIndex(meta.universe, market)

        const data = await hlPost(HL_INFO_URL, { type: 'l2Book', coin: market }) as {
          levels: [{ px: string; sz: string; n: number }[], { px: string; sz: string; n: number }[]]
        }

        const bids = data.levels[0].slice(0, depth)
        const asks = data.levels[1].slice(0, depth)
        const markPx = parseFloat(meta.assetCtxs[assetIdx].markPx)

        const lines: string[] = [`📖 ${market}-PERP Orderbook (${depth} levels):\n`]
        lines.push(`${'Price'.padEnd(14)} ${'Size'.padEnd(12)} Side`)
        lines.push('─'.repeat(36))

        // Asks (reversed so lowest ask is at bottom)
        for (const ask of asks.reverse()) {
          lines.push(`$${parseFloat(ask.px).toFixed(2).padEnd(13)} ${ask.sz.padEnd(12)} 🔴 ASK`)
        }
        lines.push(`${'─── Mark: $' + markPx.toFixed(2) + ' ───'}`)
        for (const bid of bids) {
          lines.push(`$${parseFloat(bid.px).toFixed(2).padEnd(13)} ${bid.sz.padEnd(12)} 🟢 BID`)
        }

        const spread = asks.length && bids.length ? parseFloat(asks[asks.length - 1].px) - parseFloat(bids[0].px) : 0
        lines.push(`\nSpread: $${spread.toFixed(2)} (${(spread / markPx * 100).toFixed(4)}%)`)

        return text(lines.join('\n'))
      } catch (e) {
        return err(`Failed to fetch orderbook: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'account': {
      const w = getActiveWallet()
      if (!w) return text('No wallet. Create one first to view Hyperliquid account.')

      try {
        const data = await hlPost(HL_INFO_URL, { type: 'clearinghouseState', user: w.address }) as {
          marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string; totalRawUsd: string }
          assetPositions: { position: { coin: string; szi: string } }[]
        }

        const acctVal = parseFloat(data.marginSummary.accountValue)
        const marginUsed = parseFloat(data.marginSummary.totalMarginUsed)
        const ntlPos = parseFloat(data.marginSummary.totalNtlPos)
        const rawUsd = parseFloat(data.marginSummary.totalRawUsd)
        const openPositions = data.assetPositions.filter((p) => parseFloat(p.position.szi) !== 0).length
        const leverage = acctVal > 0 ? ntlPos / acctVal : 0

        return text(
          `📊 Hyperliquid Account Summary\n\n` +
          `Wallet: ${w.name} (${w.address})\n\n` +
          `Account Value: $${acctVal.toFixed(2)}\n` +
          `USDC Balance: $${rawUsd.toFixed(2)}\n` +
          `Margin Used: $${marginUsed.toFixed(2)}\n` +
          `Available Margin: $${(acctVal - marginUsed).toFixed(2)}\n` +
          `Total Notional: $${ntlPos.toFixed(2)}\n` +
          `Account Leverage: ${leverage.toFixed(2)}x\n` +
          `Open Positions: ${openPositions}`
        )
      } catch (e) {
        return err(`Failed to fetch account: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'markets': {
      const sortBy = (args.sortBy as string) || 'volume'
      const limit = (args.limit as number) || 15

      try {
        const meta = await getHlMeta()
        const entries = meta.universe.map((u, i) => ({
          name: u.name,
          funding: parseFloat(meta.assetCtxs[i].funding),
          markPx: parseFloat(meta.assetCtxs[i].markPx),
          oi: parseFloat(meta.assetCtxs[i].openInterest),
          vol: parseFloat(meta.assetCtxs[i].dayNtlVlm || '0'),
        }))

        if (sortBy === 'funding') entries.sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))
        else if (sortBy === 'oi') entries.sort((a, b) => (b.oi * b.markPx) - (a.oi * a.markPx))
        else entries.sort((a, b) => b.vol - a.vol)

        const top = entries.slice(0, limit)
        const lines: string[] = [`📊 Hyperliquid Perp Markets (top ${limit} by ${sortBy}):\n`]
        lines.push(`${'Market'.padEnd(10)} ${'Mark Price'.padEnd(14)} ${'Funding/1h'.padEnd(12)} ${'OI'.padEnd(12)} 24h Vol`)
        lines.push('─'.repeat(62))

        for (const e of top) {
          const fundStr = `${(e.funding * 100).toFixed(4)}%`
          const oiStr = `$${(e.oi * e.markPx / 1e6).toFixed(1)}M`
          const volStr = `$${(e.vol / 1e6).toFixed(1)}M`
          lines.push(`${e.name.padEnd(10)} ${'$' + e.markPx.toLocaleString().padEnd(13)} ${fundStr.padEnd(12)} ${oiStr.padEnd(12)} ${volStr}`)
        }

        lines.push(`\nTotal markets: ${meta.universe.length}`)
        return text(lines.join('\n'))
      } catch (e) {
        return err(`Failed to fetch markets: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'leverage': {
      if (!args.market || !args.leverage) return err('Missing market or leverage')
      const w = getOrCreateWallet()
      const market = (args.market as string).toUpperCase()
      const leverage = args.leverage as number
      const marginMode = (args.marginMode as string) || 'cross'

      if (leverage < 1 || leverage > 50) return err('Leverage must be between 1 and 50.')

      const status = await getHyperliquidSetupStatus()
      const blocker = getHyperliquidSetupBlocker('leverage', status)
      if (blocker) return text(formatHyperliquidSetupGuide(status, blocker))

      if (wantsLiveExecution(args)) {
        try {
          const meta = await getHlMeta()
          const assetIdx = resolveAssetIndex(meta.universe, market)
          const { exchange } = getHlExchangeClient()
          const live = await exchange.updateLeverage({ asset: assetIdx, isCross: marginMode === 'cross', leverage })
          return text(
            `Leverage Updated\n\n` +
            `Market: ${market}-PERP\n` +
            `Leverage: ${leverage}x\n` +
            `Margin Mode: ${marginMode}\n\n` +
            JSON.stringify(live, null, 2)
          )
        } catch (e) {
          return err(`Leverage update failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      return text(
        `Hyperliquid Leverage Preview\n\n` +
        `Market: ${market}-PERP\n` +
        `Leverage: ${leverage}x\n` +
        `Margin Mode: ${marginMode}\n` +
        `Wallet: ${w.name} (${w.address})\n\n` +
        `No live leverage update was sent.\n` +
        `Add execute=true to update leverage live.`
      )
    }

    case 'funding': {
      const w = getActiveWallet()
      if (!w) return text('No wallet. Create one first to view funding history.')
      const market = args.market as string | undefined

      try {
        const data = await hlPost(HL_INFO_URL, { type: 'userFunding', user: w.address, startTime: Date.now() - 7 * 24 * 60 * 60 * 1000 }) as {
          time: number; coin: string; usdc: string; szi: string; fundingRate: string
        }[]

        let entries = data || []
        if (market) entries = entries.filter((e) => e.coin.toLowerCase() === market.toLowerCase())

        if (!entries.length) return text(`No funding payments found${market ? ` for ${market}` : ''} in the last 7 days.`)

        const lines: string[] = [`💰 Funding History (last 7 days)${market ? ` — ${market.toUpperCase()}` : ''}:\n`]
        lines.push(`${'Time'.padEnd(18)} ${'Market'.padEnd(8)} ${'Payment'.padEnd(14)} Rate`)
        lines.push('─'.repeat(50))

        for (const e of entries.slice(-20)) {
          const time = new Date(e.time).toISOString().slice(0, 16).replace('T', ' ')
          const payment = parseFloat(e.usdc)
          const rate = parseFloat(e.fundingRate)
          lines.push(`${time.padEnd(18)} ${e.coin.padEnd(8)} ${(payment >= 0 ? '+' : '') + '$' + payment.toFixed(4).padEnd(13)} ${(rate * 100).toFixed(4)}%`)
        }

        const total = entries.reduce((sum, e) => sum + parseFloat(e.usdc), 0)
        lines.push(`\nTotal: ${total >= 0 ? '+' : ''}$${total.toFixed(4)}`)

        return text(lines.join('\n'))
      } catch (e) {
        return err(`Failed to fetch funding history: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    case 'fund': {
      if (args.amount === undefined) return err('Missing amount')
      const w = getOrCreateWallet()
      const amount = args.amount as number
      const source = (args.source as string || 'arbitrum').toLowerCase()

      return text(
        `Fund Hyperliquid\n\n` +
        `Amount: ${amount} USDC\n` +
        `Starting point: ${source}\n` +
        `Wallet: ${w.name} (${w.address})\n\n` +
        `Where the money lands:\n` +
        `  It lands in Hyperliquid USDC (Perps), which is the balance used for perp margin.\n` +
        `  It does not land in the spot account.\n\n` +
        `Best route:\n` +
        `  Use Relay when it gives the best safe quote into Hyperliquid USDC (Perps).\n` +
        `  Use Jumper or LI.FI only when Relay is unavailable or worse.\n` +
        `  I block routes with high value loss before approval or transaction.\n\n` +
        `Fallback route:\n` +
        `  Send USDC on Arbitrum through the official Hyperliquid deposit flow.\n` +
        `  Keep a little ETH on Arbitrum for the deposit gas.\n\n` +
        `After deposit:\n` +
        `  Ask me: "Check my Hyperliquid account".\n\n` +
        `Gas note:\n` +
        `  Funding uses source-chain gas. Trading on Hyperliquid itself does not use wallet gas.`
      )
    }

    case 'withdraw': {
      if (args.amount === undefined) return err('Missing amount')
      const w = getOrCreateWallet()
      const amount = args.amount as number
      const destination = ((args.destination || args.toAddress) as string | undefined) || w.address
      const preview =
        `Withdraw from Hyperliquid\n\n` +
        `Amount: ${amount} USDC\n` +
        `From: Hyperliquid USDC (Perps)\n` +
        `To: USDC on Arbitrum\n` +
        `Recipient: ${destination}\n\n` +
        `Hyperliquid charges the withdrawal gas fee in USDC on L1. You do not need Arbitrum ETH for the receiving side.\n` +
        `No live withdrawal was sent.`

      if (!wantsLiveExecution(args)) {
        return text(preview + '\n\nAdd execute=true only when the address and amount look right.')
      }

      try {
        const { exchange } = getHlExchangeClient()
        const live = await exchange.withdraw3({ destination: destination as `0x${string}`, amount: String(amount) })
        return text(preview + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid withdrawal submitted', live))
      } catch (e) {
        return err(`Withdrawal failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ── Bracket Order (entry + SL + TP) ────────────────
    case 'bracket': {
      let market: string, side: 'buy' | 'sell', size: number, price: number, sl: number | undefined, tp: number | undefined, lev: number
      let entryPriceProvided = false

      if (args.prompt) {
        const p = (args.prompt as string).toLowerCase()
        side = p.includes('short') || p.includes('sell') ? 'sell' : 'buy'
        const coins = ['btc','eth','sol','bnb','arb','doge','pepe','xrp','ada','avax','matic','link','op','sui','apt']
        market = (coins.find(c => p.includes(c)) || 'btc').toUpperCase()
        const levMatch = p.match(/(\d+)x/)
        lev = levMatch ? parseInt(levMatch[1]) : 1
        const withoutLev = p.replace(/\d+x/g, '')
        const nums = withoutLev.match(/[\d]+\.?[\d]*k?/g)?.map(n => n.endsWith('k') ? parseFloat(n) * 1000 : parseFloat(n)) || []
        price = nums[0] || 0
        entryPriceProvided = nums.length > 0
        sl = nums[1]
        tp = nums[2]
        size = (args.size as number) || 0.01
      } else {
        if (!args.market || !args.side) return err('Need market+side or use prompt')
        market = (args.market as string).toUpperCase()
        side = args.side as 'buy' | 'sell'
        size = (args.size as number) || 0.01
        price = (args.price as number) || 0
        entryPriceProvided = args.price !== undefined
        sl = args.stopLoss as number | undefined
        tp = args.takeProfit as number | undefined
        lev = (args.leverage as number) || 1
      }
      if (side !== 'buy' && side !== 'sell') return err('side must be buy or sell')
      if (lev < 1 || lev > 50) return err('Leverage must be between 1 and 50.')

      const status = await getHyperliquidSetupStatus()
      const blocker = getHyperliquidSetupBlocker('bracket', status)
      if (blocker) return text(formatHyperliquidSetupGuide(status, blocker))

      const meta = await getHlMeta()
      const ai = resolveAssetIndex(meta.universe, market)
      const mark = parseFloat(meta.assetCtxs[ai].markPx)
      if (!price) price = mark
      const notional = size * price
      const margin = notional / lev
      const fee = notional * 0.00035
      const liqPx = side === 'buy' ? price * (1 - 1/lev * 0.9) : price * (1 + 1/lev * 0.9)
      const slLoss = sl ? Math.abs(price - sl) * size : 0
      const tpGain = tp ? Math.abs(tp - price) * size : 0
      const rr = slLoss > 0 && tpGain > 0 ? (tpGain / slLoss).toFixed(1) : 'N/A'
      const w = getOrCreateWallet()
      const preview =
        `Bracket Order - ${market}-PERP\n\n` +
        `${side === 'buy' ? 'LONG' : 'SHORT'} ${size} ${market} ${entryPriceProvided ? `limit @ $${price.toLocaleString()}` : `market around $${mark.toLocaleString()}`}\n` +
        `Leverage: ${lev}x | Margin: $${margin.toFixed(2)}\n` +
        (sl ? `Stop Loss: $${sl.toLocaleString()} (loss: -$${slLoss.toFixed(2)})\n` : '') +
        (tp ? `Take Profit: $${tp.toLocaleString()} (gain: +$${tpGain.toFixed(2)})\n` : '') +
        `Risk/Reward: ${rr}\n` +
        `Est. Liq: $${liqPx.toFixed(2)} | Fee: $${fee.toFixed(2)}\n\n` +
        `Wallet: ${w.name} (${w.address})\n` +
        `Mark: $${mark.toLocaleString()}`

      if (!wantsLiveExecution(args)) {
        return text(preview + '\n\nPreview only. Add execute=true to place the entry plus attached protection orders.')
      }

      try {
        const { exchange } = getHlExchangeClient()
        const sideIsBuy = side === 'buy'
        const slippage = ((args.slippage as number | undefined) ?? 0.5) / 100
        const entryPx = entryPriceProvided ? price : (sideIsBuy ? mark * (1 + slippage) : mark * (1 - slippage))
        const entryLive = await exchange.order({
          orders: [{
            a: ai,
            b: sideIsBuy,
            p: wirePrice(entryPx),
            s: wireSize(size),
            r: false,
            t: { limit: { tif: entryPriceProvided ? 'Gtc' as const : 'FrontendMarket' as const } },
          }],
          grouping: 'na',
        })

        const protectionOrders = [] as { a: number; b: boolean; p: string; s: string; r: boolean; t: { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'sl' | 'tp' } } }[]
        const closeSideIsBuy = side !== 'buy'
        if (sl) protectionOrders.push({ a: ai, b: closeSideIsBuy, p: wirePrice(sl), s: wireSize(size), r: true, t: { trigger: { isMarket: true, triggerPx: wirePrice(sl), tpsl: 'sl' } } })
        if (tp) protectionOrders.push({ a: ai, b: closeSideIsBuy, p: wirePrice(tp), s: wireSize(size), r: true, t: { trigger: { isMarket: true, triggerPx: wirePrice(tp), tpsl: 'tp' } } })
        const protectionLive = protectionOrders.length
          ? await exchange.order({ orders: protectionOrders, grouping: 'normalTpsl' })
          : null

        return text(preview + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid bracket submitted', { entry: entryLive, protection: protectionLive }))
      } catch (e) {
        return err(`Bracket failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ── Close Position ───────────────────────────────
    case 'close': {
      if (!args.market) return err('Need market')
      const w = getActiveWallet()
      if (!w) return err('No wallet')
      const market = (args.market as string).toUpperCase()
      const pct = Math.max(1, Math.min(100, (args.percent as number) || 100))
      const data = await hlPost(HL_INFO_URL, { type: 'clearinghouseState', user: w.address }) as any
      const pos = data.assetPositions?.find((p: any) => p.position.coin === market && parseFloat(p.position.szi) !== 0)
      if (!pos) return err(`No open ${market} position`)
      const sz = parseFloat(pos.position.szi)
      const closeSize = Math.abs(sz) * (pct / 100)
      const side = sz > 0 ? 'SELL' : 'BUY'
      const sideIsBuy = sz < 0
      const meta = await getHlMeta()
      const ai = resolveAssetIndex(meta.universe, market)
      const mark = parseFloat(meta.assetCtxs[ai].markPx)
      const upnl = parseFloat(pos.position.unrealizedPnl)
      const slippage = ((args.slippage as number | undefined) ?? 0.5) / 100
      const orderPrice = sideIsBuy ? mark * (1 + slippage) : mark * (1 - slippage)
      const preview =
        `Close ${pct}% of ${market}-PERP\n\n` +
        `Current: ${sz > 0 ? 'LONG' : 'SHORT'} ${Math.abs(sz)} @ $${parseFloat(pos.position.entryPx).toFixed(2)}\n` +
        `Closing: ${side} ${closeSize.toFixed(4)} ${market} @ ~$${mark.toFixed(2)}\n` +
        `Reduce only: yes\n` +
        `Unrealized PnL: ${upnl >= 0 ? '+' : ''}$${upnl.toFixed(2)}\n\n` +
        `Wallet: ${w.name}`

      if (!wantsLiveExecution(args)) {
        return text(preview + '\n\nPreview only. Add execute=true to close the live position.')
      }

      try {
        const { exchange } = getHlExchangeClient()
        const live = await exchange.order({
          orders: [{
            a: ai,
            b: sideIsBuy,
            p: wirePrice(orderPrice),
            s: wireSize(closeSize),
            r: true,
            t: { limit: { tif: 'FrontendMarket' as const } },
          }],
          grouping: 'na',
        })
        return text(preview + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid close submitted', live))
      } catch (e) {
        return err(`Close failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ── Trailing Stop ────────────────────────────────
    case 'trailing_stop': {
      if (!args.market || !args.trailPercent) return err('Need market and trailPercent')
      const market = (args.market as string).toUpperCase()
      const trail = args.trailPercent as number
      const w = getActiveWallet()
      if (!w) return err('No wallet')
      const data = await hlPost(HL_INFO_URL, { type: 'clearinghouseState', user: w.address }) as any
      const pos = data.assetPositions?.find((p: any) => p.position.coin === market)
      if (!pos) return err(`No open ${market} position`)
      const sz = parseFloat(pos.position.szi)
      const meta = await getHlMeta()
      const ai = resolveAssetIndex(meta.universe, market)
      const mark = parseFloat(meta.assetCtxs[ai].markPx)
      const triggerPx = sz > 0 ? mark * (1 - trail / 100) : mark * (1 + trail / 100)
      return text(
        `📋 Trailing Stop — ${market}-PERP\n\n` +
        `Position: ${sz > 0 ? 'LONG' : 'SHORT'} ${Math.abs(sz)}\n` +
        `Mark: $${mark.toFixed(2)}\n` +
        `Trail: ${trail}%\n` +
        `Current Trigger: $${triggerPx.toFixed(2)}\n\n` +
        `The stop follows price ${sz > 0 ? 'up' : 'down'} and triggers if price reverses ${trail}%.\n` +
        `Use automations tool to set a price alert at $${triggerPx.toFixed(2)} on ${market}.`
      )
    }

    // ── Copy Trading ─────────────────────────────────
    case 'copy_trade': {
      if (!args.trader) return err('Provide trader wallet address')
      const addr = args.trader as string
      const maxPer = (args.maxPerTrade as number) || 50
      const fills = await hlPost(HL_INFO_URL, { type: 'userFills', user: addr }) as any[]
      if (!fills?.length) return text(`No recent trades found for ${addr.slice(0, 10)}...`)
      const recent = fills.slice(-20)
      const posMap = new Map<string, { side: string; avgPx: number; totalSz: number; count: number }>()
      for (const f of recent) {
        const key = f.coin || 'unknown'
        const existing = posMap.get(key)
        if (existing) { existing.totalSz += parseFloat(f.sz || '0'); existing.count++ }
        else posMap.set(key, { side: f.side || 'Buy', avgPx: parseFloat(f.px || '0'), totalSz: parseFloat(f.sz || '0'), count: 1 })
      }
      const lines: string[] = [`🔄 Copy Trade — ${addr.slice(0, 10)}...\n`, `Last ${recent.length} fills:\n`]
      for (const [coin, p] of posMap) {
        const usd = p.totalSz * p.avgPx
        const mySize = Math.min(maxPer, usd) / p.avgPx
        lines.push(`  ${p.side === 'Buy' || p.side === 'B' ? '🟢' : '🔴'} ${coin}: ${p.side} ${p.totalSz.toFixed(4)} @ $${p.avgPx.toFixed(2)} ($${usd.toFixed(0)}) × ${p.count} fills`)
        lines.push(`    → Copy: ${p.side} ${mySize.toFixed(4)} ${coin} ($${Math.min(maxPer, usd).toFixed(0)} capped)`)
      }
      lines.push(`\nMax per trade: $${maxPer}`)
      lines.push(`\n💡 To execute, run: hyperliquid order market=<COIN> side=<buy/sell> size=<SIZE> for each trade above.`)
      return text(lines.join('\n'))
    }

    // ── DCA ──────────────────────────────────────────
    case 'dca': {
      if (!args.market || !args.side || !args.amount) return err('Need market, side, amount')
      const market = (args.market as string).toUpperCase()
      const side = args.side as string
      const totalAmt = args.amount as number
      const rounds = (args.rounds as number) || 5
      const interval = (args.interval as string) || '4h'
      const lev = (args.leverage as number) || 1
      const perRound = totalAmt / rounds
      const meta = await getHlMeta()
      const ai = resolveAssetIndex(meta.universe, market)
      const mark = parseFloat(meta.assetCtxs[ai].markPx)
      const sizePerRound = perRound / mark
      const lines: string[] = [
        `📋 DCA Plan — ${market}-PERP\n`,
        `${side === 'buy' ? '🟢 LONG' : '🔴 SHORT'} $${totalAmt} over ${rounds} rounds`,
        `Interval: every ${interval}`,
        `Leverage: ${lev}x\n`,
        `Per Round:`,
        `  Amount: $${perRound.toFixed(2)}`,
        `  Size: ~${sizePerRound.toFixed(4)} ${market} @ $${mark.toFixed(2)}`,
        `  Margin: $${(perRound / lev).toFixed(2)}\n`,
        `Schedule:`,
      ]
      for (let i = 0; i < rounds; i++) {
        lines.push(`  Round ${i + 1}: ${side.toUpperCase()} ~${sizePerRound.toFixed(4)} ${market}`)
      }
      lines.push(`\nTotal: ${rounds} × $${perRound.toFixed(2)} = $${totalAmt.toFixed(2)}`)
      lines.push(`\n💡 Use automations tool to create a DCA: create_dca tokenIn=USDC tokenOut=${market} amount=${perRound} interval=${interval} maxRuns=${rounds}`)
      return text(lines.join('\n'))
    }

    // ── P&L ──────────────────────────────────────────
    case 'pnl': {
      const w = getActiveWallet()
      if (!w) return err('No wallet')
      const data = await hlPost(HL_INFO_URL, { type: 'clearinghouseState', user: w.address }) as any
      const meta = await getHlMeta()
      const positions = data.assetPositions?.filter((p: any) => parseFloat(p.position.szi) !== 0) || []
      if (!positions.length) return text('No open positions.')
      let totalUpnl = 0, totalMargin = 0
      const lines: string[] = ['📊 P&L Breakdown\n']
      for (const { position: p } of positions) {
        const sz = parseFloat(p.szi)
        const entry = parseFloat(p.entryPx)
        const ai = meta.universe.findIndex((u: any) => u.name === p.coin)
        const mark = ai >= 0 ? parseFloat(meta.assetCtxs[ai].markPx) : entry
        const upnl = parseFloat(p.unrealizedPnl)
        const pctChange = entry > 0 ? ((mark - entry) / entry * 100 * (sz > 0 ? 1 : -1)).toFixed(2) : '0'
        const posVal = Math.abs(sz) * mark
        const lev = p.leverage?.value || 1
        const margin = posVal / lev
        totalUpnl += upnl; totalMargin += margin
        const icon = upnl >= 0 ? '🟢' : '🔴'
        lines.push(`${icon} ${p.coin}-PERP`)
        lines.push(`  ${sz > 0 ? 'LONG' : 'SHORT'} ${Math.abs(sz)} @ $${entry.toFixed(2)} → $${mark.toFixed(2)}`)
        lines.push(`  PnL: ${upnl >= 0 ? '+' : ''}$${upnl.toFixed(2)} (${pctChange}%) | ${lev}x | Margin: $${margin.toFixed(2)}`)
        if (p.liquidationPx) lines.push(`  Liq: $${parseFloat(p.liquidationPx).toFixed(2)}`)
        lines.push('')
      }
      const acctVal = parseFloat(data.marginSummary.accountValue)
      lines.push(`─`.repeat(40))
      lines.push(`Total uPnL: ${totalUpnl >= 0 ? '+' : ''}$${totalUpnl.toFixed(2)}`)
      lines.push(`Account: $${acctVal.toFixed(2)} | Margin: $${totalMargin.toFixed(2)} | Free: $${(acctVal - totalMargin).toFixed(2)}`)
      return text(lines.join('\n'))
    }

    // ── Risk Calculator ──────────────────────────────
    case 'risk': {
      if (!args.market || !args.side || !args.size) return err('Need market, side, size')
      const market = (args.market as string).toUpperCase()
      const side = args.side as string
      const size = args.size as number
      const lev = (args.leverage as number) || 1
      const meta = await getHlMeta()
      const ai = resolveAssetIndex(meta.universe, market)
      const mark = parseFloat(meta.assetCtxs[ai].markPx)
      const entry = (args.price as number) || mark
      const notional = size * entry
      const margin = notional / lev
      const fee = notional * 0.00035
      const liqPx = side === 'buy' ? entry * (1 - 1/lev * 0.9) : entry * (1 + 1/lev * 0.9)
      const liqDist = Math.abs(entry - liqPx)
      const liqPct = (liqDist / entry * 100).toFixed(2)
      const maxLoss = margin + fee
      const sl = args.stopLoss as number | undefined
      const tp = args.takeProfit as number | undefined
      const lines: string[] = [
        `⚠️ Risk Calculator — ${market}-PERP\n`,
        `${side === 'buy' ? '🟢 LONG' : '🔴 SHORT'} ${size} ${market} @ $${entry.toLocaleString()}`,
        `Leverage: ${lev}x\n`,
        `Notional: $${notional.toFixed(2)}`,
        `Margin Required: $${margin.toFixed(2)}`,
        `Fee (0.035%): $${fee.toFixed(2)}`,
        `\nLiquidation: $${liqPx.toFixed(2)} (${liqPct}% away)`,
        `Max Loss (to liq): $${maxLoss.toFixed(2)}`,
      ]
      if (sl) {
        const slLoss = Math.abs(entry - sl) * size
        lines.push(`\nStop Loss: $${sl} → loss: -$${slLoss.toFixed(2)}`)
      }
      if (tp) {
        const tpGain = Math.abs(tp - entry) * size
        lines.push(`Take Profit: $${tp} → gain: +$${tpGain.toFixed(2)}`)
      }
      if (sl && tp) {
        const rr = (Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2)
        lines.push(`Risk/Reward: 1:${rr}`)
      }
      // Position sizing suggestion
      const w = getActiveWallet()
      if (w) {
        try {
          const acct = await hlPost(HL_INFO_URL, { type: 'clearinghouseState', user: w.address }) as any
          const free = parseFloat(acct.marginSummary.accountValue) - parseFloat(acct.marginSummary.totalMarginUsed)
          const pctOfAcct = (margin / free * 100).toFixed(1)
          lines.push(`\nAccount Free Margin: $${free.toFixed(2)}`)
          lines.push(`This trade uses ${pctOfAcct}% of free margin`)
          if (parseFloat(pctOfAcct) > 50) lines.push(`⚠️ HIGH RISK: >50% of margin on one trade`)
        } catch { /* ok */ }
      }
      return text(lines.join('\n'))
    }

    // ── Scanner (funding, volume, momentum) ──────────
    case 'scanner': {
      const sortBy = (args.sortBy as string) || 'funding'
      const limit = (args.limit as number) || 10
      const meta = await getHlMeta()
      const entries = meta.universe.map((u, i) => ({
        name: u.name,
        funding: parseFloat(meta.assetCtxs[i].funding),
        mark: parseFloat(meta.assetCtxs[i].markPx),
        oi: parseFloat(meta.assetCtxs[i].openInterest),
        vol: parseFloat(meta.assetCtxs[i].dayNtlVlm || '0'),
      }))
      let sorted: typeof entries
      let title: string
      if (sortBy === 'funding') {
        sorted = entries.sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding)).slice(0, limit)
        title = '💰 Extreme Funding Rates'
      } else if (sortBy === 'volume') {
        sorted = entries.sort((a, b) => b.vol - a.vol).slice(0, limit)
        title = '📈 Highest Volume'
      } else {
        sorted = entries.sort((a, b) => (b.oi * b.mark) - (a.oi * a.mark)).slice(0, limit)
        title = '🏦 Highest Open Interest'
      }
      const lines: string[] = [`🔍 Scanner: ${title}\n`]
      for (const e of sorted) {
        const fSign = e.funding >= 0 ? '+' : ''
        const fPct = `${fSign}${(e.funding * 100).toFixed(4)}%/h`
        const fAnnual = `${fSign}${(e.funding * 100 * 8760).toFixed(1)}%/yr`
        const signal = Math.abs(e.funding) > 0.005 ? (e.funding > 0 ? '🔴 SHORT bias' : '🟢 LONG bias') : '⚪ neutral'
        lines.push(`${e.name.padEnd(8)} $${e.mark.toLocaleString().padEnd(12)} F:${fPct.padEnd(12)} ${fAnnual.padEnd(12)} ${signal}`)
      }
      lines.push(`\n💡 Extreme funding = crowded trade. Consider fading (opposite direction).`)
      lines.push(`Markets with >0.01%/h funding are paying ${(0.01 * 8760).toFixed(0)}%+ APR to the other side.`)
      return text(lines.join('\n'))
    }

    case 'spot': {
      const info = getHlInfoClient()
      const [spotMeta, spotCtxs] = await info.spotMetaAndAssetCtxs() as any
      const pairInput = ((args.market as string | undefined) || (args.token as string | undefined) || '').toUpperCase()
      const pair = pairInput ? (pairInput.includes('/') ? pairInput : `${pairInput}/USDC`) : ''

      if (args.side) {
        if (!pair) return err('Need a spot market, like PURR or HYPE/USDC')
        const side = args.side as 'buy' | 'sell'
        if (side !== 'buy' && side !== 'sell') return err('side must be buy or sell')
        const converter = await getHlSymbolConverter()
        const assetId = converter.getAssetId(pair)
        const pairId = converter.getSpotPairId(pair) || pair
        if (assetId === undefined) return err(`Spot market ${pair} was not found on Hyperliquid.`)
        const ctx = spotCtxs.find((c: any) => c.coin === pairId || c.coin === pair)
        if (!ctx) return err(`No live quote found for ${pair}.`)
        const mark = parseFloat(ctx.markPx || ctx.midPx || '0')
        if (!Number.isFinite(mark) || mark <= 0) return err(`No usable mark price for ${pair}.`)
        const amount = args.amount as number | undefined
        const size = (args.size as number | undefined) ?? (amount !== undefined ? amount / mark : undefined)
        if (!size || size <= 0) return err('Need size or amount for a spot order.')
        const limitPrice = args.price as number | undefined
        const slippage = ((args.slippage as number | undefined) ?? 0.5) / 100
        const orderPrice = limitPrice ?? (side === 'buy' ? mark * (1 + slippage) : mark * (1 - slippage))
        const preview =
          `Hyperliquid Spot ${side.toUpperCase()} Preview\n\n` +
          `Market: ${pair}\n` +
          `Size: ${size.toFixed(6)} | Notional: ~$${(size * mark).toFixed(2)}\n` +
          `Type: ${limitPrice ? `Limit @ $${limitPrice}` : `Market around $${mark}`}\n\n` +
          `No live order was placed.`

        if (!wantsLiveExecution(args)) return text(preview + '\nAdd execute=true to place it live.')

        const { exchange } = getHlExchangeClient()
        const live = await exchange.order({
          orders: [{
            a: assetId,
            b: side === 'buy',
            p: wirePrice(orderPrice),
            s: wireSize(size),
            r: false,
            t: { limit: { tif: limitPrice ? 'Gtc' as const : 'FrontendMarket' as const } },
          }],
          grouping: 'na',
        })
        return text(preview + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid spot order submitted', live))
      }

      const tokenByIndex = new Map<number, any>((spotMeta.tokens || []).map((t: any) => [t.index, t]))
      const universeByName = new Map<string, any>((spotMeta.universe || []).map((u: any) => [u.name, u]))
      const entries = spotCtxs.map((ctx: any) => {
        const universeEntry = universeByName.get(ctx.coin)
        const displayPair = universeEntry?.tokens
          ? `${tokenByIndex.get(universeEntry.tokens[0])?.name || ctx.coin}/${tokenByIndex.get(universeEntry.tokens[1])?.name || 'USDC'}`
          : ctx.coin
        return {
        coin: displayPair,
        mark: parseFloat(ctx.markPx || ctx.midPx || '0'),
        volume: parseFloat(ctx.dayNtlVlm || '0'),
        baseVolume: parseFloat(ctx.dayBaseVlm || '0'),
        isCanonical: universeEntry?.isCanonical === true,
        }
      }).filter((e: any) => e.mark > 0)
      entries.sort((a: any, b: any) => b.volume - a.volume)
      const limit = (args.limit as number) || 12
      const lines = [`Hyperliquid Spot Markets (top ${limit} by 24h volume)`, '']
      lines.push(`${'Market'.padEnd(16)} ${'Mark'.padEnd(14)} ${'24h Volume'.padEnd(14)} Canonical`)
      lines.push('-'.repeat(62))
      for (const e of entries.slice(0, limit)) {
        lines.push(`${String(e.coin).padEnd(16)} ${('$' + e.mark.toLocaleString('en-US')).padEnd(14)} ${('$' + (e.volume / 1e6).toFixed(2) + 'M').padEnd(14)} ${e.isCanonical ? 'yes' : 'no'}`)
      }

      const w = getActiveWallet()
      if (w) {
        try {
          const state = await info.spotClearinghouseState({ user: w.address }) as any
          const balances = (state.balances || []).filter((b: any) => parseFloat(b.total || '0') > 0).slice(0, 8)
          if (balances.length) {
            lines.push('', `Spot balances for ${w.name}:`)
            for (const b of balances) lines.push(`  ${b.coin}: ${parseFloat(b.total).toFixed(6)} available, ${parseFloat(b.hold || '0').toFixed(6)} on hold`)
          }
        } catch { /* balances are optional */ }
      }
      lines.push('', 'To trade simply ask: "Buy $10 of PURR spot on Hyperliquid". Live orders still require execute=true.')
      return text(lines.join('\n'))
    }

    case 'earn': {
      const info = getHlInfoClient()
      const reserves = await info.allBorrowLendReserveStates() as any
      const [spotMeta] = await info.spotMetaAndAssetCtxs() as any
      const tokenByIndex = new Map<number, any>((spotMeta.tokens || []).map((t: any) => [t.index, t]))

      const operation = args.operation as 'supply' | 'withdraw' | 'repay' | 'borrow' | undefined
      if (operation) {
        if (!['supply', 'withdraw', 'repay', 'borrow'].includes(operation)) return err('Earn operation must be supply, withdraw, repay, or borrow.')
        const tokenInput = (args.token as string | undefined) || 'USDC'
        const tokenId = /^\d+$/.test(tokenInput) ? parseInt(tokenInput) : (spotMeta.tokens || []).find((t: any) => String(t.name).toUpperCase() === tokenInput.toUpperCase())?.index
        if (tokenId === undefined) return err(`Token ${tokenInput} was not found in Hyperliquid earn reserves.`)
        const amount = args.amount as number | undefined
        const preview = `Hyperliquid Earn ${operation.toUpperCase()} Preview\n\nToken: ${tokenInput.toUpperCase()} (#${tokenId})\nAmount: ${amount ?? 'full / max'}\n\nNo live earn action was placed.`
        if (!wantsLiveExecution(args)) return text(preview + '\nAdd execute=true to submit it live.')
        const { exchange } = getHlExchangeClient()
        const live = await exchange.borrowLend({ operation, token: tokenId, amount: amount === undefined ? null : String(amount) })
        return text(preview + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid earn action submitted', live))
      }

      const rows = reserves.map(([tokenId, state]: [number, any]) => ({ tokenId, token: tokenByIndex.get(tokenId)?.name || `#${tokenId}`, ...state }))
      rows.sort((a: any, b: any) => parseFloat(b.supplyYearlyRate || '0') - parseFloat(a.supplyYearlyRate || '0'))
      const lines = ['Hyperliquid Earn / Borrow-Lend Reserves', '']
      lines.push(`${'Token'.padEnd(10)} ${'Supply APR'.padEnd(12)} ${'Borrow APR'.padEnd(12)} ${'Util'.padEnd(10)} Supplied`)
      lines.push('-'.repeat(66))
      for (const r of rows.slice(0, (args.limit as number) || 10)) {
        const supplyApr = `${(parseFloat(r.supplyYearlyRate || '0') * 100).toFixed(2)}%`
        const borrowApr = `${(parseFloat(r.borrowYearlyRate || '0') * 100).toFixed(2)}%`
        const utilization = `${(parseFloat(r.utilization || '0') * 100).toFixed(1)}%`
        lines.push(`${String(r.token).padEnd(10)} ${supplyApr.padEnd(12)} ${borrowApr.padEnd(12)} ${utilization.padEnd(10)} $${parseFloat(r.totalSupplied || '0').toLocaleString('en-US')}`)
      }
      lines.push('', 'Supply/withdraw/borrow/repay actions are supported with execute=true after preview.')
      return text(lines.join('\n'))
    }

    case 'vaults': {
      const info = getHlInfoClient()
      const operation = args.operation as string | undefined
      if (operation && args.vaultAddress && args.amount !== undefined) {
        const isDeposit = operation !== 'withdraw'
        const preview = `Hyperliquid Vault ${isDeposit ? 'Deposit' : 'Withdraw'} Preview\n\nVault: ${args.vaultAddress}\nAmount: $${args.amount}\n\nNo live vault transfer was placed.`
        if (!wantsLiveExecution(args)) return text(preview + '\nAdd execute=true to submit it live.')
        const { exchange } = getHlExchangeClient()
        const live = await exchange.vaultTransfer({ vaultAddress: args.vaultAddress as `0x${string}`, isDeposit, usd: Math.round((args.amount as number) * 1e6) })
        return text(preview + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid vault transfer submitted', live))
      }

      const vaults = await info.vaultSummaries() as any
      const lines = ['Hyperliquid Vaults', '']
      if (!vaults.length) {
        lines.push('The public vault summary endpoint returned no active vaults right now.')
      } else {
        const sorted = [...vaults].sort((a: any, b: any) => parseFloat(b.tvl || b.totalDeposited || '0') - parseFloat(a.tvl || a.totalDeposited || '0'))
        lines.push(`${'Vault'.padEnd(24)} ${'TVL'.padEnd(14)} ${'APR/PNL'.padEnd(12)} Address`)
        lines.push('-'.repeat(86))
        for (const v of sorted.slice(0, (args.limit as number) || 10)) {
          const name = String(v.name || v.leader || 'Vault').slice(0, 23)
          const tvl = parseFloat(v.tvl || v.totalDeposited || '0')
          const apr = v.apr || v.roi || v.pnl || 'n/a'
          lines.push(`${name.padEnd(24)} ${('$' + tvl.toLocaleString('en-US')).padEnd(14)} ${String(apr).padEnd(12)} ${v.vaultAddress || v.address || 'n/a'}`)
        }
      }
      const w = getActiveWallet()
      if (w) {
        try {
          const equities = await info.userVaultEquities({ user: w.address }) as any
          if (equities.length) lines.push('', `Your vault equities: ${JSON.stringify(equities.slice(0, 5), null, 2)}`)
        } catch { /* optional */ }
      }
      lines.push('', 'Vault deposits and withdrawals are supported with vaultAddress, amount, operation=deposit/withdraw, and execute=true.')
      return text(lines.join('\n'))
    }

    case 'staking': {
      const info = getHlInfoClient()
      const operation = args.operation as 'delegate' | 'undelegate' | undefined
      if (operation && args.validator && args.amount !== undefined) {
        const preview = `Hyperliquid Staking ${operation.toUpperCase()} Preview\n\nValidator: ${args.validator}\nAmount: ${args.amount} HYPE\n\nNo live staking action was placed.`
        if (!wantsLiveExecution(args)) return text(preview + '\nAdd execute=true to submit it live.')
        const { exchange } = getHlExchangeClient()
        const live = await exchange.tokenDelegate({ validator: args.validator as `0x${string}`, isUndelegate: operation === 'undelegate', wei: Math.round((args.amount as number) * 1e8) })
        return text(preview + '\n\n' + formatLiveExchangeResponse('Live Hyperliquid staking action submitted', live))
      }

      const validators = await info.validatorSummaries() as any
      const active = validators.filter((v: any) => v.isActive && !v.isJailed).sort((a: any, b: any) => Number(BigInt(b.stake || 0) - BigInt(a.stake || 0)))
      const lines = ['Hyperliquid Staking Validators', '']
      lines.push(`${'Validator'.padEnd(22)} ${'APR'.padEnd(10)} ${'Commission'.padEnd(12)} Address`)
      lines.push('-'.repeat(86))
      for (const v of active.slice(0, (args.limit as number) || 10)) {
        const dayStats = (v.stats || []).find((s: any[]) => s[0] === 'day')?.[1] || {}
        const apr = `${(parseFloat(dayStats.predictedApr || '0') * 100).toFixed(2)}%`
        const commission = `${(parseFloat(v.commission || '0') * 100).toFixed(2)}%`
        lines.push(`${String(v.name || 'Validator').slice(0, 21).padEnd(22)} ${apr.padEnd(10)} ${commission.padEnd(12)} ${v.validator}`)
      }
      const w = getActiveWallet()
      if (w) {
        try {
          const delegations = await info.delegations({ user: w.address }) as any
          if (delegations.length) lines.push('', `Your delegations: ${JSON.stringify(delegations.slice(0, 5), null, 2)}`)
        } catch { /* optional */ }
      }
      lines.push('', 'Delegation and undelegation are supported with validator, amount, operation=delegate/undelegate, and execute=true.')
      return text(lines.join('\n'))
    }
    default: return err(`Unknown action: ${args.action}`)
  }
}

// ─── Module Export ────────────────────────────────────────

const hyperliquidModule: ToolModule = { tools: TOOLS, handle }
export default hyperliquidModule

