'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
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

async function askForPhoneCode() {
  const terminal=readline.createInterface({input:process.stdin,output:process.stdout});
  try {
    while(true) {
      const code=(await terminal.question('Enter the six-digit code shown in PhoneBridge on your phone: ')).trim();
      if(/^\d{6}$/.test(code))return code;
      console.log('Please enter all six digits from your phone.');
    }
  } finally { terminal.close(); }
}
async function enroll({ previous = null } = {}) {
  if(process.platform!=='win32')throw new Error('Fresh PhoneBridge pairing is supported by the Windows Agent.');
  const installationId=previous?.installationId||crypto.randomUUID();
  const deviceName=os.hostname().trim().slice(0,80)||'Windows computer';
  while(true) {
    const code=await askForPhoneCode();
    try {
      const result=await postJson('/api/agent/enroll',{
        enrollmentCode:code,
        previousDeviceId:previous?.deviceId||null,
        deviceName
      });
      if(!result?.ok||!uuidPattern.test(result.deviceId||'')||!tokenPattern.test(result.agentToken||'')||
         typeof result.deviceName!=='string'||!result.deviceName.trim()||result.deviceName.length>80) {
        throw new Error('PhoneBridge returned invalid device credentials.');
      }
      const credentials=normalizeCredentials({
        deviceId:result.deviceId,deviceName:result.deviceName,agentToken:result.agentToken,
        installationId,cloudUrl:parsedCloudUrl.origin,enrolledAt:new Date().toISOString()
      });
      writeCredentials(credentialPath,credentials,target=>secureCredentialPath(target,false));
      console.log('This computer is paired. Secure credentials have been saved for this Windows user.');
      return credentials;
    } catch(error) {
      if(error.statusCode===429) {
        console.error('Too many code attempts. Wait ten minutes, generate a fresh code on your phone, and restart this Agent.');
        throw error;
      }
      if(error.statusCode===503||!error.statusCode) {
        console.error('PhoneBridge cloud is temporarily unavailable. Check your internet connection and try the code again.');
      } else {
        console.error(error.message||'That code could not be used. Generate a fresh code on your phone if it has expired.');
      }
    }
  }
}

async function main() {
  let credentials;
  const forcePairing=process.argv.includes('--pair');
  if (fs.existsSync(credentialPath)) {
    try {
      secureCredentialPath(credentialPath,false);
      credentials=readCredentials(credentialPath);
      if(credentials.cloudUrl&&credentials.cloudUrl!==parsedCloudUrl.origin)throw new Error('Saved cloud URL does not match PHONEBRIDGE_CLOUD_URL.');
      if(forcePairing)credentials=await enroll({previous:credentials});
      else writeCredentials(credentialPath,credentials,target=>secureCredentialPath(target,false));
    } catch (error) {
      if(error.statusCode===429||error.message.includes('symbolic link')||error.message.includes('Saved cloud URL does not match'))throw error;
      console.error('Saved agent credentials could not be read. Start a fresh pairing from the signed-in PhoneBridge app.');
      credentials=await enroll();
    }
  } else credentials=await enroll();
  console.log('PhoneBridge outbound worker is running. Cloud heartbeats will confirm when this computer is online.');
  await runReconnectLoop({
    credentials,
    claim:current=>postJson('/api/agent/heartbeat',{deviceId:current.deviceId},current.agentToken),
    reEnroll:previous=>{console.error("This computer credentials were revoked or expired. Generate a new code in PhoneBridge on your phone, then enter it here.");return enroll({previous});},
    sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    report:(kind,error)=>{
      if(kind==='enroll-error')console.error('Re-pairing failed: '+error.message);
      else if(kind==='network')console.error('Cloud connection unavailable; retrying automatically. ('+(error.code||error.message||'network error')+')');
    }
  });
}

main().catch(error=>{console.error(error.message);process.exit(1)});
