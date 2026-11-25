'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { generatePairingCode, hashEnrollmentCode, hashLegacyPairingCode } = require('./agent/pairing-code');
const { isDeviceOnline } = require('./agent/device-status');
const { getClientAddress } = require('./agent/client-address');
const app = express();
const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const appOrigin = (process.env.APP_ORIGIN || '').replace(/\/+$/, '');
const missingSupabaseConfig = [];
if (!/^https:\/\/.+\.supabase\.co\/?$/.test(supabaseUrl)) missingSupabaseConfig.push('SUPABASE_URL');
if (!supabaseAnonKey || /YOUR_SUPABASE/i.test(supabaseAnonKey)) missingSupabaseConfig.push('SUPABASE_ANON_KEY');
if (!serviceKey || /YOUR_SUPABASE/i.test(serviceKey)) missingSupabaseConfig.push('SUPABASE_SERVICE_ROLE_KEY');
if (missingSupabaseConfig.length) {
  console.warn('Configuration incomplete: ' + missingSupabaseConfig.join(', ') + '. Public configuration is disabled; /health remains available.');
} else {
  console.log('Supabase configuration loaded. Service-role credentials remain server-side.');
}
const supabaseAuth = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;
const supabaseAdmin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;
app.disable('x-powered-by');
app.use(express.json({ limit: '1100kb', strict: true }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:["'self'"],
      scriptSrc:["'self'","'unsafe-inline'",'https://esm.sh'],
      styleSrc:["'self'","'unsafe-inline'"],
      imgSrc:["'self'",'data:','blob:','https:'],
      connectSrc:["'self'",'http://127.0.0.1:32145','https://*.supabase.co','wss://*.supabase.co'],
      frameAncestors:["'none'"],
      baseUri:["'self'"],
      formAction:["'self'"]
    }
  },
  crossOriginEmbedderPolicy:false
}));
app.use((req,res,next)=>{
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  next();
});
app.use((req,res,next)=>{
  if (appOrigin) {
    const origin = req.get('origin');
    if (origin) {
      if (origin === appOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary','Origin');
      } else {
        return res.status(403).json({ok:false,error:'Cross-origin access is not allowed.'});
      }
    }
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, DELETE, OPTIONS');
    return res.status(204).end();
  }
  next();
});
const rateWindows = new Map();
function rateLimit(max, windowMs, scope = req=>getClientAddress(req)) {
  return (req,res,next)=>{
    const key=scope(req)+':'+req.path;
    const now=Date.now();
    const window=rateWindows.get(key);
    if (!window || now-window.startedAt>windowMs) {
      rateWindows.set(key,{startedAt:now,count:1});
      return next();
    }
    window.count++;
    if (window.count>max) return res.status(429).json({ok:false,error:'Too many requests. Please wait and try again.'});
    next();
  };
}
setInterval(()=>{const cutoff=Date.now()-15*60*1000;for(const [key,value] of rateWindows)if(value.startedAt<cutoff)rateWindows.delete(key)},15*60*1000).unref();
app.get('/health',(req,res)=>res.status(200).json({ok:true,service:'Phone Bridge Cloud',version:'1.0.0'}));
app.get('/config',(req,res)=>{
  const url=process.env.SUPABASE_URL||'';
  const key=process.env.SUPABASE_ANON_KEY||'';
  if(missingSupabaseConfig.length)return res.status(503).json({ready:false,message:'Cloud authentication is not configured. Missing or invalid: '+missingSupabaseConfig.join(', ')+'.'});
  res.setHeader('Cache-Control','no-store');
  res.json({ready:true,supabaseUrl:url,supabaseAnonKey:key});
});
app.get('/api/account', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if (!supabaseAuth) return res.status(503).json({ ok:false, error:'Authentication service is not configured.' });
  const header = req.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  if (!match) return res.status(401).json({ ok:false, error:'Sign-in required.' });
  try {
    const { data, error } = await supabaseAuth.auth.getUser(match[1]);
    if (error || !data.user) return res.status(401).json({ ok:false, error:'Session is invalid or expired.' });
    return res.json({ ok:true, user:{ id:data.user.id, email:data.user.email || null } });
  } catch (_) {
    return res.status(503).json({ ok:false, error:'Authentication service is temporarily unavailable.' });
  }
});
async function requireOwner(req, res) {
  if (!supabaseAuth) { res.status(503).json({ ok:false, error:'Authentication service is not configured.' }); return null; }
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.get('authorization') || '');
  if (!match) { res.status(401).json({ ok:false, error:'Sign-in required.' }); return null; }
  try {
    const { data, error } = await supabaseAuth.auth.getUser(match[1]);
    if (error || !data.user) { res.status(401).json({ ok:false, error:'Session is invalid or expired.' }); return null; }
    return data.user;
  } catch (_) {
    res.status(503).json({ ok:false, error:'Authentication service is temporarily unavailable.' });
    return null;
  }
}

