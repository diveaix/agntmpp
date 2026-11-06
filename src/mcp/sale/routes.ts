import { Router, json, type RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { CURVE_VERSION, SUPPLY, SaleError, totalPrice } from './pricing.js'
import { SaleService } from './service.js'
import { requireSaleLaunch, saleReadiness, describePassAccess } from './runtime.js'
import type { DepositAssignment } from './zallet-receipts.js'

interface SaleRouterServices {
  service:()=>SaleService
  assertLaunchReady:()=>void
  depositAddress:(userId:string)=>Promise<DepositAssignment>
  validateDestination:(address:string)=>Promise<void>
}

function withdrawalReceipt(row:{id:string;amount:string;fee_limit:string;state:string;txid:string|null;actual_fee:string|null}){
  return {id:row.id,amount:row.amount,fee_limit:row.fee_limit,state:row.state,txid:row.txid,actual_fee:row.actual_fee}
}

export function saleRouter(auth: RequestHandler, userId: (req: Express.Request) => string, origins: () => string[], overrides:Partial<SaleRouterServices>={}) {
  // Server composition only, never request-controlled. Production boot uses the
  // defaults: launch stays locked until verified providers/policies are wired.
  const services:SaleRouterServices={service:()=>new SaleService(),assertLaunchReady:requireSaleLaunch,
    depositAddress:async()=>{throw new SaleError('deposit_provider_unconfigured',503)},
    validateDestination:async()=>{throw new SaleError('withdrawal_provider_unconfigured',503)},...overrides}
  const router=Router()
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next()})
  router.use(rateLimit({windowMs:60000,limit:60,standardHeaders:true,legacyHeaders:false}))
  router.use(json({limit:'8kb'}))
  router.get('/',async(_req,res,next)=>{
    try {
      const ready=saleReadiness()
      const sale=process.env.AGNT_SALE_DATABASE_URL ? await services.service().summary() : {
        state:'CLOSED',sold:null,supply:SUPPLY,curveVersion:CURVE_VERSION,nextPriceZatoshi:null,
        firstPriceZatoshi:'2000000',lastPriceZatoshi:String(totalPrice(SUPPLY-1,1)),totalSaleZatoshi:String(totalPrice(0,SUPPLY)),
      }
      res.json({...sale,...ready})
    }catch(e){next(e)}
  })
  router.use(auth)
  router.use((req,res,next)=>{
    if(req.method==='GET')return next()
    const origin=req.get('origin')
    if(!origin || !origins().includes(origin)){res.status(403).json({error:'untrusted_origin'});return}
    if(req.body?.ownerId!==undefined&&req.body.ownerId!==userId(req)){res.status(409).json({error:'sale_account_changed'});return}
    next()
  })
  router.get('/account',async(req,res,next)=>{try{
    const service=services.service(),owner=userId(req)
    const account=await service.account(owner)
    res.json({...account,collectibleAccess:await describePassAccess(owner,service)})
  }catch(e){next(e)}})
  router.get('/operator/withdrawals/:id',async(req,res,next)=>{try{
    res.json(await services.service().operatorWithdrawal(userId(req),String(req.params.id)))
  }catch(e){next(e)}})
  router.post('/operator/withdrawals/:id/approve',async(req,res,next)=>{try{
    services.assertLaunchReady()
    const body=req.body
    if(!body||Object.keys(body).some(key=>!['reason','payloadHash'].includes(key)))throw new SaleError('invalid_withdrawal_approval')
    res.json(await services.service().operatorApproveWithdrawal(userId(req),String(req.params.id),{reason:body.reason,payloadHash:body.payloadHash}))
  }catch(e){next(e)}})
  router.get('/notifications',async(req,res,next)=>{try{const owner=userId(req);res.json({userId:owner,notifications:await services.service().notifications(owner)})}catch(e){next(e)}})
  router.get('/purchases/:id',async(req,res,next)=>{try{res.json(await services.service().purchaseReceipt(userId(req),String(req.params.id)))}catch(e){next(e)}})
  router.get('/withdrawals/:id',async(req,res,next)=>{try{res.json(await services.service().withdrawalStatus(userId(req),String(req.params.id)))}catch(e){next(e)}})
  router.post('/notifications/:id/read',async(req,res,next)=>{try{res.json(await services.service().readNotification(userId(req),String(req.params.id)))}catch(e){next(e)}})
  router.get('/account/export',async(req,res,next)=>{try{
    const data=await services.service().exportAccount(userId(req))
    res.setHeader('Content-Disposition','attachment; filename="agent-sale-history.json"')
    res.setHeader('X-Content-Type-Options','nosniff')
    res.json(data)
  }catch(e){next(e)}})
  router.post('/request-status',async(req,res,next)=>{try{
    const body=req.body
    if(!body||!['purchase','withdrawal'].includes(body.kind)||typeof body.idempotencyKey!=='string')throw new SaleError('invalid_request_status')
    // Read-only recovery remains available when new financial operations are locked.
    res.json(await services.service().requestStatus(userId(req),body.kind,body.idempotencyKey))
  }catch(e){next(e)}})
  router.post('/cancel-pending-request',async(req,res,next)=>{try{
    const body=req.body
    if(!body||!['purchase','withdrawal'].includes(body.kind)||typeof body.idempotencyKey!=='string')throw new SaleError('invalid_request_status')
    res.json(await services.service().cancelPendingRequest(userId(req),body.kind,body.idempotencyKey))
  }catch(e){next(e)}})
  router.get('/request-recovery',async(req,res,next)=>{try{
    res.json(await services.service().requestRecoveryState(userId(req)))
  }catch(e){next(e)}})
  router.post('/request-recovery',async(req,res,next)=>{try{
    const body=req.body
    if(!body||Object.keys(body).some(key=>!['ownerId','expectedGeneration'].includes(key))||!Number.isSafeInteger(body.expectedGeneration))throw new SaleError('invalid_request_generation')
    // Recovery fences old submissions; it neither launches a sale nor refunds
    // committed work, so it remains available behind the real-money launch lock.
    res.json(await services.service().resetPendingRequests(userId(req),body.expectedGeneration))
  }catch(e){next(e)}})
  router.post('/quote',async(req,res,next)=>{
    try{
      const quantity=req.body?.quantity
      if(!Number.isInteger(quantity)||quantity<1||quantity>SUPPLY)throw new SaleError('invalid_quantity')
      res.json(await services.service().quote(userId(req),quantity))
    }catch(e){next(e)}
  })
  router.post('/purchases',async(req,res,next)=>{try{
    services.assertLaunchReady()
    const body=req.body
    if(!body||!Number.isInteger(body.quantity)||body.quantity<1||body.quantity>SUPPLY||
      ['quoteId','maxTotalZatoshi','curveVersion','idempotencyKey'].some(key=>typeof body[key]!=='string'))throw new SaleError('invalid_purchase')
    const row=await services.service().purchase(userId(req),{quoteId:body.quoteId,quantity:body.quantity,maxTotalZatoshi:body.maxTotalZatoshi,curveVersion:body.curveVersion,idempotencyKey:body.idempotencyKey,...(body.requestGeneration!==undefined?{requestGeneration:body.requestGeneration}:{})})
    res.json({id:row.id,first_serial:row.first_serial,quantity:row.quantity,total:String(row.total),curve_version:row.curve_version,access_policy_version:row.access_policy_version,created_at:row.created_at})
  }catch(e){next(e)}})
  router.post('/deposit-address',async(req,res,next)=>{try{
    services.assertLaunchReady()
    const owner=userId(req),assignment=await services.depositAddress(owner)
    if(assignment.userId!==owner||assignment.recipientAddresses.length!==1)throw new SaleError('invalid_deposit_assignment',503)
    // Never expose the treasury wallet account UUID or derivation metadata.
    res.json({network:assignment.network,address:assignment.recipientAddresses[0]})
  }catch(e){next(e)}})
  router.post('/withdrawals',async(req,res,next)=>{try{
    services.assertLaunchReady()
    const body=req.body
    if(!body||['destination','amountZatoshi','feeLimitZatoshi','idempotencyKey'].some(key=>typeof body[key]!=='string'))throw new SaleError('invalid_withdrawal')
    await services.validateDestination(body.destination)
    const row=await services.service().holdWithdrawal(userId(req),{destination:body.destination,amountZatoshi:body.amountZatoshi,feeLimitZatoshi:body.feeLimitZatoshi,idempotencyKey:body.idempotencyKey,...(body.requestGeneration!==undefined?{requestGeneration:body.requestGeneration}:{})})
    res.json(withdrawalReceipt(row))
  }catch(e){next(e)}})
  router.post('/withdrawals/:id/cancel',async(req,res,next)=>{try{res.json(withdrawalReceipt(await services.service().cancelWithdrawal(userId(req),String(req.params.id))))}catch(e){next(e)}})
  router.use((error: unknown,_req: import('express').Request,res: import('express').Response,_next: import('express').NextFunction)=>{
    const type=error && typeof error==='object' && 'type' in error ? error.type : undefined
    if(type==='entity.parse.failed'){res.status(400).json({error:'invalid_json'});return}
    if(type==='entity.too.large'){res.status(413).json({error:'request_too_large'});return}
    res.status(error instanceof SaleError ? error.status : 503).json({error:error instanceof SaleError ? error.code : 'sale_unavailable'})
  })
  return router
}
