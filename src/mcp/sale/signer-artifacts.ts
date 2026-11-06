import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { SaleError, zatoshi } from './pricing.js'

export interface SignedArtifact {
  reference: string
  network: 'mainnet' | 'testnet' | 'regtest'
  intentHash: string
  txid: string
  rawHex: string
  actualFeeZatoshi: string
}

// Use a signer-owned database, not the public API's database role. This stores
// broadcast authority, never spending keys. Callers must verify transaction
// contents/txid against the approved intent before writing; hashing is not validation.
export class SignerArtifacts {
  constructor(private readonly db: Pool) {}

  async signForWallet(walletAccountUuid:string,intent:Pick<SignedArtifact,'reference'|'network'|'intentHash'>,
    sign:()=>Promise<Pick<SignedArtifact,'txid'|'rawHex'|'actualFeeZatoshi'>>):Promise<SignedArtifact> {
    if(!/^[a-f0-9-]{36}$/.test(walletAccountUuid))throw new SaleError('invalid_signer_configuration',503)
    const existing=await this.load(intent.reference)
    if(!existing){
      // Committed before proposal creation. No TTL: a lost wallet response can
      // leave a signed transaction or an in-flight wallet operation behind.
      const claimed=await this.db.query(`INSERT INTO agnt_wallet_signing_locks(network,wallet_account_uuid,reference)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING reference`,[intent.network,walletAccountUuid,intent.reference])
      if(claimed.rows.length!==1)throw new SaleError('treasury_signing_busy_or_review_required',409)
    }
    const artifact=await this.signOnce(intent,sign)
    // The trusted wallet adapter must have stored the extracted transaction
    // (pending-spent inputs) before returning. Persist bytes before unlocking.
    // A crash before this DELETE is recovered by replaying the saved artifact.
    await this.db.query('DELETE FROM agnt_wallet_signing_locks WHERE network=$1 AND wallet_account_uuid=$2 AND reference=$3',[intent.network,walletAccountUuid,intent.reference])
    return artifact
  }

  async signOnce(intent: Pick<SignedArtifact,'reference'|'network'|'intentHash'>,
    sign: () => Promise<Pick<SignedArtifact,'txid'|'rawHex'|'actualFeeZatoshi'>>): Promise<SignedArtifact> {
    const existing=await this.load(intent.reference)
    if(existing){
      if(existing.network!==intent.network || existing.intentHash!==intent.intentHash)throw new SaleError('signing_intent_conflict',409)
      return existing
    }
    await this.begin(intent.reference,intent.network,intent.intentHash)
    // Failures leave the claim intact, even if signing may not have started.
    // Availability is sacrificed for safety when the outcome is ambiguous.
    const result=await sign()
    return this.save({...intent,txid:result.txid,rawHex:result.rawHex,actualFeeZatoshi:result.actualFeeZatoshi})
  }

