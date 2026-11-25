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
const allowedOrigins = new Set([...(process.env.APP_ORIGIN || '').split(',').map(origin => origin.trim().replace(/\/+$/, '')).filter(Boolean), 'https://phonebridge.msbundle.store']);
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
      scriptSrc:["'self'","'unsafe-inline'",'https://esm.sh','https://cdn.jsdelivr.net'],
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
  if (allowedOrigins.size) {
    const origin = req.get('origin');
    if (origin) {
      if (allowedOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary','Origin');
      } else {
        return res.status(403).json({ok:false,error:'Cross-origin access is not allowed.'});
      }
    }
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Chunk-SHA256');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE, OPTIONS');
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

// Owner-authenticated cloud file storage. Objects are private and always scoped
// to the signed-in account; the service-role key never leaves this server.
const FILE_BUCKET='user-files';
const FILE_LIMIT=250*1024*1024;
const ACCOUNT_STORAGE_LIMIT=10*1024*1024*1024;
function cleanFileName(value){
  const name=String(value||'').normalize('NFKC').replaceAll(String.fromCharCode(92),'/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g,'_').replace(/^\.+/,'').trim().slice(0,180);
  return name||'upload';
}
async function readUpload(req){
  const chunks=[];let total=0;
  return await new Promise((resolve,reject)=>{
    req.on('data',chunk=>{
      total+=chunk.length;
      if(total>FILE_LIMIT){reject(Object.assign(new Error('Files must be 250 MB or smaller.'),{status:413}));req.resume();return}
      chunks.push(chunk);
    });
    req.on('end',()=>resolve(Buffer.concat(chunks,total)));
    req.on('error',reject);
    req.on('aborted',()=>reject(new Error('Upload was interrupted.')));
  });
}
async function getUserStorageUsage(userId){
  let total=0,from=0;
  while(true){
    const {data,error}=await supabaseAdmin.from('user_files').select('size_bytes').eq('user_id',userId).range(from,from+999);
    if(error)throw error;
    const rows=data||[];total+=rows.reduce((sum,row)=>sum+Number(row.size_bytes||0),0);
    if(rows.length<1000)break;
    from+=1000;
  }
  return total;
}
app.get('/api/files',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  try{
    const {data,error}=await supabaseAdmin.from('user_files').select('id,original_name,mime_type,size_bytes,folder,is_favorite,created_at,updated_at').eq('user_id',user.id).order('updated_at',{ascending:false}).limit(2000);
    if(error)throw error;
    const files=(data||[]).map(f=>({id:f.id,name:f.original_name,size:Number(f.size_bytes||0),type:f.mime_type||'application/octet-stream',folder:f.folder||'',favorite:!!f.is_favorite,modified:Date.parse(f.updated_at||f.created_at)}));
    const folders=[...new Set(files.map(f=>f.folder).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    const used=await getUserStorageUsage(user.id);
    return res.json({ok:true,files,folders,storage:{used,limit:ACCOUNT_STORAGE_LIMIT}});
  }catch(_){return res.status(503).json({ok:false,error:'Could not load your files from private cloud storage.'});}
});
app.post('/api/upload',rateLimit(30,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  const declared=Number(req.get('content-length')||0);
  if(declared>FILE_LIMIT)return res.status(413).json({ok:false,error:'Files must be 250 MB or smaller.'});
  try{
    const name=cleanFileName(req.query.name);
    const type=String(req.get('content-type')||'application/octet-stream').split(';')[0].slice(0,120);
    const buffer=await readUpload(req);
    if(!buffer.length)return res.status(400).json({ok:false,error:'Choose a file before uploading.'});
    const used=await getUserStorageUsage(user.id);
    if(used+buffer.length>ACCOUNT_STORAGE_LIMIT)return res.status(413).json({ok:false,error:'Your 10 GB PhoneBridge storage limit would be exceeded.'});
    const id=crypto.randomUUID();
    const objectPath=user.id+'/'+id+'/'+name;
    const {error:uploadError}=await supabaseAdmin.storage.from(FILE_BUCKET).upload(objectPath,buffer,{contentType:type,upsert:false});
    if(uploadError)throw uploadError;
    const now=new Date().toISOString();
    const {data,error}=await supabaseAdmin.from('user_files').insert({id,user_id:user.id,object_path:objectPath,original_name:name,mime_type:type,size_bytes:buffer.length,folder:'',created_at:now,updated_at:now}).select('id').single();
    if(error){await supabaseAdmin.storage.from(FILE_BUCKET).remove([objectPath]);throw error}
    return res.status(201).json({ok:true,id:data.id,name,size:buffer.length});
  }catch(error){
    if(error.status)return res.status(error.status).json({ok:false,error:error.message});
    return res.status(503).json({ok:false,error:'Upload failed. Check your private storage bucket and try again.'});
  }
});
app.get('/api/download',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  const id=String(req.query.id||'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({ok:false,error:'Choose a valid file.'});
  try{
    const {data:file,error}=await supabaseAdmin.from('user_files').select('object_path,original_name,mime_type,size_bytes').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!file)return res.status(404).json({ok:false,error:'That file was not found in your account.'});
    const {data,error:downloadError}=await supabaseAdmin.storage.from(FILE_BUCKET).download(file.object_path);
    if(downloadError||!data)throw downloadError||new Error('File data is missing.');
    const buffer=Buffer.from(await data.arrayBuffer());
    const safeName=cleanFileName(file.original_name);
    res.setHeader('Content-Type',file.mime_type||'application/octet-stream');
    res.setHeader('Content-Length',String(buffer.length));
    res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(safeName));
    return res.status(200).send(buffer);
  }catch(_){return res.status(503).json({ok:false,error:'Could not download this file. Please try again.'});}
});
app.patch('/api/files',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  const id=String(req.body?.id||'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({ok:false,error:'Choose a valid file.'});
  const changes={updated_at:new Date().toISOString()};
  if(typeof req.body?.favorite==='boolean')changes.is_favorite=req.body.favorite;
  if(typeof req.body?.folder==='string'){
    const folder=req.body.folder.trim();
    if(folder.length>80||/[\\\\/\\x00-\\x1f]/.test(folder))return res.status(400).json({ok:false,error:'Folder names must be 80 characters or fewer and cannot contain slashes.'});
    changes.folder=folder;
  }
  if(Object.keys(changes).length===1)return res.status(400).json({ok:false,error:'No file changes were supplied.'});
  try{
    const {data,error}=await supabaseAdmin.from('user_files').update(changes).eq('id',id).eq('user_id',user.id).select('id').maybeSingle();
    if(error)throw error;
    if(!data)return res.status(404).json({ok:false,error:'That file was not found in your account.'});
    return res.json({ok:true});
  }catch(_){return res.status(503).json({ok:false,error:'Could not update this file.'});}
});
app.delete('/api/files',rateLimit(20,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  const id=String(req.query.id||'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({ok:false,error:'Choose a valid file.'});
  try{
    const {data:file,error:findError}=await supabaseAdmin.from('user_files').select('object_path').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(findError)throw findError;
    if(!file)return res.status(404).json({ok:false,error:'That file was not found in your account.'});
    const {error:removeError}=await supabaseAdmin.storage.from(FILE_BUCKET).remove([file.object_path]);
    if(removeError)throw removeError;
    const {error:deleteError}=await supabaseAdmin.from('user_files').delete().eq('id',id).eq('user_id',user.id);
    if(deleteError)throw deleteError;
    return res.json({ok:true,deleted:true});
  }catch(_){return res.status(503).json({ok:false,error:'Could not delete this file from private storage.'});}
});

// Signed-in browser clients are the selectable phone destinations for PC-to-phone transfers.
const TRANSFER_CLIENT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
app.post('/api/transfer-clients/register',rateLimit(30,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  const id=String(req.body?.id||''),deviceType=req.body?.deviceType==='phone'?'phone':'computer';
  const label=String(req.body?.label||'PhoneBridge device').trim().slice(0,80);
  if(!TRANSFER_CLIENT_ID.test(id)||!label)return res.status(400).json({ok:false,error:'Invalid PhoneBridge client identity.'});
  try{
    const {error}=await supabaseAdmin.from('phone_transfer_clients').upsert({id,user_id:user.id,device_type:deviceType,label,last_seen_at:new Date().toISOString()},{onConflict:'user_id,id'});
    if(error)throw error;
    return res.json({ok:true,client:{id,deviceType,label}});
  }catch(_){return res.status(503).json({ok:false,error:'Could not register this PhoneBridge device. Apply migration 006.'});}
});
app.post('/api/transfer-clients/heartbeat',rateLimit(120,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const id=String(req.body?.id||'');
  if(!TRANSFER_CLIENT_ID.test(id))return res.status(400).json({ok:false,error:'Invalid PhoneBridge client.'});
  try{
    const {data,error}=await supabaseAdmin.from('phone_transfer_clients').update({last_seen_at:new Date().toISOString()}).eq('id',id).eq('user_id',user.id).select('id').maybeSingle();
    if(error)throw error;
    return res.json({ok:true,registered:!!data});
  }catch(_){return res.status(503).json({ok:false,error:'Could not refresh this device connection.'});}
});
app.get('/api/transfer-clients',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  try{
    const {data,error}=await supabaseAdmin.from('phone_transfer_clients').select('id,label,device_type,last_seen_at').eq('user_id',user.id).eq('device_type','phone').order('last_seen_at',{ascending:false}).limit(20);
    if(error)throw error;
    const now=Date.now();
    return res.json({ok:true,phones:(data||[]).map(x=>({...x,connected:now-Date.parse(x.last_seen_at)<90000}))});
  }catch(_){return res.status(503).json({ok:false,error:'Could not load connected phones.'});}
});

