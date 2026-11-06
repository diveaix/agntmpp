export function zecToZatoshi(input:string):string {
  const value=input.trim()
  if(!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(value))throw new Error('Enter a ZEC amount with at most 8 decimal places.')
  const [whole,fraction='']=value.split('.')
  const amount=BigInt(whole)*100000000n+BigInt(fraction.padEnd(8,'0'))
  if(amount>2100000000000000n)throw new Error('Amount exceeds the ZEC supply limit.')
  return String(amount)
}
