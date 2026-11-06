/** Tool calls use account access; checkout quotes handle subscription payments. */
export function getToolTier(_name: string): 'free' {
  return 'free'
}

export function getToolPrice(_name: string): string {
  return '0'
}
