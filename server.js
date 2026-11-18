'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseAuth = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;
const screenFrames = new Map();
const MAX_SCREEN_FRAME_BYTES = 16000;
app.disable('x-powered-by');
app.use(express.json({ limit: '1100kb', strict: true }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req,res,next)=>{
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  next();
});
app.get('/health',(req,res)=>res.status(200).json({ok:true,service:'Phone Bridge Cloud',version:'1.0.0'}));
app.get('/config',(req,res)=>{
  const url=process.env.SUPABASE_URL||'';
  const key=process.env.SUPABASE_ANON_KEY||'';
  if(!url||!key||url.includes('YOUR_PROJECT'))return res.status(503).json({ready:false,message:'Cloud authentication is not configured yet.'});
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

// Owner creates a one-time enrollment ticket. The raw ticket is returned only once.
app.post('/api/enrollments', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user = await requireOwner(req,res);
  if (!user) return;
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Server-side device enrollment is not configured.' });
  const deviceName = typeof req.body?.deviceName === 'string' ? req.body.deviceName.trim() : '';
  if (!deviceName || deviceName.length > 80) return res.status(400).json({ ok:false, error:'Device name must be between 1 and 80 characters.' });
  try {
    const code = crypto.randomBytes(32).toString('base64url');
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { error } = await supabaseAdmin.from('device_enrollments').insert({ user_id:user.id, code_hash:codeHash, device_name:deviceName, expires_at:expiresAt });
    if (error) throw error;
    return res.status(201).json({ ok:true, enrollmentCode:code, expiresAt, expiresInSeconds:300 });
  } catch (_) {
    return res.status(503).json({ ok:false, error:'Could not create an enrollment ticket. Check that the relay database migration has been applied.' });
  }
});

// Agent pushes small JPEG frames over authenticated HTTPS; only the owning account can read them.
app.post('/api/agent/screen-frame', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Screen relay is not configured.' });
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
  const token = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization') || '')?.[1] || '';
  const imageBase64 = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId) || !token) return res.status(401).json({ ok:false, error:'Device authentication required.' });
  if (req.body?.mimeType !== 'image/jpeg' || !/^[A-Za-z0-9+/]+=*$/.test(imageBase64)) return res.status(400).json({ ok:false, error:'A valid JPEG frame is required.' });
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.length < 4 || bytes.length > MAX_SCREEN_FRAME_BYTES) return res.status(413).json({ ok:false, error:'Screen frame exceeds the relay limit.' });
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return res.status(400).json({ ok:false, error:'Frame data is not a complete JPEG.' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const { data:agent, error } = await supabaseAdmin.from('device_agents').select('device_id').eq('device_id',deviceId).eq('token_hash',tokenHash).eq('enabled',true).maybeSingle();
    if (error || !agent) return res.status(401).json({ ok:false, error:'Device authentication failed.' });
    screenFrames.set(deviceId, { mimeType:'image/jpeg', imageBase64, capturedAt:new Date().toISOString() });
    return res.status(204).end();
  } catch (_) { return res.status(503).json({ ok:false, error:'Could not relay the screen frame.' }); }
});

app.get('/api/screen-frame', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user = await requireOwner(req,res);
  if (!user) return;
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Screen relay is not configured.' });
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) return res.status(400).json({ ok:false, error:'Choose a valid device.' });
  try {
    const { data:device, error } = await supabaseAdmin.from('devices').select('id').eq('id',deviceId).eq('user_id',user.id).maybeSingle();
    if (error || !device) return res.status(404).json({ ok:false, error:'That device was not found in your account.' });
    const frame = screenFrames.get(deviceId) || null;
    return res.json({ ok:true, frame });
  } catch (_) { return res.status(503).json({ ok:false, error:'Could not read the live screen frame.' }); }
});

