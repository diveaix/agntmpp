import 'dotenv/config'
import { Pool } from 'pg'
import { SignerArtifacts } from '../src/mcp/sale/signer-artifacts.js'

const connectionString=process.env.AGNT_SALE_SIGNER_DATABASE_URL
if(!connectionString)throw new Error('signer_database_unconfigured')
const db=new Pool({connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:10000})
try{
  await new SignerArtifacts(db).migrate()
  console.log('Signer artifact schema initialized. No approval, signing or broadcast performed.')
}catch{
  console.error('signer_migration_failed')
  process.exitCode=1
}finally{await db.end()}
