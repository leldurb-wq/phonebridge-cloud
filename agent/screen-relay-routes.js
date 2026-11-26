'use strict';

function installScreenRelayRoutes({app,crypto,supabaseAdmin,requireOwner,rateLimit,agentRateScope}) {
  const frames=new Map();
  const tickets=new Map();
  app.post('/api/agent/screen/frame',rateLimit(180,60000),rateLimit(120,60000,agentRateScope),async(req,res)=>{
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
      const ids=(data||[]).map(d=>d.id).filter(id=>{const f=frames.get(id);return f&&Date.now()-f.at<5000;});
      if(!ids.length)return res.status(409).json({ok:false,error:'No live frames from the paired ThinkPad. Start the PhoneBridge Windows connector in your signed-in desktop session.'});
      const ticket=crypto.randomBytes(32).toString('base64url');tickets.set(ticket,{userId:user.id,deviceId:ids[0],expiresAt:Date.now()+120000});return res.json({ok:true,ticket});
    }catch(_){return res.status(503).json({ok:false,error:'Could not open the private screen session.'});}
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