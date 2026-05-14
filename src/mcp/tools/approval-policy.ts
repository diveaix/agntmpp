export interface ExactApprovalPlan {
  current: bigint
  required: bigint
  alreadyExact: boolean
  resetAmount: 0n | null
  approveAmount: bigint | null
}

export function planExactApproval(current: bigint, required: bigint): ExactApprovalPlan {
  if (required <= 0n) throw new Error('Approval amount must be greater than zero.')
  const alreadyExact = current === required
  return {
    current,
    required,
    alreadyExact,
    resetAmount: !alreadyExact && current > 0n ? 0n : null,
    approveAmount: alreadyExact ? null : required,
  }
}
