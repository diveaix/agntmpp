import type { RequestHandler, Request } from 'express'

// Only the authenticated server session may supply this timestamp. Activity
// refreshes lastSeenAt, not createdAt, and must not extend this window.
export function recentSaleAuth(sessionCreatedAt:(req:Request)=>string|undefined, now=Date.now):RequestHandler {
  return (req,res,next)=>{
    if(req.method!=='POST'||!(/^\/(purchases|withdrawals|request-recovery)\/?$/i.test(req.path)||/^\/operator\/withdrawals\/[^/]+\/approve\/?$/i.test(req.path)))return next()
    const created=Date.parse(sessionCreatedAt(req)??'')
    const age=now()-created
    if(!Number.isFinite(age)||age<0||age>15*60_000){
      res.status(401).json({error:'sale_recent_login_required',error_description:'Sign in again before purchasing, withdrawing, resetting pending requests, or approving a payout.'})
      return
    }
    next()
  }
}
