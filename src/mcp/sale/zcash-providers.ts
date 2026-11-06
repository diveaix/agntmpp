import type { Pool } from 'pg'
import { DepositAssignments } from './deposit-assignments.js'
import { canonicalTransactionEvidence, ZcashRpcError, type ChainPolicy, type ZcashRpc } from './zcash-observer.js'
import { SaleError } from './pricing.js'

// Read/derive-only wallet identity. No spending/signing methods belong here.
// Pinned beta.3 z_listunifiedreceivers decodes using the wallet network params.
export function zcashSaleProviders(db:Pool,wallet:ZcashRpc,node:ZcashRpc,policy:ChainPolicy,walletAccount:string,nowSeconds?:number){
  async function ready(){
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(walletAccount))throw new SaleError('invalid_deposit_assignment',503)
    const tip=await node('getblockchaininfo') as any
    const block=await node('getblock',[tip?.bestblockhash,1]) as any
    const proof=await canonicalTransactionEvidence(node,policy,block?.tx?.[0],tip?.bestblockhash,nowSeconds)
    const status=await wallet('getwalletstatus') as any
    if(status?.fully_synced_height!==proof.tipHeight||status?.wallet_tip?.height!==proof.tipHeight||status?.node_tip?.height!==proof.tipHeight||
      status?.wallet_tip?.blockhash!==tip.bestblockhash||status?.node_tip?.blockhash!==tip.bestblockhash)throw new SaleError('observer_wallet_not_synced',503)
    const accounts=await wallet('z_listaccounts')
    if(!Array.isArray(accounts)||!accounts.some(account=>account?.account_uuid===walletAccount))throw new SaleError('observer_wallet_account_mismatch',503)
  }
  return {
    depositAddress:async(userId:string)=>{
      await ready()
      return new DepositAssignments(db).allocate(userId,policy.network,walletAccount,wallet)
    },
    validateDestination:async(address:string)=>{
      if(typeof address!=='string'||address.length<40||address.length>512||address.trim()!==address)throw new SaleError('invalid_destination')
      await ready()
      let receivers:unknown
      try{receivers=await wallet('z_listunifiedreceivers',[address])}
      catch(error){
        if(error instanceof ZcashRpcError&&[-5,-8].includes(error.rpcCode))throw new SaleError('invalid_destination')
        throw error
      }
      if(!receivers||typeof receivers!=='object'||Array.isArray(receivers))throw new SaleError('invalid_address_validation',503)
      const value=receivers as Record<string,unknown>
      if(Object.entries(value).some(([key,receiver])=>!['orchard','sapling','p2pkh','p2sh'].includes(key)||typeof receiver!=='string'||!receiver))throw new SaleError('invalid_address_validation',503)
      if(typeof value.orchard!=='string'||value.orchard.length<40||value.orchard.length>1024)throw new SaleError('orchard_unified_address_required')
      // Keep the user's original address. Never silently replace the destination
      // with a receiver alias; the isolated signer rechecks the exact intent.
    },
  }
}