// Resumable bidirectional relay. Each request carries one verified 8 MiB chunk.
const PC_TRANSFER_CHUNK=8*1024*1024;
const PC_TRANSFER_MAX=2*1024*1024*1024;
const PC_TRANSFER_BUCKET='transfer-chunks';
app.post('/api/transfers',rateLimit(20,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  const deviceId=String(req.body?.deviceId||''),direction=req.body?.direction==='pc_to_phone'?'pc_to_phone':'phone_to_pc',targetClientId=String(req.body?.targetClientId||''),name=cleanFileName(req.body?.name),size=Number(req.body?.size),type=String(req.body?.type||'application/octet-stream').slice(0,120);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId))return res.status(400).json({ok:false,error:'Choose the connected ThinkPad.'});
  if(!Number.isSafeInteger(size)||size<1||size>PC_TRANSFER_MAX)return res.status(413).json({ok:false,error:'Choose a file up to 2 GB.'});
  try{
    const {data:device,error:deviceError}=await supabaseAdmin.from('devices').select('id,device_agents(enabled,last_seen_at)').eq('id',deviceId).eq('user_id',user.id).maybeSingle();
    if(deviceError)throw deviceError;
    const agent=Array.isArray(device?.device_agents)?device.device_agents[0]:device?.device_agents;
    if(!device||!agent?.enabled||!isDeviceOnline(agent.enabled,agent.last_seen_at))return res.status(409).json({ok:false,error:'The ThinkPad connector is offline. Reconnect it and try again.'});
    if(direction==='pc_to_phone'){
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetClientId))return res.status(400).json({ok:false,error:'Choose the phone receiving this file.'});
      const {data:client,error:clientError}=await supabaseAdmin.from('phone_transfer_clients').select('id,last_seen_at,device_type').eq('id',targetClientId).eq('user_id',user.id).eq('device_type','phone').maybeSingle();
      if(clientError)throw clientError;
      if(!client||Date.now()-Date.parse(client.last_seen_at)>90000)return res.status(409).json({ok:false,error:'That phone is not currently connected. Open PhoneBridge on the phone and try again.'});
    }
    const {count,error:activeError}=await supabaseAdmin.from('phone_transfers').select('id',{count:'exact',head:true}).eq('user_id',user.id).in('status',['uploading','queued','receiving']);
    if(activeError)throw activeError;
    if(count>=3)return res.status(429).json({ok:false,error:'Finish or cancel an existing transfer before starting another.'});
    const id=crypto.randomUUID(),chunkCount=Math.ceil(size/PC_TRANSFER_CHUNK);
    const {error}=await supabaseAdmin.from('phone_transfers').insert({id,user_id:user.id,device_id:deviceId,target_client_id:direction==='pc_to_phone'?targetClientId:null,direction,file_name:name,mime_type:type,size_bytes:size,chunk_size:PC_TRANSFER_CHUNK,chunk_count:chunkCount,status:'uploading'});
    if(error)throw error;
    return res.status(201).json({ok:true,transfer:{id,name,size,chunkSize:PC_TRANSFER_CHUNK,chunkCount}});
  }catch(_){return res.status(503).json({ok:false,error:'Could not start the PC transfer. Check that migration 005 has been applied.'});}
});
app.put('/api/transfers/:transferId/chunks/:index',rateLimit(400,10*60*1000),express.raw({type:'application/octet-stream',limit:'9mb'}),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  const id=req.params.transferId,index=Number(req.params.index),bytes=req.body;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||!Number.isInteger(index)||index<0||!Buffer.isBuffer(bytes))return res.status(400).json({ok:false,error:'Invalid transfer chunk.'});
  try{
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id,size_bytes,chunk_size,chunk_count,status').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!transfer)return res.status(404).json({ok:false,error:'Transfer not found.'});
    if(transfer.status!=='uploading')return res.status(409).json({ok:false,error:'This transfer is no longer accepting chunks.'});
    if(index>=transfer.chunk_count)return res.status(400).json({ok:false,error:'Chunk index is outside this transfer.'});
    const expected=index===transfer.chunk_count-1?Number(transfer.size_bytes)-index*PC_TRANSFER_CHUNK:PC_TRANSFER_CHUNK;
    if(bytes.length!==expected)return res.status(400).json({ok:false,error:'Chunk length does not match the expected size.'});
    const digest=crypto.createHash('sha256').update(bytes).digest('hex');
    const supplied=String(req.get('x-chunk-sha256')||'');
    if(supplied!==digest)return res.status(400).json({ok:false,error:'Chunk integrity check failed. Please retry this chunk.'});
    const objectPath=user.id+'/'+id+'/'+String(index).padStart(4,'0');
    const {error:uploadError}=await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).upload(objectPath,bytes,{contentType:'application/octet-stream',upsert:true});
    if(uploadError)throw uploadError;
    const {error:rowError}=await supabaseAdmin.from('phone_transfer_chunks').upsert({transfer_id:id,chunk_index:index,object_path:objectPath,size_bytes:bytes.length,sha256:digest},{onConflict:'transfer_id,chunk_index'});
    if(rowError)throw rowError;
    return res.json({ok:true,index,received:bytes.length});
  }catch(_){return res.status(503).json({ok:false,error:'Could not store this transfer chunk. Retry the chunk.'});}
});
app.post('/api/transfers/:transferId/complete',rateLimit(30,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  const id=req.params.transferId;
  try{
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id,chunk_count,status').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!transfer)return res.status(404).json({ok:false,error:'Transfer not found.'});
    if(transfer.status==='queued'||transfer.status==='receiving')return res.json({ok:true,status:transfer.status});
    if(transfer.status!=='uploading')return res.status(409).json({ok:false,error:'This transfer cannot be queued.'});
    const {data:chunks,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('chunk_index').eq('transfer_id',id);
    if(chunkError)throw chunkError;
    if((chunks||[]).length!==transfer.chunk_count)return res.status(409).json({ok:false,error:'Some chunks are still missing. Retry the upload.'});
    const {data:queued,error:queueError}=await supabaseAdmin.from('phone_transfers').update({status:'queued',updated_at:new Date().toISOString()}).eq('id',id).eq('user_id',user.id).eq('status','uploading').select('id').maybeSingle();
    if(queueError)throw queueError;
    if(!queued)return res.status(409).json({ok:false,error:'Transfer state changed. Refresh and try again.'});
    return res.json({ok:true,status:'queued'});
  }catch(_){return res.status(503).json({ok:false,error:'Could not queue the transfer.'});}
});
app.delete('/api/transfers/:transferId',rateLimit(20,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  try{
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id,status').eq('id',req.params.transferId).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!transfer)return res.status(404).json({ok:false,error:'Transfer not found.'});
    if(transfer.status!=='uploading')return res.status(409).json({ok:false,error:'Only an upload that has not been queued can be cancelled.'});
    const {data:chunks}=await supabaseAdmin.from('phone_transfer_chunks').select('object_path').eq('transfer_id',transfer.id);
    const paths=(chunks||[]).map(c=>c.object_path);
    const {data:cancelled,error:cancelError}=await supabaseAdmin.from('phone_transfers').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',transfer.id).eq('user_id',user.id).eq('status','uploading').select('id').maybeSingle();
    if(cancelError)throw cancelError;
    if(!cancelled)return res.status(409).json({ok:false,error:'Transfer state changed before cancellation.'});
    if(paths.length)await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).remove(paths);
    await supabaseAdmin.from('phone_transfer_chunks').delete().eq('transfer_id',transfer.id);
    return res.json({ok:true,cancelled:true});
  }catch(_){return res.status(503).json({ok:false,error:'Could not cancel this upload.'});}
});
// Phone inbox: only the registered phone client can claim and receive its own deliveries.
app.get('/api/transfers/inbox',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const clientId=String(req.query.clientId||'');
  if(!TRANSFER_CLIENT_ID.test(clientId))return res.status(400).json({ok:false,error:'PhoneBridge phone identity is missing.'});
  try{
    const {data:client,error:clientError}=await supabaseAdmin.from('phone_transfer_clients').select('id').eq('id',clientId).eq('user_id',user.id).eq('device_type','phone').maybeSingle();
    if(clientError)throw clientError;
    if(!client)return res.status(403).json({ok:false,error:'This phone is not registered to your account.'});
    const {data,error}=await supabaseAdmin.from('phone_transfers').select('id,file_name,mime_type,size_bytes,chunk_size,chunk_count,status,created_at,updated_at').eq('user_id',user.id).eq('target_client_id',clientId).eq('direction','pc_to_phone').in('status',['queued','receiving']).order('created_at',{ascending:true}).limit(3);
    if(error)throw error;
    return res.json({ok:true,transfers:(data||[]).map(x=>({id:x.id,name:x.file_name,type:x.mime_type,size:Number(x.size_bytes),chunkSize:x.chunk_size,chunkCount:x.chunk_count,status:x.status,createdAt:x.created_at,updatedAt:x.updated_at}))});
  }catch(_){return res.status(503).json({ok:false,error:'Could not load this phone inbox.'});}
});
app.post('/api/transfers/:transferId/receive',rateLimit(120,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const clientId=String(req.body?.clientId||''),status=String(req.body?.status||'');
  if(!TRANSFER_CLIENT_ID.test(clientId)||!['queued','receiving','completed','failed'].includes(status))return res.status(400).json({ok:false,error:'Invalid phone delivery update.'});
  try{
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id,status').eq('id',req.params.transferId).eq('user_id',user.id).eq('target_client_id',clientId).eq('direction','pc_to_phone').maybeSingle();
    if(error)throw error;
    if(!transfer)return res.status(404).json({ok:false,error:'This file is not addressed to this phone.'});
    if(transfer.status===status)return res.json({ok:true,status,idempotent:true});
    const allowed=status==='receiving'?['queued','receiving']:['receiving'];
    if(!allowed.includes(transfer.status))return res.status(409).json({ok:false,error:'This delivery is no longer available.'});
    const now=new Date().toISOString();
    const {data,error:updateError}=await supabaseAdmin.from('phone_transfers').update({status,updated_at:now,error_message:status==='completed'?null:String(req.body?.error||(status==='failed'?'Phone could not save the file':'Phone delivery will retry')).slice(0,240),...(status==='completed'?{completed_at:now}:{})}).eq('id',transfer.id).eq('user_id',user.id).eq('target_client_id',clientId).eq('status',transfer.status).select('id').maybeSingle();
    if(updateError)throw updateError;
    if(!data)return res.status(409).json({ok:false,error:'Delivery state changed. Refresh the inbox.'});
    if(status==='failed'){
      const {data:chunks}=await supabaseAdmin.from('phone_transfer_chunks').select('object_path').eq('transfer_id',transfer.id);
      const paths=(chunks||[]).map(c=>c.object_path);
      if(paths.length)await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).remove(paths);
      await supabaseAdmin.from('phone_transfer_chunks').delete().eq('transfer_id',transfer.id);
    }
    return res.json({ok:true,status});
  }catch(_){return res.status(503).json({ok:false,error:'Could not update this phone delivery.'});}
});
app.get('/api/transfers/:transferId/chunks/:index',rateLimit(400,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const index=Number(req.params.index),clientId=String(req.query.clientId||'');
  if(!Number.isInteger(index)||index<0)return res.status(400).json({ok:false,error:'Invalid file chunk.'});
  try{
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id,direction,target_client_id,status,completed_at').eq('id',req.params.transferId).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!transfer)return res.status(404).json({ok:false,error:'File transfer not found.'});
    if(transfer.direction==='pc_to_phone'&&(!TRANSFER_CLIENT_ID.test(clientId)||transfer.target_client_id!==clientId))return res.status(403).json({ok:false,error:'This file belongs to another phone.'});
    if(!['queued','receiving','completed'].includes(transfer.status))return res.status(409).json({ok:false,error:'This file is no longer available.'});
    if(transfer.status==='completed'&&transfer.completed_at&&Date.now()-Date.parse(transfer.completed_at)>24*60*60*1000)return res.status(410).json({ok:false,error:'The temporary transfer copy expired after 24 hours.'});
    const {data:chunk,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('object_path,sha256,size_bytes').eq('transfer_id',transfer.id).eq('chunk_index',index).maybeSingle();
    if(chunkError)throw chunkError;
    if(!chunk)return res.status(404).json({ok:false,error:'File chunk not found.'});
    const {data,error:downloadError}=await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).download(chunk.object_path);
    if(downloadError||!data)throw downloadError||new Error('Chunk is missing.');
    const buffer=Buffer.from(await data.arrayBuffer());
    if(buffer.length!==chunk.size_bytes||crypto.createHash('sha256').update(buffer).digest('hex')!==chunk.sha256)throw new Error('Stored file chunk failed integrity verification.');
    res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',String(buffer.length));res.setHeader('X-Chunk-SHA256',chunk.sha256);
    return res.status(200).send(buffer);
  }catch(_){return res.status(503).json({ok:false,error:'Could not retrieve this file chunk.'});}
});
app.get('/api/transfers',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  try{
    const expiry=new Date(Date.now()-24*60*60*1000).toISOString();
    const {data:old}=await supabaseAdmin.from('phone_transfers').select('id').eq('user_id',user.id).eq('status','completed').lt('completed_at',expiry).limit(20);
    for(const item of old||[]){
      const {data:chunks}=await supabaseAdmin.from('phone_transfer_chunks').select('object_path').eq('transfer_id',item.id);
      const paths=(chunks||[]).map(c=>c.object_path);
      if(paths.length)await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).remove(paths);
      await supabaseAdmin.from('phone_transfer_chunks').delete().eq('transfer_id',item.id);
    }
    const {data,error}=await supabaseAdmin.from('phone_transfers').select('id,direction,target_client_id,file_name,mime_type,size_bytes,status,error_message,created_at,updated_at,completed_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(50);
    if(error)throw error;
    return res.json({ok:true,transfers:(data||[]).map(x=>({id:x.id,direction:x.direction,targetClientId:x.target_client_id,name:x.file_name,type:x.mime_type,size:Number(x.size_bytes),status:x.status,error:x.error_message,createdAt:x.created_at,updatedAt:x.updated_at,completedAt:x.completed_at}))});
  }catch(_){return res.status(503).json({ok:false,error:'Could not load transfer history.'});}
});
app.get('/api/transfers/:transferId',rateLimit(120,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  try{
    const {data,error}=await supabaseAdmin.from('phone_transfers').select('id,file_name,size_bytes,status,error_message,created_at,updated_at,completed_at').eq('id',req.params.transferId).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!data)return res.status(404).json({ok:false,error:'Transfer not found.'});
    return res.json({ok:true,transfer:{id:data.id,name:data.file_name,size:Number(data.size_bytes),status:data.status,error:data.error_message,createdAt:data.created_at,updatedAt:data.updated_at,completedAt:data.completed_at}});
  }catch(_){return res.status(503).json({ok:false,error:'Could not check transfer status.'});}
});

