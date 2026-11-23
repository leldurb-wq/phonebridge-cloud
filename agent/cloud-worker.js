'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const readline = require('node:readline');
const { execFile, execFileSync } = require('node:child_process');

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
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(parsed.error||'Cloud request failed.'));
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

async function enroll() {
  if (fs.existsSync(credentialPath)) {
    if (fs.lstatSync(credentialPath).isSymbolicLink()) throw new Error('Agent credential file must not be a symbolic link.');
    secureCredentialPath(credentialPath,false);
    const credentials=JSON.parse(fs.readFileSync(credentialPath,'utf8'));
    if (!uuidPattern.test(credentials.deviceId||'') || !/^[A-Za-z0-9_-]{40,50}$/.test(credentials.agentToken||'') || typeof credentials.deviceName!=='string') {
      throw new Error('Stored agent credentials are invalid. Remove the local credential file and enroll this device again.');
    }
    return credentials;
  }
  const code = process.argv[2] || await new Promise(resolve=>{
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    rl.question('Enter the six-digit code shown in your PhoneBridge workspace to approve this computer: ',answer=>{rl.close();resolve(answer.trim())});
  });
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit pairing code shown in PhoneBridge.');
  const result=await postJson('/api/agent/enroll',{enrollmentCode:code});
  if (!result || !uuidPattern.test(result.deviceId||'') || !/^[A-Za-z0-9_-]{40,50}$/.test(result.agentToken||'') || typeof result.deviceName!=='string') {
    throw new Error('Cloud enrollment response was invalid.');
  }
  const credentials={deviceId:result.deviceId,deviceName:result.deviceName,agentToken:result.agentToken};
  fs.writeFileSync(credentialPath,JSON.stringify(credentials,null,2),{mode:0o600,flag:'wx'});
  secureCredentialPath(credentialPath,false);
  console.log('Enrolled as '+credentials.deviceName+'. Credentials saved locally.');
  return credentials;
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
  const credentials=await enroll();
  console.log('PhoneBridge outbound worker is running.');
  setInterval(async()=>{
    try {
      const claimed=await postJson('/api/agent/commands/claim',{deviceId:credentials.deviceId},credentials.agentToken);
      if (!claimed.command) return;
      if (!uuidPattern.test(claimed.command.id||'')) throw new Error('Cloud returned a command with an invalid ID.');
      try {
        const result=await execute(claimed.command);
        await postJson('/api/agent/commands/'+claimed.command.id+'/result',{deviceId:credentials.deviceId,success:true,result},credentials.agentToken);
      } catch (error) {
        await postJson('/api/agent/commands/'+claimed.command.id+'/result',{deviceId:credentials.deviceId,success:false,error:String(error.message||error).slice(0,500)},credentials.agentToken);
      }
    } catch (error) {
      console.error(error.message);
    }
  },3000);
}

main().catch(error=>{console.error(error.message);process.exit(1)});
