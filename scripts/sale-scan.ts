import 'dotenv/config'
import { salePool } from '../src/mcp/sale/database.js'
import { zcashRpcClient } from '../src/mcp/sale/zcash-rpc.js'
import { runObserverBatch } from '../src/mcp/sale/observer-batch.js'
import { SaleError } from '../src/mcp/sale/pricing.js'

// One bounded run for an operator-controlled scheduler. Never starts on import
// from the web server; credentials and signer methods stay outside the frontend.
async function main(){
  if(process.env.AGNT_SALE_OBSERVER_ENABLED!=='true'){
    console.log('Sale observer is disabled. No wallet, node or database connection was opened.')
    return
  }
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new SaleError('observer_configuration_missing',503);return value}
  const network=required('AGNT_ZCASH_NETWORK')
  if(network!=='mainnet'&&network!=='testnet'&&network!=='regtest')throw new SaleError('observer_network_invalid',503)
  const startHeight=Number(required('AGNT_SALE_SCAN_START_HEIGHT'))
  const confirmations=Number(required('AGNT_SALE_CONFIRMATIONS'))
  if(!Number.isSafeInteger(startHeight)||startHeight<0||!Number.isSafeInteger(confirmations)||confirmations<1)throw new SaleError('observer_configuration_invalid',503)
  const genesisHash=required('AGNT_ZCASH_GENESIS_HASH')
  if(!/^[a-f0-9]{64}$/.test(genesisHash))throw new SaleError('observer_configuration_invalid',503)
  const wallet=zcashRpcClient({endpoint:required('AGNT_ZALLET_RPC_URL'),username:required('AGNT_ZALLET_RPC_USER'),password:required('AGNT_ZALLET_RPC_PASSWORD'),
    methods:['getwalletstatus','z_viewtransaction','z_listaccounts']})
  const node=zcashRpcClient({endpoint:required('AGNT_ZEBRA_RPC_URL'),username:required('AGNT_ZEBRA_RPC_USER'),password:required('AGNT_ZEBRA_RPC_PASSWORD'),
    methods:['getblockchaininfo','getblock','getblockhash']})
  const db=salePool()
  try{
    const result=await runObserverBatch(db,wallet,node,{network,genesisHash,maxTipAgeSeconds:300},startHeight,confirmations)
    console.log(`Observer batch complete: ${result.checked} accounts checked; ${result.advanced} checkpoints advanced.`)
  }finally{await db.end()}
}
main().catch(error=>{
  // Never log RPC URLs, credentials, user identities or raw provider errors.
  console.error(error instanceof SaleError?error.code:'observer_run_failed')
  process.exitCode=1
})