// Owner-scoped device list for the main PhoneBridge workspace.
app.get('/api/devices', rateLimit(60,60*1000), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user = await requireOwner(req,res);
  if (!user) return;
  if (!supabaseAdmin) return res.status(503).json({ok:false,error:'Device service is not configured.'});
  try {
    const {data:devices,error} = await supabaseAdmin.from('devices').select('id,name,device_type,created_at,device_agents(last_seen_at,enabled)').eq('user_id',user.id).order('created_at',{ascending:false});
    if(error) throw error;
    const now=Date.now();
    return res.json({ok:true,devices:(devices||[]).map(d=>{
      const agent=Array.isArray(d.device_agents)?d.device_agents[0]:d.device_agents;
      const seen=agent?.last_seen_at||null;
      return {id:d.id,name:d.name,deviceType:d.device_type,createdAt:d.created_at,lastSeenAt:seen,connected:isDeviceOnline(agent?.enabled,seen,now)};
    })});
  } catch (_) { return res.status(503).json({ok:false,error:'Could not load devices. Check the relay database migrations.'}); }
});
// Owner-scoped device management. Device IDs are never accepted without an authenticated owner check.
app.patch('/api/devices/:deviceId', rateLimit(20,10*60*1000), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);
  if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device service is not configured.'});
  const deviceId=req.params.deviceId;
  const name=typeof req.body?.name==='string'?req.body.name.trim():'';
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId))return res.status(400).json({ok:false,error:'Choose a valid device.'});
  if(!name||name.length>80)return res.status(400).json({ok:false,error:'Device name must be between 1 and 80 characters.'});
  try{
    const {data,error}=await supabaseAdmin.from('devices').update({name}).eq('id',deviceId).eq('user_id',user.id).select('id,name').maybeSingle();
    if(error)throw error;
    if(!data)return res.status(404).json({ok:false,error:'That device was not found in your account.'});
    return res.json({ok:true,device:{id:data.id,name:data.name}});
  }catch(_){return res.status(503).json({ok:false,error:'Could not rename this device.'});}
});
app.delete('/api/devices/:deviceId', rateLimit(10,10*60*1000), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);
  if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device service is not configured.'});
  const deviceId=req.params.deviceId;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId))return res.status(400).json({ok:false,error:'Choose a valid device.'});
  try{
    const {data,error}=await supabaseAdmin.from('devices').delete().eq('id',deviceId).eq('user_id',user.id).select('id').maybeSingle();
    if(error)throw error;
    if(!data)return res.status(404).json({ok:false,error:'That device was not found in your account.'});
    return res.json({ok:true,revoked:true});
  }catch(_){return res.status(503).json({ok:false,error:'Could not revoke this device.'});}
});

// Owner creates a short-lived six-digit pairing code. Only its hash is stored.
app.post('/api/enrollments', rateLimit(10,10*60*1000), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user = await requireOwner(req,res);
  if (!user) return;
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Server-side device enrollment is not configured.' });
  const deviceName = typeof req.body?.deviceName === 'string' ? req.body.deviceName.trim() : '';
  if (!deviceName || deviceName.length > 80) return res.status(400).json({ ok:false, error:'Device name must be between 1 and 80 characters.' });
  try {
    const { error:cleanupError } = await supabaseAdmin.from('device_enrollments').delete().lt('expires_at',new Date().toISOString());
    if (cleanupError) throw cleanupError;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    for (let attempt=0; attempt<5; attempt++) {
      const code = generatePairingCode();
      const codeHash = hashEnrollmentCode(code,serviceKey);
      const { error } = await supabaseAdmin.from('device_enrollments').insert({ user_id:user.id, code_hash:codeHash, device_name:deviceName, expires_at:expiresAt });
      if (!error) return res.status(201).json({ ok:true, pairingCode:code, enrollmentCode:code, expiresAt, expiresInSeconds:300 });
      if (error.code !== '23505') throw error;
    }
    throw new Error('Could not generate a unique pairing code.');
  } catch (_) {
    return res.status(503).json({ ok:false, error:'Could not create a pairing code. Check that the relay database migration has been applied.' });
  }
});