// Owner-authenticated command queue. Mutating actions require an explicit UI approval flag.
app.post('/api/commands', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const user = await requireOwner(req,res);
  if (!user) return;
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Command service is not configured.' });
  const { deviceId, action } = req.body || {};
  const payload = req.body?.payload === undefined ? {} : req.body.payload;
  const approved = req.body?.approved === true;
  const allowed = ['system_info','screen_capture','screen_stream_start','screen_stream_keepalive','screen_stream_stop','desktop_control','list_files','read_file','write_file','create_folder','launch_app'];
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) return res.status(400).json({ ok:false, error:'Choose a valid device.' });
  if (!allowed.includes(action)) return res.status(400).json({ ok:false, error:'Action is not allowed.' });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({ ok:false, error:'Task payload must be an object.' });
  if (['write_file','create_folder','desktop_control'].includes(action) && !approved) return res.status(403).json({ ok:false, error:'This action requires explicit owner approval.' });
  if (action === 'desktop_control') {
    const p = payload;
    const type = p.type;
    if (!['move','click','scroll','key','type'].includes(type)) return res.status(400).json({ ok:false, error:'Unsupported desktop control.' });
    if (['move','click'].includes(type) && (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return res.status(400).json({ ok:false, error:'Pointer coordinates must be between 0 and 1.' });
    if (type === 'click' && !['left','right','middle'].includes(p.button || 'left')) return res.status(400).json({ ok:false, error:'Unsupported mouse button.' });
    if (type === 'scroll' && (!Number.isInteger(p.delta) || p.delta === 0 || Math.abs(p.delta) > 1200)) return res.status(400).json({ ok:false, error:'Scroll amount is out of range.' });
    if (type === 'type' && (typeof p.text !== 'string' || p.text.length > 300 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(p.text))) return res.status(400).json({ ok:false, error:'Text is too long or contains unsupported control characters.' });
    if (type === 'key' && (typeof p.key !== 'string' || p.key.length > 20 || !/^(?:(?:CTRL|ALT|SHIFT|WIN)\+)*(?:ENTER|ESC|TAB|BACKSPACE|DELETE|UP|DOWN|LEFT|RIGHT|HOME|END|PAGEUP|PAGEDOWN|SPACE|F5|F11|[A-Z0-9])$/i.test(p.key))) return res.status(400).json({ ok:false, error:'That key or shortcut is not allowed.' });
  }
  const relativePath = payload.path;
  if (['list_files','read_file','write_file','create_folder'].includes(action)) {
    if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.length > 240 || path.isAbsolute(relativePath) || relativePath.split(/[\\\\/]+/).some(part => part === '..')) return res.status(400).json({ ok:false, error:'Use a safe relative path inside the PhoneBridge workspace.' });
  }
  if (action === 'write_file' && (typeof payload.content !== 'string' || Buffer.byteLength(payload.content,'utf8') > 1024*1024)) return res.status(400).json({ ok:false, error:'File content must be text no larger than 1 MB.' });
  if (action === 'launch_app' && !['notepad','calculator','explorer'].includes(payload.app)) return res.status(400).json({ ok:false, error:'Choose an approved app.' });
  try {
    const { data:device, error:deviceError } = await supabaseAdmin.from('devices').select('id').eq('id',deviceId).eq('user_id',user.id).maybeSingle();
    if (deviceError || !device) return res.status(404).json({ ok:false, error:'That device was not found in your account.' });
    const { data, error } = await supabaseAdmin.from('device_commands').insert({
      user_id:user.id, device_id:deviceId, action, payload,
      status:'queued', expires_at:new Date(Date.now()+2*60*1000).toISOString()
    }).select('id,action,status,created_at').single();
    if (error) throw error;
    return res.status(201).json({ ok:true, command:data });
  } catch (_) { return res.status(503).json({ ok:false, error:'Could not queue this task. Confirm relay database migrations are deployed.' }); }
});

// Device agent polls for one command using its per-device bearer token.
app.post('/api/agent/commands/claim', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Device broker is not configured.' });
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
  const token = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization') || '')?.[1] || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId) || !token) return res.status(401).json({ ok:false, error:'Device authentication required.' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const { data:agent, error:authError } = await supabaseAdmin.from('device_agents').select('device_id').eq('device_id',deviceId).eq('token_hash',tokenHash).eq('enabled',true).maybeSingle();
    if (authError || !agent) return res.status(401).json({ ok:false, error:'Device authentication failed.' });
    const { data, error } = await supabaseAdmin.rpc('phonebridge_claim_device_command',{p_device_id:deviceId,p_token_hash:tokenHash});
    if (error) throw error;
    return res.json({ ok:true, command:data || null });
  } catch (_) { return res.status(503).json({ ok:false, error:'Could not claim a command. Check that relay migrations 002 and 003 are deployed.' }); }
});

