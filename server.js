'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { serveChunkedFile } = require('./lib/chunked-range');
const { installWorkspaceRoutes } = require('./lib/workspace-routes');
const { createChunkCache } = require('./lib/chunk-cache');
const { classifyMedia, directPlayCandidate, mediaContentType } = require('./lib/media-formats');
const transferChunkCache = createChunkCache({ maxBytes: 32 * 1024 * 1024 });
const ffmpegPath = require('ffmpeg-static');
const { createClient } = require('@supabase/supabase-js');
const { generatePairingCode, hashEnrollmentCode, hashLegacyPairingCode } = require('./agent/pairing-code');
const { isDeviceOnline } = require('./agent/device-status');
const { getClientAddress } = require('./agent/client-address');
const { installScreenRelayRoutes } = require('./agent/screen-relay-routes');
const { installWebRtcSignalRoutes } = require('./agent/webrtc-signal-routes');
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
      mediaSrc:["'self'",'blob:','https://*.supabase.co'],
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
async function getAccessibleDeviceIds(userId) {
 if(!supabaseAdmin)throw new Error('Device service is not configured.');
 const [{data:owned,error:ownedError},{data:shared,error:sharedError}]=await Promise.all([
  supabaseAdmin.from('devices').select('id').eq('user_id',userId),
  supabaseAdmin.from('device_access').select('device_id').eq('user_id',userId)
 ]);
 if(ownedError)throw ownedError;if(sharedError)throw sharedError;
 return [...new Set([...(owned||[]).map(x=>x.id),...(shared||[]).map(x=>x.device_id)])];
}
async function hasDeviceAccess(userId,deviceId){return (await getAccessibleDeviceIds(userId)).includes(deviceId);}

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

// Short-lived, owner-scoped WebRTC signaling for live screen viewing.
const screenSessions=new Map();
const SCREEN_SESSION_TTL=5*60*1000;
setInterval(()=>{const now=Date.now();for(const [id,s] of screenSessions)if(s.expiresAt<=now)screenSessions.delete(id)},30000).unref();
app.post('/api/screen-sessions',rateLimit(8,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const deviceId=String(req.body?.deviceId||'');
  if(!/^[0-9a-f-]{36}$/i.test(deviceId))return res.status(400).json({ok:false,error:'Choose a paired computer first.'});
  try{
    const allowed=await hasDeviceAccess(user.id,deviceId);if(!allowed)return res.status(404).json({ok:false,error:'That computer is not paired to this account.'});
    for(const [id,s] of screenSessions)if(s.ownerId===user.id&&s.deviceId===deviceId)screenSessions.delete(id);
    const id=crypto.randomUUID(),now=Date.now();
    screenSessions.set(id,{id,ownerId:user.id,deviceId,createdAt:now,expiresAt:now+SCREEN_SESSION_TTL,viewerJoined:false,signals:{publisher:[],viewer:[]}});
    return res.status(201).json({ok:true,sessionId:id,expiresAt:new Date(now+SCREEN_SESSION_TTL).toISOString()});
  }catch(_){return res.status(503).json({ok:false,error:'Could not create a secure screen session.'})}
});
app.get('/api/devices/:deviceId/screen-session',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const deviceId=req.params.deviceId;
  try{
    const allowed=await hasDeviceAccess(user.id,deviceId);if(!allowed)return res.status(404).json({ok:false,error:'Paired computer not found.'});
    const session=[...screenSessions.values()].find(s=>s.deviceId===deviceId&&s.ownerId===user.id&&s.expiresAt>Date.now());
    return res.json({ok:true,session:session?{id:session.id,expiresAt:new Date(session.expiresAt).toISOString()}:null});
  }catch(_){return res.status(503).json({ok:false,error:'Could not check screen sharing status.'})}
});
app.post('/api/screen-sessions/:sessionId/signals',rateLimit(180,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const session=screenSessions.get(req.params.sessionId);if(!session||session.ownerId!==user.id||session.expiresAt<=Date.now())return res.status(404).json({ok:false,error:'Screen session expired. Start sharing again.'});
  const role=req.body?.role,type=req.body?.type,payload=req.body?.payload;
  if(!['publisher','viewer'].includes(role)||!['offer','answer','ice','ready'].includes(type)||JSON.stringify(payload??null).length>12000)return res.status(400).json({ok:false,error:'Invalid screen connection signal.'});
  const target=role==='publisher'?'viewer':'publisher';
  if(session.signals[target].length>=120)return res.status(429).json({ok:false,error:'Screen connection is receiving too many signals.'});
  session.signals[target].push({type,payload:payload??null,at:Date.now()});if(role==='viewer'){session.viewerJoined=true;session.expiresAt=Date.now()+30000;}
  return res.json({ok:true});
});
app.get('/api/screen-sessions/:sessionId/signals',rateLimit(360,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const session=screenSessions.get(req.params.sessionId);if(!session||session.ownerId!==user.id||session.expiresAt<=Date.now())return res.status(404).json({ok:false,error:'Screen session expired. Start sharing again.'});
  const role=String(req.query.role||'');
  if(!['publisher','viewer'].includes(role))return res.status(400).json({ok:false,error:'Invalid screen connection role.'});
  const signals=session.signals[role].splice(0,40);if(role==='viewer'){session.viewerJoined=true;session.expiresAt=Date.now()+30000;}
  return res.json({ok:true,signals,expiresAt:new Date(session.expiresAt).toISOString()});
});
app.delete('/api/screen-sessions/:sessionId',rateLimit(20,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  const session=screenSessions.get(req.params.sessionId);if(session&&session.ownerId===user.id)screenSessions.delete(req.params.sessionId);
  return res.json({ok:true});
});