// The computer connector creates a short-lived ticket. The signed-in phone approves it.
app.post('/api/enrollments/approve', rateLimit(8,10*60*1000), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res); if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Pairing service is not configured.'});
  const code=typeof req.body?.code==='string'?req.body.code.trim():'';
  if(!/^\d{6}$/.test(code))return res.status(400).json({ok:false,error:'Enter the six-digit code shown on your computer.'});
  try{
    const codeHash=hashEnrollmentCode(code,serviceKey);
    const {data:ticket,error}=await supabaseAdmin.from('device_enrollments').select('id').eq('user_id',user.id).eq('code_hash',codeHash).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle();
    if(error)throw error;
    if(!ticket)return res.status(404).json({ok:false,error:'That code is invalid or has expired.'});
    const now=new Date().toISOString();
    const {data:approved,error:approveError}=await supabaseAdmin.from('device_enrollments').update({approved_at:now}).eq('id',ticket.id).eq('user_id',user.id).is('approved_at',null).is('consumed_at',null).gt('expires_at',now).select('id').maybeSingle();
    if(approveError)throw approveError;
    if(!approved)return res.status(409).json({ok:false,error:'This code was already approved or expired.'});
    return res.json({ok:true,approved:true});
  }catch(_){return res.status(503).json({ok:false,error:'Could not approve this computer. Try again.'});}
});

// The background connector polls this endpoint until the phone approves its ticket.
app.post('/api/agent/enrollment-status', rateLimit(180,10*60*1000), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Pairing service is not configured.'});
  const code=typeof req.body?.code==='string'?req.body.code:'';
  if(!/^\d{6}$/.test(code))return res.status(400).json({ok:false,error:'Invalid pairing request.'});
  try{
    const {data:ticket,error}=await supabaseAdmin.from('device_enrollments').select('approved_at,expires_at,consumed_at').eq('code_hash',hashEnrollmentCode(code,serviceKey)).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle();
    if(error)throw error;
    if(!ticket)return res.json({ok:true,status:'expired'});
    return res.json({ok:true,status:ticket.approved_at?'approved':'waiting'});
  }catch(_){return res.status(503).json({ok:false,error:'Could not check pairing approval.'});}
});

// Task execution is intentionally disabled in the customer workspace.
app.post('/api/commands', rateLimit(30,10*60*1000), (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  return res.status(410).json({ok:false,error:'Computer tasks are not enabled in this PhoneBridge workspace.'});
});

// Authenticate paired agents with their per-device bearer credential.
const agentRateScope=req=>{
  const token=/^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization')||'')?.[1]||'';
  return token?'agent:'+crypto.createHash('sha256').update(token).digest('hex'):getClientAddress(req);
};
async function recordAgentHeartbeat(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Device broker is not configured.' });
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
  const token = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization') || '')?.[1] || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId) || !token) return res.status(401).json({ ok:false, error:'Device authentication required.' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const now=new Date().toISOString();
    const {data,error}=await supabaseAdmin.from('device_agents').update({last_seen_at:now})
      .eq('device_id',deviceId).eq('token_hash',tokenHash).eq('enabled',true).select('device_id').maybeSingle();
    if (error) throw error;
    if(!data)return res.status(401).json({ok:false,error:'Device authentication failed.'});
    return res.json({ok:true,lastSeenAt:now});
  } catch (error) {
    return res.status(503).json({ok:false,error:'Could not update computer status.'});
  }
}
app.post('/api/agent/heartbeat', rateLimit(300,60*1000), rateLimit(60,60*1000,agentRateScope), recordAgentHeartbeat);
// Compatibility route for already-installed Agents; it now only updates status.
app.post('/api/agent/commands/claim', rateLimit(300,60*1000), rateLimit(60,60*1000,agentRateScope), recordAgentHeartbeat);

app.post('/api/agent/commands/:commandId/result', rateLimit(300,60*1000), rateLimit(60,60*1000,agentRateScope), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  return res.status(410).json({ok:false,error:'Computer task execution is not enabled in this PhoneBridge workspace.'});
});

