'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFile, execFileSync } = require('node:child_process');
const { normalizeCredentials, readCredentials, writeCredentials, uuidPattern, tokenPattern } = require('./credential-store');
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
fs.mkdirSync(credentialDir,{recursive:true});
if (fs.lstatSync(credentialDir).isSymbolicLink()) throw new Error('Agent credential directory must not be a symbolic link.');
const MAX_CLOUD_RESPONSE_BYTES = 1024 * 1024;

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
    if (url.protocol !== 'https:') return reject(new Error('Only HTTPS cloud endpoints are allowed.'));
    const payload = JSON.stringify(body);
    const req = https.request(url,{method:'POST',headers:{
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

function removeAgentPairingFiles(){
  for(const name of fs.readdirSync(credentialDir)){
    if(!/^pairing-code-[0-9a-f-]{36}\.txt$/i.test(name))continue;
    try{fs.unlinkSync(path.join(credentialDir,name));}catch(_){}
  }
}
function showPairingCodeInNotepad(request){
  if(process.platform!=='win32')throw new Error('Computer-generated pairing requires the Windows Agent.');
  if(!/^[0-9a-f-]{36}$/i.test(request.requestId)||!/^\d{6}$/.test(request.code))throw new Error('Cloud returned invalid pairing details.');
  const file=path.join(credentialDir,'pairing-code-'+request.requestId+'.txt');
  fs.writeFileSync(file,'PhoneBridge one-time pairing code\r\n\r\n'+request.code+'\r\n\r\nEnter this code in the Pair a Device panel on your signed-in phone.\r\nIt expires in five minutes and can only be approved once.\r\n',{encoding:'utf8',flag:'wx',mode:0o600});
  secureCredentialPath(file,false);
  execFile('notepad.exe',[file],{windowsHide:false},error=>{if(error)console.error('Could not open Notepad. The temporary pairing file is stored in the PhoneBridge Agent folder.');});
  return file;
}
async function enroll({ previous = null } = {}) {
  if(process.platform!=='win32')throw new Error('Fresh PhoneBridge pairing is supported by the Windows Agent.');
  removeAgentPairingFiles();
  const installationId=previous?.installationId||crypto.randomUUID();
  const deviceName=os.hostname().slice(0,80)||'Windows computer';
  while(true){
    let request;
    try{
      request=await postJson('/api/agent/pairing-requests',{
        installationId,deviceName,previousDeviceId:previous?.deviceId||null
      });
    }catch(error){
      if(!error.statusCode||error.statusCode===408||error.statusCode===425||error.statusCode===429||error.statusCode>=500){
        console.error('PhoneBridge pairing service unavailable; retrying automatically.');
        await new Promise(resolve=>setTimeout(resolve,5000));continue;
      }
      throw error;
    }
    if(!request?.ok||!/^[0-9a-f-]{36}$/i.test(request.requestId||'')||!/^\d{6}$/.test(request.code||'')||!tokenPattern.test(request.pollToken||'')||!Number.isFinite(Date.parse(request.expiresAt||'')))throw new Error('PhoneBridge returned invalid pairing details.');
    const codeFile=showPairingCodeInNotepad(request);
    console.log('A one-time pairing code is open in Notepad. Enter it in PhoneBridge on your signed-in phone.');
    let expired=false;
    try{
      while(Date.now()<Date.parse(request.expiresAt)){
        try{
          const result=await postJson('/api/agent/pairing-requests/'+request.requestId+'/claim',{},request.pollToken);
          if(result.approved){
            if(!tokenPattern.test(result.agentToken||'')||!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(result.deviceId||'')||typeof result.deviceName!=='string')throw new Error('PhoneBridge returned invalid device credentials.');
            const credentials=normalizeCredentials({deviceId:result.deviceId,deviceName:result.deviceName,agentToken:result.agentToken,installationId,cloudUrl:parsedCloudUrl.origin,enrolledAt:new Date().toISOString()});
            writeCredentials(credentialPath,credentials,target=>secureCredentialPath(target,false));
            console.log('Computer paired. Agent credentials saved with Windows user-only access.');
            return credentials;
          }
        }catch(error){
          if(error.statusCode===410){expired=true;break;}
          if(error.statusCode===401||error.statusCode===409){expired=true;break;}
          console.error('PhoneBridge pairing service unavailable; checking again automatically.');
        }
        await new Promise(resolve=>setTimeout(resolve,3000));
      }
    }finally{try{fs.unlinkSync(codeFile);}catch(_){}}
    if(expired||Date.now()>=Date.parse(request.expiresAt))console.error('Pairing code expired or was no longer valid. A fresh code is being opened in Notepad.');
  }
}

async function main() {
  removeAgentPairingFiles();
  let credentials;
  if (fs.existsSync(credentialPath)) {
    try {
      secureCredentialPath(credentialPath,false);
      credentials=readCredentials(credentialPath);
      if(credentials.cloudUrl&&credentials.cloudUrl!==parsedCloudUrl.origin)throw new Error('Saved cloud URL does not match PHONEBRIDGE_CLOUD_URL.');
      writeCredentials(credentialPath,credentials,target=>secureCredentialPath(target,false));
    } catch (error) {
      if(error.message.includes('symbolic link')||error.message.includes('Saved cloud URL does not match'))throw error;
      console.error('Saved agent credentials could not be read. Start a fresh pairing from the signed-in PhoneBridge app.');
      credentials=await enroll();
    }
  } else credentials=await enroll();
  console.log('PhoneBridge outbound worker is running.');
  await runReconnectLoop({
    credentials,
    claim:current=>postJson('/api/agent/heartbeat',{deviceId:current.deviceId},current.agentToken),
    reEnroll:previous=>{console.error("This computer credentials were revoked or expired. Approve the fresh Notepad code from your signed-in PhoneBridge account.");return enroll({previous});},
    sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    report:(kind,error)=>{
      if(kind==='enroll-error')console.error('Re-pairing failed: '+error.message);
      else if(kind==='network')console.error('Cloud connection unavailable; retrying automatically. ('+(error.code||error.message||'network error')+')');
    }
  });
}

main().catch(error=>{console.error(error.message);process.exit(1)});