// Owner-authenticated cloud file storage. Objects are private and always scoped
// to the signed-in account; the service-role key never leaves this server.
const FILE_BUCKET='user-files';
const FILE_LIMIT=250*1024*1024;
const ACCOUNT_STORAGE_LIMIT=10*1024*1024*1024;
function cleanFileName(value){
  const name=String(value||'').normalize('NFKC').replaceAll(String.fromCharCode(92),'/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g,'_').replace(/^\.+/,'').trim().slice(0,180);
  return name||'upload';
}
const TRANSFER_DRIVE_PREFIX='phonebridge-transfer:';
function transferDrivePath(transferId){return TRANSFER_DRIVE_PREFIX+transferId;}
async function ensureTransferInDrive(userId,transfer){
  const objectPath=transferDrivePath(transfer.id),now=new Date().toISOString();
  const row={id:transfer.id,user_id:userId,object_path:objectPath,original_name:cleanFileName(transfer.file_name),mime_type:String(transfer.mime_type||'application/octet-stream').slice(0,120),size_bytes:Number(transfer.size_bytes),folder:'',created_at:transfer.created_at||now,updated_at:now};
  const {error}=await supabaseAdmin.from('user_files').upsert(row,{onConflict:'object_path'});
  if(error)throw error;
  return row;
}
const mediaPreviewSessions=new Map();
// Short-lived, file-scoped download links let mobile browsers save large files
// natively without fetching the entire video into a JavaScript Blob first.
const downloadSessions=new Map();
const DOWNLOAD_SESSION_TTL=10*60*1000;
async function writeDriveFileToPath(file,userId,inputPath){
  if(file.object_path.startsWith(TRANSFER_DRIVE_PREFIX)){
    const transferId=file.object_path.slice(TRANSFER_DRIVE_PREFIX.length);
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id,status,size_bytes,chunk_count').eq('id',transferId).eq('user_id',userId).maybeSingle();
    if(error)throw error;
    if(!transfer||transfer.status!=='completed')throw new Error('The received media is not available yet.');
    const {data:chunks,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('chunk_index,object_path,sha256,size_bytes').eq('transfer_id',transferId).order('chunk_index',{ascending:true});
    if(chunkError)throw chunkError;
    if(!chunks?.length||chunks.length!==transfer.chunk_count||chunks.reduce((sum,c)=>sum+Number(c.size_bytes),0)!==Number(file.size_bytes))throw new Error('The media file is incomplete in Drive.');
    const output=fs.createWriteStream(inputPath,{flags:'w'});let streamError=null;output.on('error',error=>{streamError=error});
    try{
      for(let index=0;index<chunks.length;index++){
        const chunk=chunks[index];if(chunk.chunk_index!==index)throw new Error('A media chunk is missing.');
        const {data,error:downloadError}=await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).download(chunk.object_path);
        if(downloadError||!data)throw downloadError||new Error('A media chunk is missing from storage.');
        const buffer=Buffer.from(await data.arrayBuffer());
        if(buffer.length!==Number(chunk.size_bytes)||crypto.createHash('sha256').update(buffer).digest('hex')!==chunk.sha256)throw new Error('A media chunk failed integrity verification.');
        await new Promise((resolve,reject)=>{output.write(buffer,error=>error?reject(error):resolve())});
      }
      await new Promise((resolve,reject)=>{output.once('error',reject);output.end(resolve)});if(streamError)throw streamError;
    }catch(error){output.destroy();throw error}
    return;
  }
  const {data,error}=await supabaseAdmin.storage.from(FILE_BUCKET).download(file.object_path);
  if(error||!data)throw error||new Error('Media data is missing from storage.');
  await pipeline(Readable.fromWeb(data.stream()),fs.createWriteStream(inputPath));
}
async function buildBrowserMedia(session){
  if(!ffmpegPath)throw new Error('Media conversion is not available on this server.');
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'phonebridge-media-'));
  const inputPath=path.join(dir,'source.bin'),outputExt=session.kind==='audio'?'mp3':'mp4',outputPath=path.join(dir,'browser-ready.'+outputExt);
  try{
    await writeDriveFileToPath(session.file,session.userId,inputPath);
    const args=['-hide_banner','-loglevel','error','-y','-threads','2','-i',inputPath];
    if(session.kind==='audio')args.push('-vn','-c:a','libmp3lame','-b:a','160k','-f','mp3',outputPath);
    else args.push('-map','0:v:0','-map','0:a:0?','-vf',"scale='min(1280,iw)':-2",'-c:v','libx264','-preset','ultrafast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-f','mp4',outputPath);
    await new Promise((resolve,reject)=>{
      const child=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});let stderr='';
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Media conversion took too long. Try a shorter or smaller file.'))},15*60*1000);
      child.stderr.on('data',data=>{if(stderr.length<6000)stderr+=data.toString()});
      child.once('error',error=>{clearTimeout(timer);reject(error)});
      child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error('FFmpeg could not decode this media: '+stderr.slice(-1200)))});
    });
    const stat=await fs.promises.stat(outputPath);if(!stat.size)throw new Error('Media conversion produced an empty file.');
    await fs.promises.rm(inputPath,{force:true});
    session.dir=dir;session.outputPath=outputPath;session.expiresAt=Date.now()+30*60*1000;
    return outputPath;
  }catch(error){await fs.promises.rm(dir,{recursive:true,force:true});throw error}
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
const {recordSecurityEvent}=installWorkspaceRoutes({app,requireOwner,supabaseAdmin,rateLimit,FILE_BUCKET,FILE_LIMIT,ACCOUNT_STORAGE_LIMIT,cleanFileName,readUpload,getUserStorageUsage});

