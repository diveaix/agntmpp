import type { Pool } from 'pg'
import { SaleError } from './pricing.js'
import type { DepositAssignment } from './zallet-receipts.js'
import type { ZcashRpc } from './zcash-observer.js'

// Use a dedicated treasury account; do not allocate other addresses in its
// reserved index range. No key material is stored here or sent to the browser.
export class DepositAssignments {
  constructor(private readonly db:Pool){}

  async load(userId:string,network:DepositAssignment['network']):Promise<DepositAssignment|null>{
    const row=(await this.db.query('SELECT * FROM agnt_deposit_assignments WHERE user_id=$1 AND network=$2',[userId,network])).rows[0]
    if(!row?.address)return null
    return {userId,network,walletAccountUuid:row.wallet_account_uuid,recipientAddresses:[row.address]}
  }

  async migrate(){
    await this.db.query(`CREATE SEQUENCE IF NOT EXISTS agnt_deposit_index START 1024 MAXVALUE 9007199254740991`)
    await this.db.query(`CREATE TABLE IF NOT EXISTS agnt_deposit_assignments (
      user_id text NOT NULL, network text NOT NULL CHECK(network IN ('mainnet','testnet','regtest')),
      wallet_account_uuid text NOT NULL, derivation_index bigint NOT NULL DEFAULT nextval('agnt_deposit_index'),
      address text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id,network), UNIQUE(network,wallet_account_uuid,derivation_index)
    )`)
  }

  async allocate(userId:string,network:DepositAssignment['network'],walletAccountUuid:string,wallet:ZcashRpc):Promise<DepositAssignment>{
    if(!userId||userId.length>200||!['mainnet','testnet','regtest'].includes(network)||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(walletAccountUuid))throw new SaleError('invalid_deposit_assignment')
    // Reserve before RPC. A timeout keeps the same index for the next attempt.
    await this.db.query(`INSERT INTO agnt_deposit_assignments(user_id,network,wallet_account_uuid)
      VALUES($1,$2,$3) ON CONFLICT(user_id,network) DO NOTHING`,[userId,network,walletAccountUuid])
    const row=(await this.db.query('SELECT * FROM agnt_deposit_assignments WHERE user_id=$1 AND network=$2',[userId,network])).rows[0]
    if(row.wallet_account_uuid!==walletAccountUuid)throw new SaleError('deposit_assignment_account_conflict',409)
    if(!row.address){
      const index=Number(row.derivation_index)
      if(!Number.isSafeInteger(index)||index<1024)throw new SaleError('invalid_deposit_index',503)
      const result=await wallet('z_getaddressforaccount',[walletAccountUuid,['orchard'],index]) as Record<string,unknown>|null
      if(!result||result.account_uuid!==walletAccountUuid||result.diversifier_index!==index||
        !Array.isArray(result.receiver_types)||result.receiver_types.length!==1||result.receiver_types[0]!=='orchard'||
        typeof result.address!=='string'||result.address.length<40||result.address.length>1024)throw new SaleError('invalid_address_derivation',503)
      // Concurrent retries must yield identical addresses. Never overwrite one.
      await this.db.query(`UPDATE agnt_deposit_assignments SET address=$3
        WHERE user_id=$1 AND network=$2 AND address IS NULL`,[userId,network,result.address])
      row.address=(await this.db.query('SELECT address FROM agnt_deposit_assignments WHERE user_id=$1 AND network=$2',[userId,network])).rows[0].address
      if(row.address!==result.address)throw new SaleError('deposit_address_conflict',409)
    }
    // Only the exact Orchard-only UA is accepted. Additional receiver aliases
    // require reviewed wallet evidence, not guessed address conversions.
    return {userId,network,walletAccountUuid,recipientAddresses:[row.address]}
  }
}
