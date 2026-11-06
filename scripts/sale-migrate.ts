import 'dotenv/config'
import { migrateSale, salePool } from '../src/mcp/sale/database.js'
try {
  await migrateSale()
  console.log('Sale schema initialized. Sale remains closed; no payment integration enabled.')
} finally { await salePool().end() }