async function requireAgent(req,res,deviceId){
  const token=/^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization')||'')?.[1]||'';
  if(!token||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId||'')){res.status(401).json({ok:false,error:'Device authentication required.'});return null;}
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
  try{
    const {data:agent,error}=await supabaseAdmin.from('device_agents').select('device_id').eq('device_id',deviceId).eq('token_hash',tokenHash).eq('enabled',true).maybeSingle();
    if(error)throw error;
    if(!agent){res.status(401).json({ok:false,error:'Device authentication failed.'});return null;}
    const {data:device,error:deviceError}=await supabaseAdmin.from('devices').select('id,user_id').eq('id',deviceId).maybeSingle();
    if(deviceError)throw deviceError;
    if(!device){res.status(401).json({ok:false,error:'Paired computer no longer exists.'});return null;}
    return {deviceId:device.id,userId:device.user_id};
  }catch(_){res.status(503).json({ok:false,error:'Could not authenticate the computer.'});return null;}
}
app.post('/api/agent/transfers/claim',rateLimit(300,60*1000),rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  const agent=await requireAgent(req,res,String(req.body?.deviceId||''));if(!agent)return;
  try{
    const staleBefore=new Date(Date.now()-2*60*1000).toISOString();
    const {error:staleError}=await supabaseAdmin.from('phone_transfers').update({status:'queued',updated_at:new Date().toISOString()}).eq('device_id',agent.deviceId).eq('direction','phone_to_pc').eq('status','receiving').lt('updated_at',staleBefore);
    if(staleError)throw staleError;
    const {data:rows,error}=await supabaseAdmin.from('phone_transfers').select('id,file_name,mime_type,size_bytes,chunk_size,chunk_count').eq('device_id',agent.deviceId).eq('direction','phone_to_pc').eq('status','queued').order('created_at',{ascending:true}).limit(1);
    if(error)throw error;
    const transfer=rows?.[0];if(!transfer)return res.json({ok:true,transfer:null});
    const {data:claimed,error:claimError}=await supabaseAdmin.from('phone_transfers').update({status:'receiving',updated_at:new Date().toISOString(),error_message:null}).eq('id',transfer.id).eq('device_id',agent.deviceId).eq('direction','phone_to_pc').eq('status','queued').select('id,file_name,mime_type,size_bytes,chunk_size,chunk_count').maybeSingle();
    if(claimError)throw claimError;
    if(!claimed)return res.json({ok:true,transfer:null});
    const {data:chunks,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('chunk_index,size_bytes,sha256').eq('transfer_id',transfer.id).order('chunk_index',{ascending:true});
    if(chunkError)throw chunkError;
    return res.json({ok:true,transfer:{id:claimed.id,fileName:claimed.file_name,mimeType:claimed.mime_type,sizeBytes:Number(claimed.size_bytes),chunkSize:claimed.chunk_size,chunkCount:claimed.chunk_count,chunks:(chunks||[]).map(c=>({index:c.chunk_index,sizeBytes:c.size_bytes,sha256:c.sha256}))}});
  }catch(_){return res.status(503).json({ok:false,error:'Could not claim the next file transfer.'});}
});
app.get('/api/agent/transfers/:transferId/chunks/:index',rateLimit(400,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  const agent=await requireAgent(req,res,String(req.query.deviceId||''));if(!agent)return;
  const index=Number(req.params.index);
  if(!Number.isInteger(index)||index<0)return res.status(400).json({ok:false,error:'Invalid chunk index.'});
  try{
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id').eq('id',req.params.transferId).eq('device_id',agent.deviceId).eq('direction','phone_to_pc').eq('status','receiving').maybeSingle();
    if(error)throw error;
    if(!transfer)return res.status(404).json({ok:false,error:'Transfer not found or no longer active.'});
    const {data:chunk,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('object_path,sha256,size_bytes').eq('transfer_id',transfer.id).eq('chunk_index',index).maybeSingle();
    if(chunkError)throw chunkError;
    if(!chunk)return res.status(404).json({ok:false,error:'Transfer chunk not found.'});
    const {data,error:downloadError}=await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).download(chunk.object_path);
    if(downloadError||!data)throw downloadError||new Error('Chunk is missing.');
    const buffer=Buffer.from(await data.arrayBuffer());
    if(buffer.length!==chunk.size_bytes||crypto.createHash('sha256').update(buffer).digest('hex')!==chunk.sha256)throw new Error('Stored chunk failed integrity verification.');
    const {error:touchError}=await supabaseAdmin.from('phone_transfers').update({updated_at:new Date().toISOString()}).eq('id',transfer.id).eq('device_id',agent.deviceId).eq('status','receiving');
    if(touchError)throw touchError;
    res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',String(buffer.length));res.setHeader('X-Chunk-SHA256',chunk.sha256);
    return res.status(200).send(buffer);
  }catch(_){return res.status(503).json({ok:false,error:'Could not retrieve this file chunk.'});}
});
app.post('/api/agent/transfers/:transferId/complete',rateLimit(60,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Transfer service is not configured.'});
  const agent=await requireAgent(req,res,String(req.body?.deviceId||''));if(!agent)return;
  const status=req.body?.status;
  if(!['completed','failed','queued'].includes(status))return res.status(400).json({ok:false,error:'Invalid transfer result.'});
  try{
    const now=new Date().toISOString();
    const changes={status,updated_at:now,error_message:status==='completed'?null:String(req.body?.error||(status==='failed'?'Transfer failed':'Transfer will retry')).slice(0,240),...(status==='completed'?{completed_at:now}: {})};
    const {data,error}=await supabaseAdmin.from('phone_transfers').update(changes).eq('id',req.params.transferId).eq('device_id',agent.deviceId).eq('direction','phone_to_pc').eq('status','receiving').select('id').maybeSingle();
    if(error)throw error;
    if(!data){
      const {data:existing,error:existingError}=await supabaseAdmin.from('phone_transfers').select('status').eq('id',req.params.transferId).eq('device_id',agent.deviceId).eq('direction','phone_to_pc').maybeSingle();
      if(existingError)throw existingError;
      if(existing?.status===status)return res.json({ok:true,status,idempotent:true});
      return res.status(404).json({ok:false,error:'Transfer not found or already finished.'});
    }
    if(status==='failed'){
      const {data:chunks}=await supabaseAdmin.from('phone_transfer_chunks').select('object_path').eq('transfer_id',req.params.transferId);
      const paths=(chunks||[]).map(c=>c.object_path);
      if(paths.length)await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).remove(paths);
      await supabaseAdmin.from('phone_transfer_chunks').delete().eq('transfer_id',req.params.transferId);
    }
    return res.json({ok:true,status});
  }catch(_){return res.status(503).json({ok:false,error:'Could not save the transfer result.'});}
});

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

// Public product homepage; the authenticated PhoneBridge workspace remains available at /app.
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','landing.html')));
app.get('/app',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

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
