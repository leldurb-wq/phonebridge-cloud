'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const readline = require('node:readline');
const { execFile, execFileSync } = require('node:child_process');
const { normalizeCredentials, readCredentials, writeCredentials, uuidPattern, tokenPattern } = require('./credential-store');
const { redeemPairingCode } = require('./enrollment');
const { runReconnectLoop } = require('./reconnect-loop');

const cloudUrl = process.env.PHONEBRIDGE_CLOUD_URL || '';
let parsedCloudUrl;
try { parsedCloudUrl=new URL(cloudUrl); } catch (_) {}
if (!parsedCloudUrl || parsedCloudUrl.protocol!=='https:' || !parsedCloudUrl.hostname ||
    parsedCloudUrl.username || parsedCloudUrl.password || parsedCloudUrl.pathname!=='/' ||
    parsedCloudUrl.search || parsedCloudUrl.hash || parsedCloudUrl.origin!==cloudUrl.replace(/\/$/,'')) {
  console.error('PHONEBRIDGE_CLOUD_URL must be an HTTPS origin, for example https://phone-bridge.onrender.com');
  process.exit(1);
}
const credentialDir = process.env.PHONEBRIDGE_AGENT_CONFIG_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.phonebridge'), 'PhoneBridge', 'Agent');
const credentialPath = path.join(credentialDir, 'cloud-device.json');
const workspaceRoot = path.resolve(process.env.PHONEBRIDGE_WORKSPACE || path.join(os.homedir(), 'PhoneBridge'));
fs.mkdirSync(workspaceRoot,{recursive:true});
fs.mkdirSync(credentialDir,{recursive:true});
if (fs.lstatSync(credentialDir).isSymbolicLink()) throw new Error('Agent credential directory must not be a symbolic link.');
const canonicalWorkspaceRoot = fs.realpathSync(workspaceRoot);
const MAX_CLOUD_RESPONSE_BYTES = 1024 * 1024;
const allowedActions = new Set(['system_info','list_files','read_file','write_file','create_folder','launch_app']);

function secureCredentialPath(target, isDirectory) {
  if (process.platform === 'win32') {
    const identity = execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
    const sid = identity.match(/"[^"]+","(S-\d+(?:-\d+)+)"/)?.[1];
    if (!sid) throw new Error('Could not determine the current Windows user SID to secure agent credentials.');
    const grant = '*'+sid+':'+(isDirectory?'(OI)(CI)F':'F');
    execFileSync('icacls.exe',[target,'/inheritance:r','/grant:r',grant],{encoding:'utf8',windowsHide:true,stdio:'pipe'});
  } else {
    fs.chmodSync(target,isDirectory?0o700:0o600);
  }
}

secureCredentialPath(credentialDir,true);

