'use strict';
function installWebRtcSignalRoutes({app,crypto,supabaseAdmin,requireOwner,rateLimit}){
 const sessions=new Map();
 function stale(s){return Date.now()-(s.updatedAt||s.createdAt)>120000}
 function prune(){for(const [id,s] of sessions)if(stale(s))sessions.delete(id)}
 async function authenticateAgent(req,res){
  const deviceId=typeof req.body?.deviceId==='string'?req.body.deviceId:'';
  const token=/^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization')||'')?.[1]||'';
  if(!deviceId||!token)return null;
  const hash=crypto.createHash('sha256').update(token).digest('hex');
  const {data,error}=await supabaseAdmin.from('device_agents').select('device_id').eq('device_id',deviceId).eq('token_hash',hash).eq('enabled',true).maybeSingle();
  if(error)throw error;
  if(!data){res.status(401).json({ok:false,error:'Device authentication failed.'});return null}
  return deviceId;
 }
 app.post('/api/screen/webrtc/session',rateLimit(30,60000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Screen relay is not configured.'});
  try{
   prune();
   const {data,error}=await supabaseAdmin.from('devices').select('id').eq('user_id',user.id);if(error)throw error;
   const active=(data||[]).map(d=>d.id).find(id=>global.__pbScreenFrames?.get?.(id)&&Date.now()-global.__pbScreenFrames.get(id).at<10000);
   if(!active)return res.status(409).json({ok:false,error:'No live ThinkPad connector is online.'});
   const sessionId=crypto.randomBytes(24).toString('base64url');
   sessions.set(sessionId,{userId:user.id,deviceId:active,offer:null,answer:null,createdAt:Date.now(),updatedAt:Date.now(),claimedAt:0});
   return res.json({ok:true,sessionId});
  }catch(_){return res.status(503).json({ok:false,error:'Could not create the WebRTC screen session.'})}
 });
 app.post('/api/screen/webrtc/offer',rateLimit(60,60000),async(req,res)=>{
  const user=await requireOwner(req,res);if(!user)return;
  const s=sessions.get(req.body?.sessionId),offer=req.body?.offer;
  if(!s||s.userId!==user.id||stale(s))return res.status(404).json({ok:false,error:'Screen session expired.'});
  if(offer?.type!=='offer'||typeof offer.sdp!=='string'||offer.sdp.length>500000)return res.status(400).json({ok:false,error:'Invalid WebRTC offer.'});
  const width=Number(req.body?.width||1280),height=Number(req.body?.height||720);
  if(![[1280,720],[960,540],[640,360]].some(([w,h])=>w===width&&h===height))return res.status(400).json({ok:false,error:'Unsupported screen quality.'});
  s.width=width;s.height=height;s.offer=offer;s.answer=null;s.claimedAt=0;s.updatedAt=Date.now();
  return res.json({ok:true});
 });
 app.get('/api/screen/webrtc/answer',rateLimit(240,60000),async(req,res)=>{
  const user=await requireOwner(req,res);if(!user)return;
  const s=sessions.get(String(req.query.sessionId||''));
  if(!s||s.userId!==user.id||stale(s))return res.status(404).json({ok:false,error:'Screen session expired.'});
  s.updatedAt=Date.now();
  return res.json({ok:true,answer:s.answer||null});
 });
 app.post('/api/screen/webrtc/keepalive',rateLimit(120,60000),async(req,res)=>{
  const user=await requireOwner(req,res);if(!user)return;
  const s=sessions.get(req.body?.sessionId);
  if(!s||s.userId!==user.id||stale(s))return res.status(404).json({ok:false,error:'Screen session expired.'});
  s.updatedAt=Date.now();
  return res.json({ok:true,active:true});
 });
 app.delete('/api/screen/webrtc/session',rateLimit(60,60000),async(req,res)=>{
  const user=await requireOwner(req,res);if(!user)return;
  const id=String(req.body?.sessionId||''),s=sessions.get(id);
  if(s&&s.userId===user.id)sessions.delete(id);
  return res.json({ok:true,disconnected:true});
 });
 app.post('/api/agent/screen/webrtc/poll',rateLimit(120,60000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{
   const deviceId=await authenticateAgent(req,res);if(!deviceId)return;
   prune();
   const activeSessionIds=[...sessions.entries()].filter(([,s])=>s.deviceId===deviceId).map(([id])=>id);
   const s=[...sessions.values()].find(x=>x.deviceId===deviceId&&x.offer&&!x.answer&&(!x.claimedAt||Date.now()-x.claimedAt>30000));
   if(!s)return res.json({ok:true,offer:null,activeSessionIds});
   s.claimedAt=Date.now();s.updatedAt=Date.now();
   return res.json({ok:true,sessionId:[...sessions.entries()].find(([,v])=>v===s)?.[0],offer:s.offer,width:s.width||1280,height:s.height||720,activeSessionIds});
  }catch(_){return res.status(503).json({ok:false,error:'Could not check for a WebRTC screen session.'})}
 });
 app.post('/api/agent/screen/webrtc/answer',rateLimit(60,60000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{
   const deviceId=await authenticateAgent(req,res);if(!deviceId)return;
   const s=sessions.get(req.body?.sessionId),answer=req.body?.answer;
   if(!s||s.deviceId!==deviceId||!s.offer||stale(s))return res.status(404).json({ok:false,error:'Screen session expired.'});
   if(answer?.type!=='answer'||typeof answer.sdp!=='string'||answer.sdp.length>500000)return res.status(400).json({ok:false,error:'Invalid WebRTC answer.'});
   s.answer=answer;s.updatedAt=Date.now();
   return res.json({ok:true});
  }catch(_){return res.status(503).json({ok:false,error:'Could not publish the WebRTC answer.'})}
 });
}
module.exports={installWebRtcSignalRoutes};
