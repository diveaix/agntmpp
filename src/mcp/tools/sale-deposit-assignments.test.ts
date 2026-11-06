import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { DepositAssignments } from '../sale/deposit-assignments.js'
import type { ZcashRpc } from '../sale/zcash-observer.js'

test('deposit address allocation preserves index after timeout and isolates users',async()=>{
  const db=new PGlite()
  const pool={query:(sql:string,args?:unknown[])=>db.query(sql,args)} as unknown as Pool
  const assignments=new DepositAssignments(pool)
  const account='11111111-1111-1111-1111-111111111111'
  const indices:number[]=[]
  const wallet:ZcashRpc=async(method,params=[])=>{
    assert.equal(method,'z_getaddressforaccount')
    const index=params[2] as number
    indices.push(index)
    return {account_uuid:account,diversifier_index:index,receiver_types:['orchard'],address:`synthetic-only-${String(index).padStart(40,'0')}`}
  }
  try{
    await assignments.migrate()
    await assert.rejects(assignments.allocate('alice','regtest',account,async(_method,params=[])=>{
      indices.push(params[2] as number);throw new Error('lost RPC response')
    }),/lost RPC response/)
    const alice=await assignments.allocate('alice','regtest',account,wallet)
    assert.equal(indices[0],indices[1])
    assert.deepEqual(await new DepositAssignments(pool).allocate('alice','regtest',account,async()=>{throw new Error('must use saved address')}),alice)
    const bob=await assignments.allocate('bob','regtest',account,wallet)
    assert.notEqual(alice.recipientAddresses[0],bob.recipientAddresses[0])
    await assert.rejects(assignments.allocate('alice','regtest','22222222-2222-2222-2222-222222222222',wallet),/account_conflict/)
    await assert.rejects(assignments.allocate('carol','regtest',account,async()=>({account_uuid:account,diversifier_index:0,receiver_types:['transparent'],address:'x'.repeat(80)})),/invalid_address_derivation/)
  }finally{await db.close()}
})
