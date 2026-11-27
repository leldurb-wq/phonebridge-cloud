'use strict';

function installScreenRelayRoutes({app,crypto,supabaseAdmin,requireOwner,rateLimit,agentRateScope}) {
  const frames=new Map();
  const tickets=new Map();
  app.post('/api/agent/screen/frame',rateLimit(240,60000),rateLimit(180,60000,agentRateScope),async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const deviceId=typeof req.body?.deviceId==='string'?req.body.deviceId:'';
    const token=/^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization')||'')?.[1]||'';
    const image=typeof req.body?.imageBase64==='string'?req.body.imageBase64:'';
    if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Screen relay is not configured.'});
    if(!deviceId||!token||image.length>1050000||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image))return res.status(400).json({ok:false,error:'Invalid screen frame.'});
    try{
      const hash=crypto.createHash('sha256').update(token).digest('hex');
      const {data,error}=await supabaseAdmin.from('device_agents').select('device_id').eq('device_id',deviceId).eq('token_hash',hash).eq('enabled',true).maybeSingle();
      if(error)throw error;if(!data)return res.status(401).json({ok:false,error:'Device authentication failed.'});
      const frame=Buffer.from(image,'base64');
      if(frame.length<100||frame.length>780000||frame[0]!==255||frame[1]!==216)return res.status(400).json({ok:false,error:'Invalid JPEG frame.'});
      frames.set(deviceId,{frame,at:Date.now()});return res.json({ok:true});
    }catch(_){return res.status(503).json({ok:false,error:'Could not relay the screen frame.'});}
  });
  app.post('/api/screen/ticket',rateLimit(30,60000),async(req,res)=>{
    res.setHeader('Cache-Control','no-store');const user=await requireOwner(req,res);if(!user)return;
    try{
      const {data,error}=await supabaseAdmin.from('devices').select('id').eq('user_id',user.id);if(error)throw error;
      const candidates=(data||[]).map(d=>({deviceId:d.id,frame:frames.get(d.id)})).filter(item=>item.frame&&Date.now()-item.frame.at<5000).sort((a,b)=>b.frame.at-a.frame.at); if(!candidates.length)return res.status(409).json({ok:false,error:'No live frames from the paired ThinkPad. Start the PhoneBridge Windows connector in your signed-in desktop session.'}); const ticket=crypto.randomBytes(32).toString('base64url');tickets.set(ticket,{userId:user.id,deviceId:candidates[0].deviceId,expiresAt:Date.now()+120000});return res.json({ok:true,ticket});
    }catch(_){return res.status(503).json({ok:false,error:'Could not open the private screen session.'});}
  });
  app.get('/api/screen/frame',rateLimit(600,60000),(req,res)=>{
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, private');
    const ticket=typeof req.query.ticket==='string'?req.query.ticket:'';const grant=tickets.get(ticket);
    if(!grant||grant.expiresAt<Date.now()){tickets.delete(ticket);return res.status(401).json({ok:false,error:'The private screen ticket expired. Reconnect to continue.'});}
    const frame=frames.get(grant.deviceId);
    if(!frame||Date.now()-frame.at>5000)return res.status(503).json({ok:false,error:'Waiting for a fresh ThinkPad screen frame.'});
    const since=Number(req.query.since)||0;
    if(frame.at<=since)return res.status(204).end();
    res.status(200);res.setHeader('Content-Type','image/jpeg');res.setHeader('Content-Length',String(frame.frame.length));res.setHeader('X-PB-Frame-At',String(frame.at));res.setHeader('X-Content-Type-Options','nosniff');
    return res.end(frame.frame);
  });
  app.get('/api/screen/stream',rateLimit(30,60000),(req,res)=>{
    const ticket=typeof req.query.ticket==='string'?req.query.ticket:'';const grant=tickets.get(ticket);
    if(!grant||grant.expiresAt<Date.now()){tickets.delete(ticket);return res.status(401).end();}
    res.status(200);res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, private');res.setHeader('Content-Type','multipart/x-mixed-replace; boundary=phonebridgeframe');res.setHeader('X-Accel-Buffering','no');res.flushHeaders?.();
    let last=0;const send=()=>{if(res.destroyed)return;const f=frames.get(grant.deviceId);if(!f||Date.now()-f.at>5000)return;if(f.at===last)return;last=f.at;res.write('--phonebridgeframe\r\nContent-Type: image/jpeg\r\nContent-Length: '+f.frame.length+'\r\n\r\n');res.write(f.frame);res.write('\r\n');};
    send();const timer=setInterval(send,350);res.on('close',()=>clearInterval(timer));
  });
}

module.exports={installScreenRelayRoutes};