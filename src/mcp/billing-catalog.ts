import { getAccessEntitlement } from './access-store.js'

function formatPlan(name: 'free' | 'pro' | 'max', price: string): string {
  const entitlement = getAccessEntitlement(name)
  const label = name === 'free' ? 'Free' : name === 'pro' ? 'Pro' : 'Ultra'
  return [
    `${label}: ${price}`,
    `- Data automations: ${entitlement.dataAutomationSlots}`,
    `- Custom Twitter sources: ${entitlement.customSourceSlots}`,
    `- Auto-execute: ${entitlement.autoExecuteAllowed ? 'yes' : 'no'}`,
    `- Priority queue: ${entitlement.priorityQueue ? 'yes' : 'no'}`,
    `- Monthly event evaluations: ${entitlement.eventEvaluationsMonthly.toLocaleString()}`,
    `- Monthly executions: ${entitlement.executionsMonthly.toLocaleString()}`,
  ].join('\n')
}

export function formatBillingCatalog(): string {
  const proPrice = Number(process.env.CRYPTO_ACCESS_PRO_USDC || 49)
  const maxPrice = Number(process.env.CRYPTO_ACCESS_MAX_USDC || 199)
  const network = process.env.CRYPTO_ACCESS_NETWORK || 'tempo'
  const currency = process.env.AGNT_PAYMENT_CURRENCY || 'USDC.e'

  return [
    'AGNT Plans and Access',
    '',
    formatPlan('free', '$0'),
    '',
    formatPlan('pro', `$${proPrice}/month via MPP or crypto`),
    '',
    formatPlan('max', `$${maxPrice}/month via MPP or crypto`),
    '',
    'How to get access',
    'Free: create an AGNT account, then generate an API key or connector URL from the dashboard.',
    'Pro or Ultra: open the Plans page on the AGNT website: /plans',
    '1. Choose Pro or Ultra.',
    '2. Confirm your email and create an MPP/crypto payment quote.',
    '3. Pay the exact quoted amount.',
    '4. Paste the transaction hash on the page.',
    '5. After verification, your existing account receives the upgraded plan.',
    '',
    `Default payment path: MPP / crypto using ${currency} on ${network}.`,
    'Access activates only after payment verification. A transaction hash alone is not enough.',
    'Advanced MCP payment tools may exist for operators, but normal users should use the website checkout.',
  ].join('\n')
}
