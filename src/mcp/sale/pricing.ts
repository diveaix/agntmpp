import { createHash } from 'node:crypto'

export const SUPPLY = 4444
export const CURVE_VERSION = 'agnt-zec-4444-v1'
export class SaleError extends Error {
  constructor(public code: string, public status = 400) { super(code) }
}

// Round each exact rational term, never compound a previously rounded price.
const prices: bigint[] = []
const totals = [0n]
let numerator = 2_000_000n
let denominator = 1n
for (let i = 0; i < SUPPLY; i++) {
  const price = (numerator + denominator - 1n) / denominator
  prices.push(price)
  totals.push(totals[i] + price)
  numerator *= 2_501_111n
  denominator *= 2_500_000n
}
export const SCHEDULE_HASH = createHash('sha256').update(prices.join(',')).digest('hex')
export function totalPrice(sold: number, quantity: number): bigint {
  if (!Number.isInteger(sold) || sold < 0 || !Number.isInteger(quantity) || quantity < 1) throw new SaleError('invalid_quantity')
  if (sold + quantity > SUPPLY) throw new SaleError('sold_out', 409)
  return totals[sold + quantity] - totals[sold]
}
export function zatoshi(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new SaleError('invalid_atomic_amount')
  const amount = BigInt(value)
  if (amount > 2_100_000_000_000_000n) throw new SaleError('amount_out_of_range')
  return amount
}
export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) throw new SaleError('invalid_idempotency_key')
  return value
}