app.get('/api/files',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  try{
    const {data,error}=await supabaseAdmin.from('user_files').select('id,original_name,mime_type,size_bytes,folder,is_favorite,created_at,updated_at').eq('user_id',user.id).order('updated_at',{ascending:false}).limit(2000);
    if(error)throw error;
    const files=(data||[]).map(f=>({id:f.id,name:f.original_name,size:Number(f.size_bytes||0),type:f.mime_type||'application/octet-stream',folder:f.folder||'',favorite:!!f.is_favorite,modified:Date.parse(f.updated_at||f.created_at)}));
    const {data:savedFolders,error:folderError}=await supabaseAdmin.from('drive_folders').select('name').eq('user_id',user.id).order('name');
    if(folderError)throw folderError;
    const folders=[...new Set([...files.map(f=>f.folder).filter(Boolean),...(savedFolders||[]).map(f=>f.name)])].sort((a,b)=>a.localeCompare(b));
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
    await recordSecurityEvent(user.id,'file_uploaded',name);
    return res.status(201).json({ok:true,id:data.id,name,size:buffer.length});
  }catch(error){
    if(error.status)return res.status(error.status).json({ok:false,error:error.message});
    return res.status(503).json({ok:false,error:'Upload failed. Check your private storage bucket and try again.'});
  }
});
app.post('/api/preview-session',rateLimit(30,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  const id=String(req.body?.id||'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({ok:false,error:'Choose a valid media file.'});
  try{
    const {data:file,error}=await supabaseAdmin.from('user_files').select('id,object_path,original_name,mime_type,size_bytes').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!file)return res.status(404).json({ok:false,error:'That media file was not found in your Drive.'});
    const name=cleanFileName(file.original_name),mime=String(file.mime_type||'').toLowerCase();
    const kind=classifyMedia(name,mime);
    if(!kind)return res.status(415).json({ok:false,error:'This file is not a supported audio or video format.'});
    for(const [token,session] of mediaPreviewSessions){
      if(session.expiresAt<Date.now()&&!session.promise){mediaPreviewSessions.delete(token);if(session.dir)fs.promises.rm(session.dir,{recursive:true,force:true}).catch(()=>{})}
    }
    const token=crypto.randomBytes(24).toString('hex');
    mediaPreviewSessions.set(token,{userId:user.id,file,kind,directPlay:directPlayCandidate(name),expiresAt:Date.now()+30*60*1000,createdAt:Date.now(),promise:null,outputPath:null,dir:null});
    return res.json({ok:true,url:'/api/media-stream/'+token,kind,expiresIn:1800});
  }catch(error){
    console.error('[PhoneBridge media preview session]',error?.message||error);
    return res.status(503).json({ok:false,error:'Could not prepare this media preview.'});
  }
});
async function serveOriginalMedia(session,req,res){
  const file=session.file,name=cleanFileName(file.original_name);
  const disposition="inline; filename*=UTF-8''"+encodeURIComponent(name);
  const contentType=mediaContentType(name,file.mime_type,session.kind);
  if(file.object_path.startsWith(TRANSFER_DRIVE_PREFIX)){
    const transferId=file.object_path.slice(TRANSFER_DRIVE_PREFIX.length);
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id,status,size_bytes,chunk_count').eq('id',transferId).eq('user_id',session.userId).maybeSingle();
    if(error)throw error;
    if(!transfer||transfer.status!=='completed')throw new Error('The original media transfer is not complete yet.');
    const {data:chunks,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('chunk_index,object_path,sha256,size_bytes').eq('transfer_id',transferId).order('chunk_index',{ascending:true});
    if(chunkError)throw chunkError;
    if(!chunks?.length||chunks.length!==Number(transfer.chunk_count)||chunks.reduce((sum,c)=>sum+Number(c.size_bytes),0)!==Number(file.size_bytes))throw new Error('The original media file is incomplete in Drive.');
    chunks.forEach((chunk,index)=>{if(chunk.chunk_index!==index)throw new Error('The original media manifest has a missing chunk.')});
    const etag='"pb-'+crypto.createHash('sha256').update(chunks.map(chunk=>chunk.sha256).join(':')).digest('hex')+'"';
    await serveChunkedFile({req,res,chunks,size:Number(file.size_bytes),contentType,disposition,etag,fetchChunk:chunk=>transferChunkCache.get(chunk.sha256,async()=>{
      const {data,error:downloadError}=await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).download(chunk.object_path);
      if(downloadError||!data)throw downloadError||new Error('An original media chunk is missing from storage.');
      const buffer=Buffer.from(await data.arrayBuffer());
      if(buffer.length!==Number(chunk.size_bytes)||crypto.createHash('sha256').update(buffer).digest('hex')!==chunk.sha256)throw new Error('An original media chunk failed integrity verification.');
      return buffer;
    })});
    return;
  }
  const {data,error}=await supabaseAdmin.storage.from(FILE_BUCKET).createSignedUrl(file.object_path,1800);
  if(error||!data?.signedUrl)throw error||new Error('Could not create a secure media stream URL.');
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Content-Type',contentType);
  res.setHeader('Content-Disposition',disposition);
  return res.redirect(302,data.signedUrl);
}
async function handleMediaStream(req,res){
  res.setHeader('Cache-Control','private, no-store');
  const token=String(req.params.token||'');
  if(!/^[a-f0-9]{48}$/.test(token))return res.status(404).end();
  const session=mediaPreviewSessions.get(token);
  if(!session||session.expiresAt<Date.now()){
    if(session){mediaPreviewSessions.delete(token);if(session.dir)fs.promises.rm(session.dir,{recursive:true,force:true}).catch(()=>{})}
    return res.status(410).json({ok:false,error:'This media preview expired. Reopen the file to create a new preview.'});
  }
  try{
    const convert=req.query.convert==='1'||!session.directPlay;
    if(!convert){
      session.expiresAt=Date.now()+30*60*1000;
      await serveOriginalMedia(session,req,res);
      return;
    }
    if(!ffmpegPath)return res.status(503).json({ok:false,error:'Media conversion is unavailable on this server. You can still download the original file.'});
    if(!session.outputPath){
      if(!session.promise)session.promise=buildBrowserMedia(session).finally(()=>{session.promise=null});
      await session.promise;
    }
    session.expiresAt=Date.now()+30*60*1000;
    res.setHeader('Content-Type',session.kind==='audio'?'audio/mpeg':'video/mp4');
    res.setHeader('Content-Disposition','inline; filename="'+(session.kind==='audio'?'phonebridge-audio.mp3':'phonebridge-video.mp4')+'"');
    return res.sendFile(session.outputPath,{dotfiles:'deny'},error=>{
      if(error&&!res.headersSent){console.error('[PhoneBridge media preview response]',error.message);res.status(error.statusCode||500).end()}
    });
  }catch(error){
    console.error('[PhoneBridge media stream]',error?.message||error);
    if(res.headersSent)return res.destroy(error);
    return res.status(422).json({ok:false,error:'PhoneBridge could not play or convert this media. Your original file remains unchanged in Drive. Download the original to open it in another player.'});
  }
}
app.get('/api/media-stream/:token',rateLimit(1200,10*60*1000),handleMediaStream);
// Retain the old route for preview links created by clients before an update.
app.get('/api/media-preview/:token',rateLimit(120,10*60*1000),handleMediaStream);
async function streamDriveDownload(userId,id,req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({ok:false,error:'Choose a valid file.'});
  try{
    const {data:file,error}=await supabaseAdmin.from('user_files').select('object_path,original_name,mime_type,size_bytes').eq('id',id).eq('user_id',userId).maybeSingle();
    if(error)throw error;
    if(!file)return res.status(404).json({ok:false,error:'That file was not found in your account.'});
    const safeName=cleanFileName(file.original_name);
    const disposition="attachment; filename*=UTF-8''"+encodeURIComponent(safeName);
    if(file.object_path.startsWith(TRANSFER_DRIVE_PREFIX)){
      const transferId=file.object_path.slice(TRANSFER_DRIVE_PREFIX.length);
      const {data:transfer,error:transferError}=await supabaseAdmin.from('phone_transfers').select('id,status,size_bytes,chunk_count').eq('id',transferId).eq('user_id',userId).maybeSingle();
      if(transferError)throw transferError;
      if(!transfer||transfer.status!=='completed')return res.status(404).json({ok:false,error:'The received file is not available yet.'});
      const {data:chunks,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('chunk_index,object_path,sha256,size_bytes').eq('transfer_id',transferId).order('chunk_index',{ascending:true});
      if(chunkError)throw chunkError;
      if(!chunks?.length||chunks.length!==transfer.chunk_count||chunks.reduce((total,chunk)=>total+Number(chunk.size_bytes),0)!==Number(file.size_bytes))throw new Error('Drive file chunks are incomplete.');
      chunks.forEach((chunk,index)=>{if(chunk.chunk_index!==index)throw new Error('Drive file has a missing chunk.')});
      const etag='"pb-'+crypto.createHash('sha256').update(chunks.map(chunk=>chunk.sha256).join(':')).digest('hex')+'"';
      await serveChunkedFile({req,res,chunks,size:Number(file.size_bytes),contentType:file.mime_type||'application/octet-stream',disposition,etag,fetchChunk:chunk=>transferChunkCache.get(chunk.sha256,async()=>{
        const {data,error:downloadError}=await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).download(chunk.object_path);
        if(downloadError||!data)throw downloadError||new Error('Drive chunk is missing.');
        const buffer=Buffer.from(await data.arrayBuffer());
        if(buffer.length!==Number(chunk.size_bytes)||crypto.createHash('sha256').update(buffer).digest('hex')!==chunk.sha256)throw new Error('Drive chunk failed integrity verification.');
        return buffer;
      })});
      return;
    }
    // Let private Storage serve byte ranges directly. Download sessions are
    // owner-scoped and short-lived; the signed URL is never stored in the app.
    const {data,error:downloadError}=await supabaseAdmin.storage.from(FILE_BUCKET).createSignedUrl(file.object_path,Math.ceil(DOWNLOAD_SESSION_TTL/1000),{download:safeName});
    if(downloadError||!data?.signedUrl)throw downloadError||new Error('Could not create a secure download URL.');
    return res.redirect(302,data.signedUrl);
  }catch(error){
    if(res.destroyed)return;
    console.error('[PhoneBridge Drive download]',error?.message||error);
    if(res.headersSent)return res.destroy(error);
    return res.status(503).json({ok:false,error:'Could not download this file. Please try again.'});
  }
}
app.post('/api/download-session',rateLimit(60,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
  const id=String(req.body?.id||'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({ok:false,error:'Choose a valid file.'});
  try{
    const {data:file,error}=await supabaseAdmin.from('user_files').select('id').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!file)return res.status(404).json({ok:false,error:'That file was not found in your account.'});
    const now=Date.now();
    for(const [token,session] of downloadSessions)if(session.expiresAt<=now)downloadSessions.delete(token);
    while(downloadSessions.size>=1000)downloadSessions.delete(downloadSessions.keys().next().value);
    const token=crypto.randomBytes(32).toString('hex');
    downloadSessions.set(token,{userId:user.id,fileId:id,expiresAt:now+DOWNLOAD_SESSION_TTL});
    return res.json({ok:true,url:'/api/file-download/'+token,expiresIn:Math.floor(DOWNLOAD_SESSION_TTL/1000)});
  }catch(error){
    console.error('[PhoneBridge download session]',error?.message||error);
    return res.status(503).json({ok:false,error:'Could not prepare this download.'});
  }
});
app.get('/api/file-download/:token',rateLimit(120,10*60*1000),async(req,res)=>{
  const token=String(req.params.token||'');
  if(!/^[a-f0-9]{64}$/.test(token))return res.status(404).end();
  const session=downloadSessions.get(token);
  if(!session||session.expiresAt<=Date.now()){downloadSessions.delete(token);return res.status(410).json({ok:false,error:'This download link expired. Request the download again.'})}
  return streamDriveDownload(session.userId,session.fileId,req,res);
});
app.get('/api/download',rateLimit(60,60*1000),async(req,res)=>{
  const user=await requireOwner(req,res);if(!user)return;
  return streamDriveDownload(user.id,String(req.query.id||''),req,res);
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
    if(typeof changes.folder==='string'&&changes.folder){const {error:folderError}=await supabaseAdmin.from('drive_folders').upsert({user_id:user.id,name:changes.folder},{onConflict:'user_id,name',ignoreDuplicates:true});if(folderError)throw folderError;}
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
    const {data:file,error:findError}=await supabaseAdmin.from('user_files').select('object_path,original_name').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(findError)throw findError;
    if(!file)return res.status(404).json({ok:false,error:'That file was not found in your account.'});
    if(file.object_path.startsWith(TRANSFER_DRIVE_PREFIX)){
      const transferId=file.object_path.slice(TRANSFER_DRIVE_PREFIX.length);
      const {data:chunks,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('object_path').eq('transfer_id',transferId);
      if(chunkError)throw chunkError;
      const paths=(chunks||[]).map(chunk=>chunk.object_path);
      if(paths.length){const {error:removeError}=await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).remove(paths);if(removeError)throw removeError;}
      const {error:chunkDeleteError}=await supabaseAdmin.from('phone_transfer_chunks').delete().eq('transfer_id',transferId);
      if(chunkDeleteError)throw chunkDeleteError;
      const {error:transferDeleteError}=await supabaseAdmin.from('phone_transfers').delete().eq('id',transferId).eq('user_id',user.id);
      if(transferDeleteError)throw transferDeleteError;
    }else{
      const {error:removeError}=await supabaseAdmin.storage.from(FILE_BUCKET).remove([file.object_path]);
      if(removeError)throw removeError;
    }
    const {error:deleteError}=await supabaseAdmin.from('user_files').delete().eq('id',id).eq('user_id',user.id);
    if(deleteError)throw deleteError;
    await recordSecurityEvent(user.id,'file_deleted',file.original_name);
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
    const allowed=await hasDeviceAccess(user.id,deviceId);if(!allowed)return res.status(404).json({ok:false,error:'That computer is not paired to this account.'});
    const {data:device,error:deviceError}=await supabaseAdmin.from('devices').select('id,device_agents(enabled,last_seen_at)').eq('id',deviceId).maybeSingle();
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
  }catch(error){console.error('[PhoneBridge transfer chunk]',{transferId:id,index,message:error?.message,code:error?.statusCode||error?.code||null});return res.status(503).json({ok:false,error:'Could not store transfer chunk '+(index+1)+'. The cloud storage service is temporarily unavailable; retry the chunk.'});}
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
    const {data:transfer,error}=await supabaseAdmin.from('phone_transfers').select('id,status,file_name,mime_type,size_bytes,created_at').eq('id',req.params.transferId).eq('user_id',user.id).eq('target_client_id',clientId).eq('direction','pc_to_phone').maybeSingle();
    if(error)throw error;
    if(!transfer)return res.status(404).json({ok:false,error:'This file is not addressed to this phone.'});
    if(transfer.status===status){if(status==='completed')await ensureTransferInDrive(user.id,transfer);return res.json({ok:true,status,idempotent:true})}
    const allowed=status==='receiving'?['queued','receiving']:['receiving'];
    if(!allowed.includes(transfer.status))return res.status(409).json({ok:false,error:'This delivery is no longer available.'});
    const now=new Date().toISOString();
    const {data,error:updateError}=await supabaseAdmin.from('phone_transfers').update({status,updated_at:now,error_message:status==='completed'?null:String(req.body?.error||(status==='failed'?'Phone could not save the file':'Phone delivery will retry')).slice(0,240),...(status==='completed'?{completed_at:now}:{})}).eq('id',transfer.id).eq('user_id',user.id).eq('target_client_id',clientId).eq('status',transfer.status).select('id').maybeSingle();
    if(updateError)throw updateError;
    if(!data)return res.status(409).json({ok:false,error:'Delivery state changed. Refresh the inbox.'});
    if(status==='completed')await ensureTransferInDrive(user.id,transfer);
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
    // Completed transfer chunks back Drive entries and are removed only when the owner deletes the Drive file.
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
    const {data,error}=await supabaseAdmin.from('phone_transfers').select('id,device_id,target_client_id,direction,file_name,mime_type,size_bytes,chunk_size,chunk_count,status,error_message,created_at,updated_at,completed_at').eq('id',req.params.transferId).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    if(!data)return res.status(404).json({ok:false,error:'Transfer not found.'});
    let chunks=[],uploadedChunks=[];
    if(req.query.manifest==='1'){
      const {data:rows,error:chunkError}=await supabaseAdmin.from('phone_transfer_chunks').select('chunk_index,size_bytes,sha256').eq('transfer_id',data.id).order('chunk_index',{ascending:true});
      if(chunkError)throw chunkError;
      chunks=(rows||[]).map(x=>({index:x.chunk_index,sizeBytes:x.size_bytes,sha256:x.sha256}));
      uploadedChunks=chunks.map(x=>x.index);
    }
    return res.json({ok:true,transfer:{id:data.id,deviceId:data.device_id,targetClientId:data.target_client_id,direction:data.direction,name:data.file_name,type:data.mime_type,size:Number(data.size_bytes),chunkSize:data.chunk_size,chunkCount:data.chunk_count,status:data.status,error:data.error_message,createdAt:data.created_at,updatedAt:data.updated_at,completedAt:data.completed_at,...(req.query.manifest==='1'?{chunks,uploadedChunks}:{})}});
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
    const {data,error}=await supabaseAdmin.from('phone_transfers').update(changes).eq('id',req.params.transferId).eq('device_id',agent.deviceId).eq('direction','phone_to_pc').eq('status','receiving').select('id,user_id,file_name,mime_type,size_bytes,created_at').maybeSingle();
    if(error)throw error;
    if(!data){
      const {data:existing,error:existingError}=await supabaseAdmin.from('phone_transfers').select('id,user_id,status,file_name,mime_type,size_bytes,created_at').eq('id',req.params.transferId).eq('device_id',agent.deviceId).eq('direction','phone_to_pc').maybeSingle();
      if(existingError)throw existingError;
      if(existing?.status===status){if(status==='completed')await ensureTransferInDrive(existing.user_id,existing);return res.json({ok:true,status,idempotent:true})}
      return res.status(404).json({ok:false,error:'Transfer not found or already finished.'});
    }
    if(status==='completed')await ensureTransferInDrive(data.user_id,data);
    if(status==='failed'){
      const {data:chunks}=await supabaseAdmin.from('phone_transfer_chunks').select('object_path').eq('transfer_id',req.params.transferId);
      const paths=(chunks||[]).map(c=>c.object_path);
      if(paths.length)await supabaseAdmin.storage.from(PC_TRANSFER_BUCKET).remove(paths);
      await supabaseAdmin.from('phone_transfer_chunks').delete().eq('transfer_id',req.params.transferId);
    }
    return res.json({ok:true,status});
  }catch(_){return res.status(503).json({ok:false,error:'Could not save the transfer result.'});}
});