app.post('/api/agent/commands/:commandId/result', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Device broker is not configured.' });
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
  const token = /^Bearer ([A-Za-z0-9_-]{40,50})$/.exec(req.get('authorization') || '')?.[1] || '';
  const commandId = req.params.commandId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId) || !token) return res.status(401).json({ ok:false, error:'Device authentication required.' });
  if (typeof req.body?.success !== 'boolean') return res.status(400).json({ ok:false, error:'A boolean success value is required.' });
  if (req.body.result !== undefined && (!req.body.result || typeof req.body.result !== 'object' || Array.isArray(req.body.result))) return res.status(400).json({ ok:false, error:'Result must be a JSON object.' });
  if (JSON.stringify(req.body.result || {}).length > 24000) return res.status(413).json({ ok:false, error:'Result is too large.' });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const { data:agent, error:authError } = await supabaseAdmin.from('device_agents').select('device_id').eq('device_id',deviceId).eq('token_hash',tokenHash).eq('enabled',true).maybeSingle();
    if (authError || !agent) return res.status(401).json({ ok:false, error:'Device authentication failed.' });
    const { data, error } = await supabaseAdmin.rpc('phonebridge_complete_device_command',{p_device_id:deviceId,p_token_hash:tokenHash,p_command_id:commandId,p_success:req.body.success,p_result:req.body.result || null,p_error:typeof req.body.error === 'string' ? req.body.error.slice(0,500) : null});
    if (error) throw error;
    if (!data) return res.status(409).json({ ok:false, error:'Command is no longer claimable for completion.' });
    return res.json({ ok:true, completed:true });
  } catch (_) { return res.status(503).json({ ok:false, error:'Could not submit command result. Check that relay migrations 002 and 003 are deployed.' }); }
});

// ThinkPad agent exchanges a one-time ticket for a long-lived per-device bearer token.
app.post('/api/agent/enroll', async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if (!supabaseAdmin) return res.status(503).json({ ok:false, error:'Device enrollment service is not configured.' });
  const code = typeof req.body?.enrollmentCode === 'string' ? req.body.enrollmentCode : '';
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(code)) return res.status(400).json({ ok:false, error:'Invalid or expired enrollment ticket.' });
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  try {
    const { data:ticket, error:findError } = await supabaseAdmin.from('device_enrollments').select('id,user_id,device_name,expires_at,consumed_at').eq('code_hash',codeHash).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle();
    if (findError || !ticket) return res.status(401).json({ ok:false, error:'Invalid or expired enrollment ticket.' });
    const now = new Date().toISOString();
    const { data:claimed, error:claimError } = await supabaseAdmin.from('device_enrollments').update({ consumed_at:now }).eq('id',ticket.id).is('consumed_at',null).gt('expires_at',now).select('id').maybeSingle();
    if (claimError || !claimed) return res.status(409).json({ ok:false, error:'Enrollment ticket has already been used or expired.' });
    const { data:device, error:deviceError } = await supabaseAdmin.from('devices').insert({ user_id:ticket.user_id, name:ticket.device_name, device_type:'windows_agent' }).select('id').single();
    if (deviceError || !device) throw deviceError || new Error('Device record was not created.');
    const agentToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(agentToken).digest('hex');
    const { error:agentError } = await supabaseAdmin.from('device_agents').insert({ device_id:device.id, token_hash:tokenHash, enabled:true });
    if (agentError) {
      await supabaseAdmin.from('devices').delete().eq('id',device.id);
      throw agentError;
    }
    return res.status(201).json({ ok:true, deviceId:device.id, deviceName:ticket.device_name, agentToken });
  } catch (_) {
    return res.status(503).json({ ok:false, error:'Device enrollment could not be completed.' });
  }
});

app.use(express.static(path.join(__dirname,'public'),{extensions:['html'],maxAge:process.env.NODE_ENV==='production'?'1h':0}));
app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(port,'0.0.0.0',()=>console.log('Phone Bridge Cloud listening on '+port));
