'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { normalizeCredentials, readCredentials, writeCredentials, uuidPattern, tokenPattern } = require('./credential-store');
const { runReconnectLoop } = require('./reconnect-loop');
const { createLocalPairingBridge } = require('./local-pairing-bridge');
const { receiveTransfer } = require('./file-transfer');

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

function getBinary(urlPath,token){
  return new Promise((resolve,reject)=>{
    const url=new URL(urlPath,cloudUrl);
    if(url.protocol!=='https:')return reject(new Error('Only HTTPS cloud endpoints are allowed.'));
    const req=https.get(url,{headers:{authorization:'Bearer '+token}},res=>{
      if(res.statusCode<200||res.statusCode>=300){
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{let data={};try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{}const error=new Error(data.error||'Could not download a transfer chunk.');error.statusCode=res.statusCode;reject(error)});return;
      }
      const length=Number(res.headers['content-length']);
      if(Number.isFinite(length)&&length>8*1024*1024){res.destroy();return reject(new Error('Transfer chunk exceeds the 8 MB limit.'));}
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024){chunks.length=0;res.destroy();req.destroy(new Error('Transfer chunk exceeds the 8 MB limit.'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve(Buffer.concat(chunks,bytes)));
    });
    req.setTimeout(60000,()=>req.destroy(new Error('Transfer chunk request timed out.')));
    req.on('error',reject);
  });
}

let nextPairingCredentials=null;
let pairingWaiter=null;
let activeCredentials=null;
function publishPairingCredentials(value){
  if(pairingWaiter){const resolve=pairingWaiter;pairingWaiter=null;resolve(value);}
  else nextPairingCredentials=value;
}
function waitForPairingCredentials(){
  if(nextPairingCredentials){const value=nextPairingCredentials;nextPairingCredentials=null;return Promise.resolve(value);}
  return new Promise(resolve=>{pairingWaiter=resolve;});
}
async function redeemApprovedCode(code,previous){
  const installationId=previous?.installationId||crypto.randomUUID();
  const result=await postJson('/api/agent/enroll',{enrollmentCode:code,previousDeviceId:previous?.deviceId||null,deviceName:os.hostname().trim().slice(0,80)||'Windows computer'});
  if(!result?.ok||!uuidPattern.test(result.deviceId||'')||!tokenPattern.test(result.agentToken||'')||typeof result.deviceName!=='string'||!result.deviceName.trim()||result.deviceName.length>80)throw new Error('PhoneBridge returned invalid device credentials.');
  const value=normalizeCredentials({deviceId:result.deviceId,deviceName:result.deviceName,agentToken:result.agentToken,installationId,cloudUrl:parsedCloudUrl.origin,enrolledAt:new Date().toISOString()});
  writeCredentials(credentialPath,value,target=>secureCredentialPath(target,false));
  activeCredentials=value;
  publishPairingCredentials(value);
  return value;
}

async function main() {
  if(process.platform!=='win32')throw new Error('The local PhoneBridge connector runs on Windows.');
  let credentials=null;
  if(fs.existsSync(credentialPath)){
    secureCredentialPath(credentialPath,false);
    credentials=readCredentials(credentialPath);
    activeCredentials=credentials;
    if(credentials.cloudUrl&&credentials.cloudUrl!==parsedCloudUrl.origin)throw new Error('Saved cloud URL does not match PHONEBRIDGE_CLOUD_URL.');
  }
  const bridge=await createLocalPairingBridge({
    origin:parsedCloudUrl.origin,
    port:Number(process.env.PHONEBRIDGE_LOCAL_PORT||32145),
    createTicket:accessToken=>postJson('/api/enrollments',{deviceName:os.hostname().trim().slice(0,80)||'Windows computer'},accessToken),
    checkStatus:code=>postJson('/api/agent/enrollment-status',{code}),
    onApproved:code=>redeemApprovedCode(code,activeCredentials)
  });
  if(!credentials)credentials=await waitForPairingCredentials();
  await runReconnectLoop({
    credentials,
    claim:async current=>{
      if(nextPairingCredentials){const replacement=nextPairingCredentials;nextPairingCredentials=null;return{credentials:replacement};}
      await postJson('/api/agent/heartbeat',{deviceId:current.deviceId},current.agentToken);
      const pending=await postJson('/api/agent/transfers/claim',{deviceId:current.deviceId},current.agentToken);
      if(pending?.transfer){
        const transfer=pending.transfer;
        await receiveTransfer({
          transfer,
          baseDir:path.join(os.homedir(),'Documents','PhoneBridge','Incoming'),
          downloadChunk:async(id,index)=>{
            const bytes=await getBinary('/api/agent/transfers/'+encodeURIComponent(id)+'/chunks/'+index+'?deviceId='+encodeURIComponent(current.deviceId),current.agentToken);
            await postJson('/api/agent/heartbeat',{deviceId:current.deviceId},current.agentToken);
            return bytes;
          },
          complete:result=>postJson('/api/agent/transfers/'+encodeURIComponent(transfer.id)+'/complete',{deviceId:current.deviceId,...result},current.agentToken)
        });
      }
      return {ok:true};
    },
    reEnroll:async()=>waitForPairingCredentials(),
    sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    report:()=>{}
  });
  bridge.close();
}

main().catch(()=>process.exit(1));