// List devices owned by or shared with the signed-in PhoneBridge account.
app.get('/api/devices',rateLimit(60,60*1000),async(req,res)=>{
 res.setHeader('Cache-Control','no-store');const user=await requireOwner(req,res);if(!user)return;
 if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device service is not configured.'});
 try{
  const ids=await getAccessibleDeviceIds(user.id);if(!ids.length)return res.json({ok:true,devices:[]});
  const {data:devices,error}=await supabaseAdmin.from('devices').select('id,user_id,name,device_type,device_info,created_at,device_agents(last_seen_at,enabled)').in('id',ids).order('created_at',{ascending:false});if(error)throw error;
  const {data:members,error:memberError}=await supabaseAdmin.from('device_access').select('device_id').in('device_id',ids);if(memberError)throw memberError;
  const counts=new Map();for(const row of members||[])counts.set(row.device_id,(counts.get(row.device_id)||0)+1);
  const now=Date.now();return res.json({ok:true,devices:(devices||[]).map(d=>{const agent=Array.isArray(d.device_agents)?d.device_agents[0]:d.device_agents,seen=agent?.last_seen_at||null;return{id:d.id,name:d.name,deviceType:d.device_type,deviceInfo:d.device_info||{},createdAt:d.created_at,lastSeenAt:seen,connected:isDeviceOnline(agent?.enabled,seen,now),isOwner:d.user_id===user.id,authorizedAccounts:counts.get(d.id)||1,maxAuthorizedAccounts:10};})});
 }catch(_){return res.status(503).json({ok:false,error:'Could not load devices. Check that migration 007 has been applied.'});}
});
// Members can remove their own access; only the original owner can rename or revoke the whole computer.
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
    await recordSecurityEvent(user.id,'device_renamed',data.name);
    return res.json({ok:true,device:{id:data.id,name:data.name}});
  }catch(_){return res.status(503).json({ok:false,error:'Could not rename this device.'});}
});
app.delete('/api/devices/:deviceId',rateLimit(10,10*60*1000),async(req,res)=>{
 res.setHeader('Cache-Control','no-store');const user=await requireOwner(req,res);if(!user)return;
 if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device service is not configured.'});
 const deviceId=req.params.deviceId;if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId))return res.status(400).json({ok:false,error:'Choose a valid device.'});
 try{
  const {data:device,error:lookupError}=await supabaseAdmin.from('devices').select('id,user_id').eq('id',deviceId).maybeSingle();if(lookupError)throw lookupError;if(!device)return res.status(404).json({ok:false,error:'That device was not found.'});
  if(device.user_id===user.id){const {data,error}=await supabaseAdmin.from('devices').delete().eq('id',deviceId).eq('user_id',user.id).select('id').maybeSingle();if(error)throw error;if(!data)return res.status(404).json({ok:false,error:'That computer was not found in your account.'});await recordSecurityEvent(user.id,'device_revoked','All accounts · '+deviceId);return res.json({ok:true,revoked:true,scope:'all_accounts'});}
  const {data,error}=await supabaseAdmin.from('device_access').delete().eq('device_id',deviceId).eq('user_id',user.id).select('device_id').maybeSingle();if(error)throw error;if(!data)return res.status(404).json({ok:false,error:'That computer is not paired to this account.'});await recordSecurityEvent(user.id,'device_revoked','This account · '+deviceId);return res.json({ok:true,revoked:true,scope:'this_account'});
 }catch(_){return res.status(503).json({ok:false,error:'Could not revoke this computer access.'});}
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
      if (!error) { await recordSecurityEvent(user.id,'pair_requested',deviceName); return res.status(201).json({ ok:true, pairingCode:code, enrollmentCode:code, expiresAt, expiresInSeconds:300 }); }
      if (error.code !== '23505') throw error;
    }
    throw new Error('Could not generate a unique pairing code.');
  } catch (_) {
    return res.status(503).json({ ok:false, error:'Could not create a pairing code. Check that the relay database migration has been applied.' });
  }
});

