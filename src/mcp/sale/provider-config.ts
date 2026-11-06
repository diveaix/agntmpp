import { salePool } from './database.js'
import { zcashRpcClient } from './zcash-rpc.js'
import { zcashSaleProviders } from './zcash-providers.js'
import { SaleError } from './pricing.js'

// Configuring providers does not change requireSaleLaunch or enable payments.
export function configuredSaleProviders(){
  if(process.env.AGNT_SALE_PROVIDERS_ENABLED!=='true')return {}
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new SaleError('sale_provider_configuration_missing',503);return value}
  const network=required('AGNT_ZCASH_NETWORK'),genesisHash=required('AGNT_ZCASH_GENESIS_HASH'),account=required('AGNT_ZALLET_DEPOSIT_ACCOUNT')
  if(network!=='mainnet'&&network!=='testnet'&&network!=='regtest')throw new SaleError('invalid_sale_provider_configuration',503)
  if(!/^[a-f0-9]{64}$/.test(genesisHash)||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(account))throw new SaleError('invalid_sale_provider_configuration',503)
  const wallet=zcashRpcClient({endpoint:required('AGNT_ZALLET_RPC_URL'),username:required('AGNT_ZALLET_RPC_USER'),password:required('AGNT_ZALLET_RPC_PASSWORD'),
    methods:['getwalletstatus','z_listaccounts','z_getaddressforaccount','z_listunifiedreceivers']})
  const node=zcashRpcClient({endpoint:required('AGNT_ZEBRA_RPC_URL'),username:required('AGNT_ZEBRA_RPC_USER'),password:required('AGNT_ZEBRA_RPC_PASSWORD'),methods:['getblockchaininfo','getblock','getblockhash']})
  return zcashSaleProviders(salePool(),wallet,node,{network,genesisHash,maxTipAgeSeconds:300},account)
}