  async migrate() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS agnt_wallet_signing_locks (
      network text NOT NULL CHECK(network IN ('mainnet','testnet','regtest')),
      wallet_account_uuid text NOT NULL, reference text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(network,wallet_account_uuid)
    )`)
    await this.db.query(`CREATE TABLE IF NOT EXISTS agnt_signing_intents (
      reference text PRIMARY KEY, network text NOT NULL CHECK(network IN ('mainnet','testnet','regtest')),
      intent_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`)
    await this.db.query(`CREATE TABLE IF NOT EXISTS agnt_signed_artifacts (
      reference text PRIMARY KEY, network text NOT NULL CHECK(network IN ('mainnet','testnet','regtest')),
      intent_hash text NOT NULL, txid text NOT NULL, raw_hex text NOT NULL, raw_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(network,txid)
    )`)
    // Legacy artifacts have unknown fees and must fail closed on recovery.
    await this.db.query('ALTER TABLE agnt_signed_artifacts ADD COLUMN IF NOT EXISTS actual_fee text')
  }

  // Commit BEFORE asking a wallet to create/sign a transaction. No timed lease:
  // after an ambiguous crash, automatic re-signing could create a second payment.
  // Recover a committed artifact or require review; never silently reclaim intent.
  async begin(reference: string, network: SignedArtifact['network'], intentHash: string): Promise<void> {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(reference) || !['mainnet','testnet','regtest'].includes(network) ||
        !/^[a-f0-9]{64}$/.test(intentHash)) throw new SaleError('invalid_signing_intent')
    const result=await this.db.query(`INSERT INTO agnt_signing_intents(reference,network,intent_hash)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING reference`,[reference,network,intentHash])
    if(result.rows.length===1)return
    const row=(await this.db.query('SELECT * FROM agnt_signing_intents WHERE reference=$1',[reference])).rows[0]
    if(!row || row.network!==network || row.intent_hash!==intentHash)throw new SaleError('signing_intent_conflict',409)
    throw new SaleError('signing_already_started_recover_or_review',409)
  }

  async save(artifact: SignedArtifact): Promise<SignedArtifact> {
    zatoshi(artifact.actualFeeZatoshi)
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(artifact.reference) ||
        !['mainnet','testnet','regtest'].includes(artifact.network) ||
        !/^[a-f0-9]{64}$/.test(artifact.intentHash) || !/^[a-f0-9]{64}$/.test(artifact.txid) ||
        !/^(?:[a-f0-9]{2})+$/.test(artifact.rawHex) || artifact.rawHex.length>4_000_000) {
      throw new SaleError('invalid_signed_artifact')
    }
    const hash=createHash('sha256').update(artifact.rawHex,'hex').digest('hex')
    const intent=(await this.db.query('SELECT * FROM agnt_signing_intents WHERE reference=$1',[artifact.reference])).rows[0]
    if(!intent || intent.network!==artifact.network || intent.intent_hash!==artifact.intentHash)throw new SaleError('signing_intent_conflict',409)
    // Never replace an existing artifact, including a second extraction of the
    // same PCZT. The first committed bytes are the only bytes eligible for retry.
    await this.db.query(`INSERT INTO agnt_signed_artifacts(reference,network,intent_hash,txid,raw_hex,raw_hash,actual_fee)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [artifact.reference,artifact.network,artifact.intentHash,artifact.txid,artifact.rawHex,hash,artifact.actualFeeZatoshi])
    const stored=await this.load(artifact.reference)
    if (!stored || stored.network!==artifact.network || stored.intentHash!==artifact.intentHash ||
        stored.txid!==artifact.txid || stored.rawHex!==artifact.rawHex || stored.actualFeeZatoshi!==artifact.actualFeeZatoshi) throw new SaleError('signed_artifact_conflict',409)
    return stored
  }

  async load(reference: string): Promise<SignedArtifact | null> {
    const row=(await this.db.query(`SELECT a.*,i.network AS claimed_network,i.intent_hash AS claimed_intent_hash
      FROM agnt_signed_artifacts a LEFT JOIN agnt_signing_intents i ON i.reference=a.reference WHERE a.reference=$1`,[reference])).rows[0]
    if (!row) return null
    if(typeof row.actual_fee!=='string')throw new SaleError('signed_artifact_fee_missing',503)
    zatoshi(row.actual_fee)
    if (typeof row.reference!=='string'||row.reference!==reference||!/^[a-zA-Z0-9:_-]{1,160}$/.test(row.reference)||
        !['mainnet','testnet','regtest'].includes(row.network)||typeof row.intent_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.intent_hash)||
        typeof row.txid!=='string'||!/^[a-f0-9]{64}$/.test(row.txid)||
        row.claimed_network!==row.network||row.claimed_intent_hash!==row.intent_hash||
        typeof row.raw_hex!=='string'||row.raw_hex.length>4_000_000||!/^(?:[a-f0-9]{2})+$/.test(row.raw_hex) ||
        createHash('sha256').update(row.raw_hex,'hex').digest('hex')!==row.raw_hash) {
      throw new SaleError('signed_artifact_corrupt',503)
    }
    return {reference:row.reference,network:row.network,intentHash:row.intent_hash,txid:row.txid,rawHex:row.raw_hex,actualFeeZatoshi:row.actual_fee}
  }
}