// The computer connector creates a short-lived ticket. The signed-in phone approves it.
app.post('/api/enrollments/approve', rateLimit(20,10*60*1000), async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res); if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Pairing service is not configured.'});
  const code=typeof req.body?.code==='string'?req.body.code.trim():'';
  if(!/^\d{6}$/.test(code))return res.status(400).json({ok:false,error:'Enter the six-digit code shown on your computer.'});
  try{
    const codeHash=hashEnrollmentCode(code,serviceKey);
    const {data:ticket,error}=await supabaseAdmin.from('device_enrollments').select('id').eq('code_hash',codeHash).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle();
    if(error)throw error;
    if(!ticket)return res.status(404).json({ok:false,error:'That code is invalid or has expired.'});
    const now=new Date().toISOString();
    const {data:approved,error:approveError}=await supabaseAdmin.from('device_enrollments').update({approved_at:now,user_id:user.id}).eq('id',ticket.id).is('approved_at',null).is('consumed_at',null).gt('expires_at',now).select('id').maybeSingle();
    if(approveError)throw approveError;
    if(!approved)return res.status(409).json({ok:false,error:'This code was already approved or expired.'});
    await recordSecurityEvent(user.id,'device_approved','Computer pairing approved');
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

// Narrowly allowlisted device controls. Every command is scoped to a device the signed-in account can access.
const DEVICE_CONTROL_ACTIONS=new Set(['set_brightness','open_settings','refresh_info','volume_up','volume_down','volume_mute']);
app.post('/api/commands',rateLimit(30,10*60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device controls are not configured.'});
  const deviceId=String(req.body?.deviceId||''),action=String(req.body?.action||''),payload=req.body?.payload&&typeof req.body.payload==='object'&&!Array.isArray(req.body.payload)?req.body.payload:{};
  if(!/^[0-9a-f-]{36}$/i.test(deviceId)||!DEVICE_CONTROL_ACTIONS.has(action))return res.status(400).json({ok:false,error:'Choose a valid paired computer and supported control.'});
  if(action==='set_brightness'&&(typeof payload.value!=='number'||!Number.isFinite(payload.value)||payload.value<0||payload.value>100))return res.status(400).json({ok:false,error:'Brightness must be between 0 and 100.'});
  if(action==='open_settings'&&!['display','sound','network','bluetooth','battery','windows_update'].includes(String(payload.page||'')))return res.status(400).json({ok:false,error:'Choose a supported Windows settings page.'});
  try{
    if(!await hasDeviceAccess(user.id,deviceId))return res.status(404).json({ok:false,error:'That computer is not paired to this account.'});
    const {data,error}=await supabaseAdmin.from('device_commands').insert({user_id:user.id,device_id:deviceId,action,payload}).select('id,status,created_at').single();
    if(error)throw error;
    return res.status(202).json({ok:true,command:{id:data.id,status:data.status,createdAt:data.created_at}});
  }catch(error){console.error('[PhoneBridge device control]',error?.message||'unknown error');return res.status(503).json({ok:false,error:'Could not queue this computer control. Check that migration 010 has been applied.'});}
});
app.get('/api/commands/:commandId',rateLimit(120,60*1000),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');const user=await requireOwner(req,res);if(!user)return;
  if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device controls are not configured.'});
  if(!/^[0-9a-f-]{36}$/i.test(req.params.commandId))return res.status(400).json({ok:false,error:'Invalid command.'});
  const {data,error}=await supabaseAdmin.from('device_commands').select('id,status,result,error_message').eq('id',req.params.commandId).eq('user_id',user.id).maybeSingle();
  if(error)return res.status(503).json({ok:false,error:'Could not check command status.'});
  if(!data)return res.status(404).json({ok:false,error:'Command not found.'});
  return res.json({ok:true,command:{id:data.id,status:data.status,result:data.result,error:data.error_message}});
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
    const info=req.body?.deviceInfo;
    if(info&&typeof info==='object'&&!Array.isArray(info)){
      const clean={model:String(info.model||'').slice(0,120),os:String(info.os||'').slice(0,100),osVersion:String(info.osVersion||'').slice(0,40),processor:String(info.processor||'').slice(0,140),ramGb:Number.isFinite(Number(info.ramGb))?Math.max(0,Math.min(2048,Number(info.ramGb))):null,graphics:String(info.graphics||'').slice(0,140),batteryPercent:info.batteryPercent===null||info.batteryPercent===undefined?null:Math.max(0,Math.min(100,Number(info.batteryPercent)||0)),batteryStatus:info.batteryStatus===null||info.batteryStatus===undefined?null:Math.max(0,Math.min(255,Number(info.batteryStatus)||0)),brightness:info.brightness===null||info.brightness===undefined?null:Math.max(0,Math.min(100,Number(info.brightness)||0))};
      const {error:infoError}=await supabaseAdmin.from('devices').update({device_info:clean}).eq('id',deviceId);
      if(infoError)throw infoError;
    }
    return res.json({ok:true,lastSeenAt:now});
  } catch (error) {
    return res.status(503).json({ok:false,error:'Could not update computer status.'});
  }
}
installScreenRelayRoutes({app,crypto,supabaseAdmin,requireOwner,rateLimit,agentRateScope,getAccessibleDeviceIds});
installWebRtcSignalRoutes({app,crypto,supabaseAdmin,requireOwner,rateLimit,getAccessibleDeviceIds});
app.post('/api/agent/heartbeat', rateLimit(300,60*1000), rateLimit(60,60*1000,agentRateScope), recordAgentHeartbeat);
// Authenticated Windows-agent command relay. The RPC verifies the per-device token hash.
app.post('/api/agent/commands/claim', rateLimit(300,60*1000), rateLimit(60,60*1000,agentRateScope), async(req,res)=>{
  res.setHeader('Cache-Control','no-store');if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device broker is not configured.'});
  const deviceId=String(req.body?.deviceId||''),token=/^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization')||'')?.[1]||'';
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)||!token)return res.status(401).json({ok:false,error:'Device authentication required.'});
  try{const tokenHash=crypto.createHash('sha256').update(token).digest('hex');const {data,error}=await supabaseAdmin.rpc('phonebridge_claim_device_command',{p_device_id:deviceId,p_token_hash:tokenHash});if(error)throw error;return res.json({ok:true,command:data||null});}
  catch(error){console.error('[PhoneBridge command claim]',error?.message||'unknown error');return res.status(503).json({ok:false,error:'Could not claim a device control.'});}
});
app.post('/api/agent/commands/:commandId/result', rateLimit(300,60*1000), rateLimit(60,60*1000,agentRateScope), async(req,res)=>{
  res.setHeader('Cache-Control','no-store');if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device broker is not configured.'});
  const deviceId=String(req.body?.deviceId||''),token=/^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization')||'')?.[1]||'';
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)||!token||!/^[0-9a-f-]{36}$/i.test(req.params.commandId))return res.status(401).json({ok:false,error:'Device authentication required.'});
  const success=req.body?.success===true,result=req.body?.result&&typeof req.body.result==='object'&&!Array.isArray(req.body.result)?req.body.result:null,errorMessage=String(req.body?.error||'').slice(0,500);
  try{const tokenHash=crypto.createHash('sha256').update(token).digest('hex');const {data,error}=await supabaseAdmin.rpc('phonebridge_complete_device_command',{p_device_id:deviceId,p_token_hash:tokenHash,p_command_id:req.params.commandId,p_success:success,p_result:result,p_error:errorMessage});if(error)throw error;if(!data)return res.status(409).json({ok:false,error:'Command is no longer active.'});return res.json({ok:true});}
  catch(error){console.error('[PhoneBridge command result]',error?.message||'unknown error');return res.status(503).json({ok:false,error:'Could not save the device-control result.'});}
});