function postJson(urlPath, body, token) {
  return new Promise((resolve,reject)=>{
    const url = new URL(urlPath, cloudUrl);
    const client = url.protocol === 'https:' ? https : http;
    if (url.protocol !== 'https:') return reject(new Error('Only HTTPS cloud endpoints are allowed.'));
    const payload = JSON.stringify(body);
    const req = client.request(url,{method:'POST',headers:{
      'content-type':'application/json',
      'content-length':Buffer.byteLength(payload),
      ...(token ? {authorization:'Bearer '+token} : {})
    }},res=>{
      const length = Number(res.headers['content-length']);
      if (Number.isFinite(length) && length > MAX_CLOUD_RESPONSE_BYTES) {
        res.destroy();
        req.destroy(new Error('Cloud response exceeds the 1 MB limit.'));
        return;
      }
      const chunks=[];
      let bytes=0;
      res.on('data',chunk=>{
        bytes+=chunk.length;
        if (bytes>MAX_CLOUD_RESPONSE_BYTES) {
          chunks.length=0;
          res.destroy();
          req.destroy(new Error('Cloud response exceeds the 1 MB limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end',()=>{
        const data=Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed=JSON.parse(data); } catch (_) { parsed={ok:false,error:'Invalid response from cloud server.'}; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error=new Error(parsed.error||'Cloud request failed.');
          error.statusCode=res.statusCode;
          return reject(error);
        }
        resolve(parsed);
      });
    });
    req.setTimeout(30000,()=>req.destroy(new Error('Cloud request timed out.')));
    req.on('error',reject);
    req.end(payload);
  });
}

function safePath(relativePath) {
  const segments = typeof relativePath === 'string' ? relativePath.split(/[\\/]+/) : [];
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.length > 240 ||
      path.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath) ||
      segments.some(segment=>segment==='..'||(segment!=='.'&&segment.endsWith('.'))||segment.endsWith(' '))) throw new Error('Unsafe workspace path.');
  const resolved = path.resolve(canonicalWorkspaceRoot, relativePath);
  if (resolved !== canonicalWorkspaceRoot && !resolved.startsWith(canonicalWorkspaceRoot+path.sep)) throw new Error('Unsafe workspace path.');
  let current=canonicalWorkspaceRoot;
  const parts=path.relative(canonicalWorkspaceRoot,resolved).split(path.sep).filter(Boolean);
  for (let index=0;index<parts.length;index++) {
    current=path.join(current,parts[index]);
    try {
      const stat=fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed inside the PhoneBridge workspace.');
      if (index<parts.length-1 && !stat.isDirectory()) throw new Error('Workspace path parent is not a directory.');
    } catch (error) {
      if (error.code==='ENOENT') break;
      throw error;
    }
  }
  return resolved;
}

function askForCode(prompt) {
  return new Promise(resolve=>{
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    rl.question(prompt,answer=>{rl.close();resolve(answer.trim())});
  });
}

async function enroll({ previous = null, useCommandLineTicket = false } = {}) {
  const arg=useCommandLineTicket ? (process.argv[2]||'') : '';
  let code=(arg||await askForCode('Enter the six-digit PhoneBridge pairing code: ')).trim();
  while(true){
    if (!/^\d{6}$/.test(code) && !tokenPattern.test(code)) {
      console.error('Pairing code format is invalid. Generate a new six-digit code.');
      code=await askForCode('Enter a new PhoneBridge pairing code: ');
      continue;
    }
    let credentials;
    try { credentials=await redeemPairingCode({code,previous,cloudUrl,exchange:payload=>postJson('/api/agent/enroll',payload)}); }
    catch(error){
      if([400,401,409].includes(error.statusCode)){
        console.error(error.message+' Generate a new code in the PhoneBridge workspace.');
        code=await askForCode('Enter a new PhoneBridge pairing code: ');
        continue;
      }
      if(!error.statusCode||error.statusCode===408||error.statusCode===425||error.statusCode===429||error.statusCode>=500){console.error('Cloud unavailable during enrollment; retrying the same code in 5 seconds.');await new Promise(resolve=>setTimeout(resolve,5000));continue;}
      throw error;
    }
    if (!credentials) {
      console.error('Cloud enrollment response was invalid. Generate a new pairing code.');
      code=await askForCode('Enter a new PhoneBridge pairing code: ');
      continue;
    }
    writeCredentials(credentialPath,credentials,target=>secureCredentialPath(target,false));
    console.log('Enrolled as '+credentials.deviceName+'. Credentials saved securely.');
    return credentials;
  }
}

async function execute(command) {
  if (!command || typeof command!=='object' || !uuidPattern.test(command.id||'') ||
      !allowedActions.has(command.action) || !command.payload || typeof command.payload!=='object' ||
      Array.isArray(command.payload)) throw new Error('Cloud command is invalid or unsupported.');
  const payload=command.payload||{};
  switch(command.action) {
    case 'system_info':
      return { hostname:os.hostname(),platform:os.platform(),release:os.release(),arch:os.arch(),totalMemory:os.totalmem(),freeMemory:os.freemem(),uptime:os.uptime() };
    case 'list_files': {
      const dir=safePath(payload.path||'.');
      const rows=fs.readdirSync(dir,{withFileTypes:true}).slice(0,500).map(entry=>({name:entry.name,type:entry.isDirectory()?'folder':'file'}));
      return {path:payload.path||'.',entries:rows};
    }
    case 'read_file': {
      const file=safePath(payload.path);
      const text=fs.readFileSync(file,'utf8').slice(0,12000);
      return {path:payload.path,text};
    }
    case 'write_file': {
      const file=safePath(payload.path);
      if (typeof payload.content!=='string' || Buffer.byteLength(payload.content,'utf8')>1024*1024) throw new Error('Invalid file content.');
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,payload.content,'utf8');
      return {path:payload.path,written:true};
    }
    case 'create_folder': {
      const dir=safePath(payload.path);
      fs.mkdirSync(dir,{recursive:true});
      return {path:payload.path,created:true};
    }
    case 'launch_app': {
      const apps={notepad:'notepad.exe',calculator:'calc.exe',explorer:'explorer.exe'};
      if (!apps[payload.app]) throw new Error('App is not allowed.');
      await new Promise((resolve,reject)=>execFile(apps[payload.app],[],{windowsHide:false},error=>error?reject(error):resolve()));
      return {app:payload.app,launched:true};
    }
    default:
      throw new Error('Action is not supported by this worker.');
  }
}

async function main() {
  let credentials;
  if (fs.existsSync(credentialPath)) {
    try {
      secureCredentialPath(credentialPath,false);
      credentials=readCredentials(credentialPath);
      if(credentials.cloudUrl&&credentials.cloudUrl!==parsedCloudUrl.origin)throw new Error('Saved cloud URL does not match PHONEBRIDGE_CLOUD_URL.');
      writeCredentials(credentialPath,credentials,target=>secureCredentialPath(target,false));
    } catch (error) {
      if(error.message.includes('symbolic link')||error.message.includes('Saved cloud URL does not match'))throw error;
      console.error('Saved agent credentials could not be read. Re-pair this computer to recover.');
      credentials=await enroll({useCommandLineTicket:false});
    }
  } else credentials=await enroll({useCommandLineTicket:true});
  console.log('PhoneBridge outbound worker is running.');
  await runReconnectLoop({
    credentials,
    claim:current=>postJson('/api/agent/commands/claim',{deviceId:current.deviceId},current.agentToken),
    reEnroll:previous=>{console.error('This computer’s saved cloud access was revoked or expired. Generate a new pairing code in your PhoneBridge account to reconnect.');return enroll({previous});},
    onCommand:async(command,current)=>{
      if(!uuidPattern.test(command.id||''))throw new Error('Cloud returned a command with an invalid ID.');
      try {
        const result=await execute(command);
        await postJson('/api/agent/commands/'+command.id+'/result',{deviceId:current.deviceId,success:true,result},current.agentToken);
      } catch(error) {
        await postJson('/api/agent/commands/'+command.id+'/result',{deviceId:current.deviceId,success:false,error:String(error.message||error).slice(0,500)},current.agentToken);
      }
    },
    sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    report:(kind,error)=>{
      if(kind==='enroll-error')console.error('Re-pairing failed: '+error.message);
      else if(kind==='network')console.error('Cloud connection unavailable; retrying automatically. ('+(error.code||error.message||'network error')+')');
    }
  });
}

main().catch(error=>{console.error(error.message);process.exit(1)});
