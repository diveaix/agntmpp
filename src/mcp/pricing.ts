/**
 * ./AGNT Protocol — Tool Pricing Registry
 * Maps every tool to a pricing tier: free, standard, or premium.
 */

import type { PricingTier } from './mpp.js'
import { PRICING } from './mpp.js'

const FREE_TOOLS = new Set([
  'create_wallet', 'list_wallets', 'switch_wallet', 'rename_wallet',
  'wallet_info', 'get_balance', 'list_tokens', 'discover_tokens',
  'tx_status', 'list_automations', 'automation_log', 'get_gas',
  // Analytics & data (read-only)
  'lido_positions', 'eigen_positions', 'ethena_positions',
  'morpho_positions', 'pendle_positions', 'pendle_markets', 'ondo_positions',
  'uniswap_quote', 'uniswap_pools', 'pancake_quote',
  'jumper_quote', 'jumper_routes', 'relay_quote', 'debridge_quote', 'debridge_status',
  'defillama_tvl', 'defillama_yields', 'defillama_protocol', 'defillama_stablecoins',
  'dune_query', 'dune_search',
  'polymarket_markets', 'polymarket_market',
  'hl_create_account',
  // Agent infrastructure (always free)
  'memory', 'telegram',
])

const PREMIUM_TOOLS = new Set([
  'bridge_tokens', 'hl_place_order', 'hl_cancel_order', 'hl_set_leverage',
  'aave_supply', 'aave_withdraw', 'stake_eth', 'swap_any_chain',
  'create_dca', 'create_alert', 'cancel_automation', 'create_strategy',
  'copy_trade', 'backtest_strategy', 'deploy_token', 'dao_vote',
  'agent_pay', 'revoke_approvals', 'set_spending_limit', 'emergency_stop',
  'get_whale_activity', 'hl_fund_account',
  // New protocol tools
  'lido_stake', 'lido_withdraw', 'eigen_deposit', 'eigen_withdraw',
  'ethena_mint', 'ethena_stake',
  'morpho_supply', 'morpho_withdraw', 'pendle_buy_pt', 'pendle_buy_yt',
  'ondo_mint', 'ondo_redeem',
  'uniswap_swap', 'uniswap_lp', 'pancake_swap',
  'jumper_swap', 'relay_bridge', 'debridge_bridge',
  'polymarket_trade', 'polymarket_create_account', 'polymarket_fund',
])

/** Get the pricing tier for a tool. All tools are free. */
export function getToolTier(_name: string): PricingTier {
  return 'free'
}

/** Get the charge amount for a tool. */
export function getToolPrice(_name: string): string {
  return '0'
}

/** Check if a tool is free. All tools are free. */
export function isFreeTool(_name: string): boolean {
  return true
}

/** Get all tool names in a tier. */
export function getToolsByTier(tier: PricingTier): string[] {
  if (tier === 'free') return [...FREE_TOOLS]
  if (tier === 'premium') return [...PREMIUM_TOOLS]
  return [] // standard = everything else
}

/** Full pricing table for the /pricing endpoint. */
export function getPricingTable(): Record<string, { tier: PricingTier; amount: string }> {
  // We build this dynamically from the ALL_TOOLS import to avoid circular deps
  return {} // populated at runtime by the serve endpoint
}