// Windows agent redeems a one-time pairing code for a long-lived per-device bearer token.
app.post('/api/agent/enroll',rateLimit(20,10*60*1000),async(req,res)=>{
 res.setHeader('Cache-Control','no-store');if(!supabaseAdmin)return res.status(503).json({ok:false,error:'Device enrollment service is not configured.'});
 const code=typeof req.body?.enrollmentCode==='string'?req.body.enrollmentCode:'',isPairingCode=/^\d{6}$/.test(code);
 if(!isPairingCode&&!/^[A-Za-z0-9_-]{40,50}$/.test(code))return res.status(400).json({ok:false,error:'Enter the six-digit pairing code shown in PhoneBridge.'});
 const codeHash=hashEnrollmentCode(code,serviceKey),previousDeviceId=typeof req.body?.previousDeviceId==='string'?req.body.previousDeviceId:'',previousAgentToken=typeof req.body?.previousAgentToken==='string'&&/^[A-Za-z0-9_-]{40,50}$/.test(req.body.previousAgentToken)?req.body.previousAgentToken:'',requestedDeviceName=typeof req.body?.deviceName==='string'?req.body.deviceName.trim():'';
 if(previousDeviceId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previousDeviceId))return res.status(400).json({ok:false,error:'Saved device identity is invalid.'});
 if(requestedDeviceName.length>80)return res.status(400).json({ok:false,error:'Computer name must be 80 characters or fewer.'});
 try{
  let {data:ticket,error:findError}=await supabaseAdmin.from('device_enrollments').select('id,user_id,device_name,expires_at,consumed_at,approved_at').eq('code_hash',codeHash).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle();if(findError)throw findError;
  if(!ticket&&isPairingCode){const legacy=await supabaseAdmin.from('device_enrollments').select('id,user_id,device_name,expires_at,consumed_at,approved_at').eq('code_hash',hashLegacyPairingCode(code)).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle();if(legacy.error)throw legacy.error;ticket=legacy.data;}
  if(!ticket)return res.status(401).json({ok:false,error:'Invalid or expired pairing code.'});
  if(!ticket.approved_at)return res.status(403).json({ok:false,error:'Open PhoneBridge on your phone and approve this computer first.'});
  let existingDevice=null,agentToken='',deviceId='',reusedCredential=false;
  if(previousDeviceId){
   const {data:device,error:deviceError}=await supabaseAdmin.from('devices').select('id,user_id,name').eq('id',previousDeviceId).maybeSingle();if(deviceError)throw deviceError;
   const suppliedHash=previousAgentToken?crypto.createHash('sha256').update(previousAgentToken).digest('hex'):'';
   const {data:agent,error:agentError}=await supabaseAdmin.from('device_agents').select('token_hash,enabled').eq('device_id',previousDeviceId).maybeSingle();if(agentError)throw agentError;
   if(!device||!agent?.enabled||!suppliedHash||agent.token_hash!==suppliedHash)return res.status(403).json({ok:false,error:'This computer identity could not be verified. Re-pair the original owner account first.'});
   const {data:members,error:membersError}=await supabaseAdmin.from('device_access').select('user_id').eq('device_id',previousDeviceId);if(membersError)throw membersError;
   const isMember=device.user_id===ticket.user_id||(members||[]).some(row=>row.user_id===ticket.user_id);
   if(!isMember&&(members||[]).length>=10)return res.status(409).json({ok:false,error:'This ThinkPad has reached its limit of 10 authorized PhoneBridge accounts.'});
   existingDevice=device;deviceId=device.id;agentToken=previousAgentToken;reusedCredential=true;
  }
  const now=new Date().toISOString();
  const {data:claimed,error:claimError}=await supabaseAdmin.from('device_enrollments').update({consumed_at:now}).eq('id',ticket.id).is('consumed_at',null).gt('expires_at',now).select('id').maybeSingle();if(claimError)throw claimError;if(!claimed)return res.status(409).json({ok:false,error:'Pairing code has already been used or expired.'});
  if(existingDevice){
   const info=req.body?.deviceInfo&&typeof req.body.deviceInfo==='object'&&!Array.isArray(req.body.deviceInfo)?req.body.deviceInfo:{};
   const deviceInfo={model:String(info.model||'').slice(0,120),os:String(info.os||'').slice(0,100),osVersion:String(info.osVersion||'').slice(0,40),processor:String(info.processor||'').slice(0,140),ramGb:Number.isFinite(Number(info.ramGb))?Math.max(0,Math.min(2048,Number(info.ramGb))):null,graphics:String(info.graphics||'').slice(0,140),batteryPercent:info.batteryPercent==null?null:Math.max(0,Math.min(100,Number(info.batteryPercent)||0)),batteryStatus:info.batteryStatus==null?null:Math.max(0,Math.min(255,Number(info.batteryStatus)||0)),brightness:info.brightness==null?null:Math.max(0,Math.min(100,Number(info.brightness)||0))};
   const {error:infoError}=await supabaseAdmin.from('devices').update({device_info:deviceInfo}).eq('id',deviceId);if(infoError)throw infoError;
   const {error:accessError}=await supabaseAdmin.from('device_access').upsert({device_id:deviceId,user_id:ticket.user_id,role:existingDevice.user_id===ticket.user_id?'owner':'member'},{onConflict:'device_id,user_id',ignoreDuplicates:true});if(accessError)throw accessError;
  }else{
   const {data:owned,error:ownedError}=await supabaseAdmin.from('devices').select('id').eq('user_id',ticket.user_id).limit(1);if(ownedError)throw ownedError;
   if(owned?.length)return res.status(409).json({ok:false,error:'This account already has a paired computer. Use its existing computer pairing flow.'});
   agentToken=crypto.randomBytes(32).toString('base64url');const tokenHash=crypto.createHash('sha256').update(agentToken).digest('hex');
   const info=req.body?.deviceInfo&&typeof req.body.deviceInfo==='object'&&!Array.isArray(req.body.deviceInfo)?req.body.deviceInfo:{};
   const deviceInfo={model:String(info.model||'').slice(0,120),os:String(info.os||'').slice(0,100),osVersion:String(info.osVersion||'').slice(0,40),processor:String(info.processor||'').slice(0,140),ramGb:Number.isFinite(Number(info.ramGb))?Math.max(0,Math.min(2048,Number(info.ramGb))):null,graphics:String(info.graphics||'').slice(0,140),batteryPercent:info.batteryPercent==null?null:Math.max(0,Math.min(100,Number(info.batteryPercent)||0)),batteryStatus:info.batteryStatus==null?null:Math.max(0,Math.min(255,Number(info.batteryStatus)||0)),brightness:info.brightness==null?null:Math.max(0,Math.min(100,Number(info.brightness)||0))};
   const {data:device,error:deviceError}=await supabaseAdmin.from('devices').insert({user_id:ticket.user_id,name:requestedDeviceName||ticket.device_name,device_type:'windows_agent',device_info:deviceInfo}).select('id,user_id').single();if(deviceError||!device)throw deviceError||new Error('Device record was not created.');deviceId=device.id;
   const {error:agentError}=await supabaseAdmin.from('device_agents').insert({device_id:deviceId,token_hash:tokenHash,enabled:true});if(agentError){await supabaseAdmin.from('devices').delete().eq('id',deviceId);throw agentError;}
   const {error:accessError}=await supabaseAdmin.from('device_access').insert({device_id:deviceId,user_id:ticket.user_id,role:'owner'});if(accessError){await supabaseAdmin.from('devices').delete().eq('id',deviceId);throw accessError;}
  }
  return res.status(201).json({ok:true,deviceId,deviceName:existingDevice?.name||requestedDeviceName||ticket.device_name,agentToken,reusedCredential});
 }catch(error){console.error('[PhoneBridge multi-account enrollment]',error?.message||'unknown error');return res.status(503).json({ok:false,error:'Device enrollment could not be completed. Check that migration 007 has been applied.'});}
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