// Windows agent redeems a one-time pairing code for a long-lived per-device bearer token.
app.post('/api/agent/enroll', rateLimit(5,10*60*1000), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Device enrollment service is not configured.' });
  const code = typeof req.body?.enrollmentCode === 'string' ? req.body.enrollmentCode : '';
  const isPairingCode=/^\d{6}$/.test(code);
  if (!isPairingCode && !/^[A-Za-z0-9_-]{40,50}$/.test(code)) return res.status(400).json({ ok:false, error:'Enter the six-digit pairing code shown in PhoneBridge.' });
  const codeHash = hashEnrollmentCode(code,serviceKey);
  const previousDeviceId=typeof req.body?.previousDeviceId==='string'?req.body.previousDeviceId:'';
  const requestedDeviceName=typeof req.body?.deviceName==='string'?req.body.deviceName.trim():'';
  if(previousDeviceId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previousDeviceId))return res.status(400).json({ok:false,error:'Saved device identity is invalid.'});
  if(requestedDeviceName.length>80)return res.status(400).json({ok:false,error:'Computer name must be 80 characters or fewer.'});
  try {
    let {data:ticket,error:findError}=await supabaseAdmin.from('device_enrollments').select('id,user_id,device_name,expires_at,consumed_at,approved_at').eq('code_hash',codeHash).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle();
    if(findError)throw findError;
    // Accept six-digit codes issued by the immediately previous release while a
    // rolling deployment is in progress; all newly issued codes use keyed HMAC.
    if(!ticket&&isPairingCode){const legacy=await supabaseAdmin.from('device_enrollments').select('id,user_id,device_name,expires_at,consumed_at,approved_at').eq('code_hash',hashLegacyPairingCode(code)).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle();if(legacy.error)throw legacy.error;ticket=legacy.data;}
    if (!ticket) return res.status(401).json({ ok:false, error:'Invalid or expired pairing code.' });
    if (!ticket.approved_at) return res.status(403).json({ok:false,error:'Open PhoneBridge on your phone and approve this computer first.'});
    const deviceName=requestedDeviceName||ticket.device_name;
    const now = new Date().toISOString();
    const { data:claimed, error:claimError } = await supabaseAdmin.from('device_enrollments').update({ consumed_at:now }).eq('id',ticket.id).is('consumed_at',null).gt('expires_at',now).select('id').maybeSingle();
    if (claimError || !claimed) return res.status(409).json({ ok:false, error:'Pairing code has already been used or expired.' });
    const agentToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(agentToken).digest('hex');
    let deviceId='';
    if(previousDeviceId){
      const {data:existing,error:lookupError}=await supabaseAdmin.from('devices').select('id').eq('id',previousDeviceId).eq('user_id',ticket.user_id).maybeSingle();
      if(lookupError)throw lookupError;
      if(existing){
        deviceId=existing.id;
        const {error:updateDeviceError}=await supabaseAdmin.from('devices').update({name:deviceName,device_type:'windows_agent'}).eq('id',deviceId).eq('user_id',ticket.user_id);
        if(updateDeviceError)throw updateDeviceError;
        const {data:rotated,error:rotateError}=await supabaseAdmin.from('device_agents').update({token_hash:tokenHash,enabled:true,last_seen_at:null}).eq('device_id',deviceId).select('device_id').maybeSingle();
        if(rotateError)throw rotateError;
        if(!rotated){const {error:insertAgentError}=await supabaseAdmin.from('device_agents').insert({device_id:deviceId,token_hash:tokenHash,enabled:true});if(insertAgentError)throw insertAgentError;}
      }
    }
    if(!deviceId){
      const {data:device,error:deviceError}=await supabaseAdmin.from('devices').insert({user_id:ticket.user_id,name:deviceName,device_type:'windows_agent'}).select('id').single();
      if(deviceError||!device)throw deviceError||new Error('Device record was not created.');
      deviceId=device.id;
      const {error:agentError}=await supabaseAdmin.from('device_agents').insert({device_id:deviceId,token_hash:tokenHash,enabled:true});
      if(agentError){await supabaseAdmin.from('devices').delete().eq('id',deviceId);throw agentError;}
    }
    return res.status(201).json({ ok:true, deviceId, deviceName, agentToken });
  } catch (_) {
    return res.status(503).json({ ok:false, error:'Device enrollment could not be completed.' });
  }
});

// Unknown legacy/local APIs must not fall through to the SPA and look successful.
app.use('/api',(req,res)=>res.status(501).json({ok:false,error:'This API is not available in the cloud application yet.'}));

app.use(express.static(path.join(__dirname,'public'),{
  extensions:['html'],
  maxAge:process.env.NODE_ENV==='production'?'1h':0,
  setHeaders(res,filePath){if(path.basename(filePath)==='index.html')res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');if(path.basename(filePath)==='dashboard.js')res.setHeader('Cache-Control','no-cache')}
}));
app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ok:false,error:'Request body must be valid JSON.'});
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ok:false,error:'Request body is too large.'});
  }
  console.error('Unhandled server error:', err instanceof Error ? err.message : 'Unknown error');
  return res.status(500).json({ok:false,error:'The request could not be completed.'});
});
app.listen(port,'0.0.0.0',()=>console.log('Phone Bridge Cloud listening on '+port));
