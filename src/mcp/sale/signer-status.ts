import type { Pool } from 'pg'
import { transaction } from './database.js'

// Signer-side aggregate diagnostics. No transaction bytes, references, account
// identities or intent hashes leave this report. Never clear a claim here.
export async function signerOperationsStatus(db:Pool){
  return transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const intents=(await c.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE a.reference IS NULL)::int AS without_artifact,
      EXTRACT(EPOCH FROM now()-min(i.created_at) FILTER(WHERE a.reference IS NULL))::bigint::text AS oldest_unresolved_seconds
      FROM agnt_signing_intents i LEFT JOIN agnt_signed_artifacts a ON a.reference=i.reference`)).rows[0]
    const locks=(await c.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE a.reference IS NULL)::int AS without_artifact,
      count(*) FILTER(WHERE a.reference IS NOT NULL)::int AS with_artifact,
      count(*) FILTER(WHERE i.reference IS NULL)::int AS without_intent
      FROM agnt_wallet_signing_locks l LEFT JOIN agnt_signing_intents i ON i.reference=l.reference
      LEFT JOIN agnt_signed_artifacts a ON a.reference=l.reference`)).rows[0]
    const artifacts=(await c.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE i.reference IS NULL OR i.network<>a.network OR i.intent_hash<>a.intent_hash)::int AS intent_mismatches
      FROM agnt_signed_artifacts a LEFT JOIN agnt_signing_intents i ON i.reference=a.reference`)).rows[0]
    const lockMismatches=Number((await c.query(`SELECT count(*)::int AS count FROM agnt_wallet_signing_locks l
      LEFT JOIN agnt_signing_intents i ON i.reference=l.reference
      LEFT JOIN agnt_signed_artifacts a ON a.reference=l.reference
      WHERE (i.reference IS NOT NULL AND i.network<>l.network) OR (a.reference IS NOT NULL AND a.network<>l.network)`)).rows[0].count)
    return {observedAt:(await c.query('SELECT transaction_timestamp() AS at')).rows[0].at,
      intents,locks,artifacts,lockMismatches,
      unresolvedSigning:intents.without_artifact>0||locks.total>0,
      integrityReviewRequired:artifacts.intent_mismatches>0||lockMismatches>0,
      // Unresolved may be a live operation, not a dead worker. Age is evidence,
      // not a lease expiry, and row presence is not artifact validation.
      artifactBytesVerified:false,workerLivenessVerified:false,treasurySolvencyVerified:false}
  },db)
}
