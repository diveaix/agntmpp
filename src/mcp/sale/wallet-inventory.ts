import { SaleError } from './pricing.js'
import { canonicalTransactionEvidence, type ChainPolicy, type ZcashRpc } from './zcash-observer.js'

const pools=['transparent','sapling','orchard','ironwood'] as const
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new SaleError('invalid_wallet_inventory',503)
  return value as Record<string,unknown>
}
function zat(value:unknown):bigint{
  const amount=object(value).valueZat
  if(typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<0||amount>2100000000000000)throw new SaleError('invalid_wallet_inventory',503)
  return BigInt(amount)
}
function classifiedBalance(value:unknown){
  const row=object(value)
  // This pinned wallet does not implement `locked`; never infer zero from its
  // omission or silently accept a future, unreviewed accounting classification.
  if(Object.keys(row).some(key=>!['spendable','pending','dust'].includes(key)))throw new SaleError('invalid_wallet_inventory',503)
  return {spendable:zat(row.spendable),pending:row.pending===undefined?0n:zat(row.pending),dust:row.dust===undefined?0n:zat(row.dust)}
}

// Pinned Zallet v0.1.0-beta.3 z_getbalanceforaccount contract. This is a
// wallet-reported spendability observation, NOT proof of spending authority,
// pending-change ownership, customer coverage, or independently proven reserves.
export async function observeWalletInventory(wallet:ZcashRpc,node:ZcashRpc,policy:ChainPolicy,
  accountUuid:string,minimumConfirmations:number,nowSeconds?:number){
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(accountUuid)||
    !Number.isSafeInteger(minimumConfirmations)||minimumConfirmations<1||minimumConfirmations>2147483647)
    throw new SaleError('invalid_wallet_inventory_policy',503)
  const tip=object(await node('getblockchaininfo'))
  const block=object(await node('getblock',[tip.bestblockhash,1]))
  if(!Array.isArray(block.tx)||typeof block.tx[0]!=='string'||typeof tip.bestblockhash!=='string')throw new SaleError('invalid_wallet_inventory',503)
  const evidence=await canonicalTransactionEvidence(node,policy,block.tx[0],tip.bestblockhash,nowSeconds)
  async function synced(){
    const status=object(await wallet('getwalletstatus'))
    const walletTip=object(status.wallet_tip),nodeTip=object(status.node_tip)
    if(status.fully_synced_height!==evidence.tipHeight||walletTip.height!==evidence.tipHeight||nodeTip.height!==evidence.tipHeight||
      walletTip.blockhash!==tip.bestblockhash||nodeTip.blockhash!==tip.bestblockhash)throw new SaleError('observer_wallet_not_synced',503)
  }
  await synced()
  const accounts=await wallet('z_listaccounts')
  if(!Array.isArray(accounts)||accounts.filter(account=>account?.account_uuid===accountUuid).length!==1)throw new SaleError('observer_wallet_account_mismatch',503)
  const balance=object(await wallet('z_getbalanceforaccount',[accountUuid,minimumConfirmations]))
  if(balance.minimum_confirmations!==minimumConfirmations)throw new SaleError('wallet_inventory_confirmation_mismatch',503)
  const reported=object(balance.pools)
  if(Object.keys(reported).some(key=>!pools.includes(key as typeof pools[number])))throw new SaleError('invalid_wallet_inventory',503)
  const spendable=Object.fromEntries(pools.map(pool=>{
    const amount=Object.hasOwn(reported,pool)?object(reported[pool]).valueZat:0
    if(typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<0||amount>2100000000000000)throw new SaleError('invalid_wallet_inventory',503)
    return [pool,String(amount)]
  }))
  const total=Object.values(spendable).reduce((sum,value)=>sum+BigInt(value),0n)
  if(total>2100000000000000n)throw new SaleError('invalid_wallet_inventory',503)
  const details=object(await wallet('z_getbalances',[minimumConfirmations]))
  if(!Array.isArray(details.accounts))throw new SaleError('invalid_wallet_inventory',503)
  const matches=details.accounts.filter(account=>account?.account_uuid===accountUuid)
  if(matches.length!==1)throw new SaleError('observer_wallet_account_mismatch',503)
  const account=object(matches[0])
  if(Object.keys(account).some(key=>!['account_uuid','transparent','transparent_watchonly','sapling','orchard','ironwood','total'].includes(key))||
    (account.transparent_watchonly!==undefined&&(!Array.isArray(account.transparent_watchonly)||account.transparent_watchonly.length)))throw new SaleError('invalid_wallet_inventory',503)
  let pending=0n,dust=0n
  for(const pool of pools){
    const components:ReturnType<typeof classifiedBalance>[]=[]
    if(account[pool]!==undefined){
      if(pool==='transparent'){
        const transparent=object(account[pool])
        if(Object.keys(transparent).some(key=>!['regular','coinbase'].includes(key)))throw new SaleError('invalid_wallet_inventory',503)
        for(const part of Object.values(transparent))components.push(classifiedBalance(part))
      }else components.push(classifiedBalance(account[pool]))
    }
    if(components.reduce((sum,row)=>sum+row.spendable,0n)!==BigInt(spendable[pool]))throw new SaleError('wallet_inventory_changed',503)
    for(const row of components){pending+=row.pending;dust+=row.dust}
  }
  const declared=classifiedBalance(account.total)
  if(declared.spendable!==total||declared.pending!==pending||declared.dust!==dust||total+pending+dust>2100000000000000n)throw new SaleError('invalid_wallet_inventory',503)
  await synced()
  const after=object(await node('getblockchaininfo'))
  if(after.bestblockhash!==tip.bestblockhash||after.blocks!==evidence.tipHeight)throw new SaleError('observer_tip_changed',503)
  return {network:policy.network,genesisHash:policy.genesisHash,accountUuid,tipHeight:evidence.tipHeight,tipHash:tip.bestblockhash,
    minimumConfirmations,spendable,spendableTotalZatoshi:String(total),
    pendingZatoshi:String(pending),dustZatoshi:String(dust),lockedZatoshi:null,
    pendingClassification:'combined_change_and_pending_spendability' as const,
    spendingAuthorityVerified:false,pendingFundsIncluded:false,treasurySolvencyVerified:false}
}
