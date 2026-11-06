import 'dotenv/config'
import { Pool } from 'pg'
import { salePool } from '../src/mcp/sale/database.js'
import { SignerArtifacts } from '../src/mcp/sale/signer-artifacts.js'
import { broadcastSignedWithdrawal, settleConfirmedWithdrawal, reviewPaidWithdrawal } from '../src/mcp/sale/withdrawal-worker.js'
import { zcashRpcClient } from '../src/mcp/sale/zcash-rpc.js'
import { SaleError } from '../src/mcp/sale/pricing.js'
import type { ChainPolicy } from '../src/mcp/sale/zcash-observer.js'

// No wallet RPC or approval/signing authority. Broadcast reads the stored bytes;
// settlement treats the supplied block hash only as a hint for node verification.
async function main(){
  if(process.env.AGNT_SALE_PAYOUTS_ENABLED!=='true'){
    console.log('Sale payouts are disabled. No database or node connection was opened.')
    return
  }
  const [mode,id,blockHash]=process.argv.slice(2)
  if(!['broadcast','settle','review'].includes(mode)||!id||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)||
    (mode!=='settle'?process.argv.length!==4:process.argv.length!==5||!/^[a-f0-9]{64}$/.test(blockHash)))throw new SaleError('invalid_payout_arguments')
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new SaleError('payout_configuration_missing',503);return value}
  const network=required('AGNT_ZCASH_NETWORK'),genesisHash=required('AGNT_ZCASH_GENESIS_HASH')
  if(!['mainnet','testnet','regtest'].includes(network)||!/^[a-f0-9]{64}$/.test(genesisHash))throw new SaleError('invalid_payout_configuration',503)
  const policy:ChainPolicy={network:network as ChainPolicy['network'],genesisHash,maxTipAgeSeconds:300}
  const account=mode==='broadcast'?required('AGNT_ZALLET_SIGNER_ACCOUNT'):''
  if(mode==='broadcast'&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(account))throw new SaleError('invalid_payout_configuration',503)
  const confirmations=mode==='settle'?Number(required('AGNT_SALE_CONFIRMATIONS')):1
  if(!Number.isSafeInteger(confirmations)||confirmations<1)throw new SaleError('invalid_confirmations')
  const node=zcashRpcClient({endpoint:required('AGNT_ZEBRA_RPC_URL'),username:required('AGNT_ZEBRA_RPC_USER'),password:required('AGNT_ZEBRA_RPC_PASSWORD'),
    methods:['getblockchaininfo','getblock','getblockhash',...(mode==='broadcast'?['getrawmempool','sendrawtransaction']:[])]})
  const signerDb=new Pool({connectionString:required('AGNT_SALE_SIGNER_DATABASE_URL'),max:2,connectionTimeoutMillis:5000,statement_timeout:10000})
  const db=salePool()
  try{
    const row=(await db.query('SELECT user_id FROM agnt_sale_withdrawals WHERE id=$1',[id])).rows[0]
    if(!row)throw new SaleError('withdrawal_not_found',404)
    const artifacts=new SignerArtifacts(signerDb)
    if(mode==='review'){
      const result=await reviewPaidWithdrawal(db,artifacts,node,policy,row.user_id,id)
      if(result.reviewRequired)throw new SaleError('paid_withdrawal_operator_review_required',409)
      console.log('Stored payout settlement remains canonical. No funds moved.')
      return
    }
    if(mode==='broadcast')await broadcastSignedWithdrawal(db,artifacts,node,policy,row.user_id,id,account)
    else await settleConfirmedWithdrawal(db,artifacts,node,policy,row.user_id,id,blockHash,confirmations)
    console.log(mode==='broadcast'?'Stored withdrawal broadcast acknowledged. Confirmation settlement is separate.':'Withdrawal confirmation verified and settlement recorded.')
  }finally{await Promise.all([db.end(),signerDb.end()])}
}
main().catch(error=>{
  console.error(error instanceof SaleError?error.code:'payout_run_failed')
  process.exitCode=1
})
