import 'dotenv/config'
import { Pool } from 'pg'
import { salePool } from '../src/mcp/sale/database.js'
import { SignerArtifacts } from '../src/mcp/sale/signer-artifacts.js'
import { signApprovedWithdrawal } from '../src/mcp/sale/withdrawal-worker.js'
import { signZalletWithdrawal } from '../src/mcp/sale/zallet-signer.js'
import { zcashRpcClient } from '../src/mcp/sale/zcash-rpc.js'
import { SaleError } from '../src/mcp/sale/pricing.js'
import type { ChainPolicy } from '../src/mcp/sale/zcash-observer.js'

// Operator-only signing process: no approval, broadcast, HTTP listener or raw
// transaction output. Keep signer credentials out of the web/API environment.
async function main(){
  if(process.env.AGNT_SALE_SIGNER_ENABLED!=='true'){
    console.log('Sale signer is disabled. No database, wallet or node connection was opened.')
    return
  }
  const id=process.argv[2]
  if(process.argv.length!==3||!id||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))throw new SaleError('signer_withdrawal_id_required')
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new SaleError('signer_configuration_missing',503);return value}
  const network=required('AGNT_ZCASH_NETWORK')
  if(network!=='mainnet'&&network!=='testnet'&&network!=='regtest')throw new SaleError('invalid_signer_configuration',503)
  const genesisHash=required('AGNT_ZCASH_GENESIS_HASH'),walletAccount=required('AGNT_ZALLET_SIGNER_ACCOUNT')
  if(!/^[a-f0-9]{64}$/.test(genesisHash)||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(walletAccount))throw new SaleError('invalid_signer_configuration',503)
  const signerUrl=required('AGNT_SALE_SIGNER_DATABASE_URL')
  if(signerUrl===required('AGNT_SALE_DATABASE_URL'))throw new SaleError('separate_signer_database_required',503)
  const wallet=zcashRpcClient({endpoint:required('AGNT_ZALLET_SIGNER_RPC_URL'),username:required('AGNT_ZALLET_SIGNER_RPC_USER'),password:required('AGNT_ZALLET_SIGNER_RPC_PASSWORD'),
    methods:['getwalletstatus','pczt_create','pczt_inspect','pczt_prove','pczt_sign','pczt_extract','decoderawtransaction']})
  const node=zcashRpcClient({endpoint:required('AGNT_ZEBRA_RPC_URL'),username:required('AGNT_ZEBRA_RPC_USER'),password:required('AGNT_ZEBRA_RPC_PASSWORD'),methods:['getblockchaininfo','getblock','getblockhash']})
  const signerDb=new Pool({connectionString:signerUrl,max:2,connectionTimeoutMillis:5000,statement_timeout:10000})
  const db=salePool()
  try{
    const row=(await db.query('SELECT user_id FROM agnt_sale_withdrawals WHERE id=$1',[id])).rows[0]
    if(!row)throw new SaleError('withdrawal_not_found',404)
    const policy:ChainPolicy={network,genesisHash,maxTipAgeSeconds:300}
    await signApprovedWithdrawal(db,new SignerArtifacts(signerDb),row.user_id,id,network,walletAccount,intent=>signZalletWithdrawal(wallet,node,policy,intent))
    console.log('Approved withdrawal signed or recovered from its stored artifact. No broadcast was performed.')
  }finally{await Promise.all([db.end(),signerDb.end()])}
}
main().catch(error=>{
  console.error(error instanceof SaleError?error.code:'signer_run_failed')
  process.exitCode=1
})
