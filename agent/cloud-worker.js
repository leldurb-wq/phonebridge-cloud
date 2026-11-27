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
const { startScreenCaptureStream } = require('./screen-capture');
const { answerScreenOffer } = require('./webrtc-screen');

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
const logPath = path.join(credentialDir, 'connector.log');
fs.mkdirSync(credentialDir,{recursive:true});
if (fs.lstatSync(credentialDir).isSymbolicLink()) throw new Error('Agent credential directory must not be a symbolic link.');
function reportAgentEvent(event,error){
  try{
    if(fs.existsSync(logPath)&&fs.statSync(logPath).size>512*1024){
      try{fs.renameSync(logPath,logPath+'.1')}catch{}
    }
    const detail=String(error?.message||error||'').slice(0,300);
    fs.appendFileSync(logPath,new Date().toISOString()+' '+String(event).slice(0,40)+(detail?': '+detail:'')+String.fromCharCode(10),{mode:0o600});
  }catch{}
}
function resolveDocumentsDirectory(){
  try{
    const value=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)'],{encoding:'utf8',windowsHide:true,stdio:'pipe'}).trim();
    if(value&&path.isAbsolute(value))return path.resolve(value);
  }catch(_){}
  return path.join(os.homedir(),'Documents');
}

const MAX_CLOUD_RESPONSE_BYTES = 1024 * 1024;
const cloudHttpsAgent = new https.Agent({keepAlive:true,maxSockets:6,maxFreeSockets:3,timeout:60000});

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
    const req = https.request(url,{method:'POST',agent:cloudHttpsAgent,headers:{
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
    const req=https.get(url,{agent:cloudHttpsAgent,headers:{authorization:'Bearer '+token}},res=>{
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
  const result=await postJson('/api/agent/enroll',{enrollmentCode:code,previousDeviceId:previous?.deviceId||null,previousAgentToken:previous?.agentToken||null,deviceName:os.hostname().trim().slice(0,80)||'Windows computer'});
  const nextToken=result?.reusedCredential===true&&previous?.deviceId===result.deviceId&&tokenPattern.test(previous?.agentToken||'')?previous.agentToken:result?.agentToken;
  if(!result?.ok||!uuidPattern.test(result.deviceId||'')||!tokenPattern.test(nextToken||'')||typeof result.deviceName!=='string'||!result.deviceName.trim()||result.deviceName.length>80)throw new Error('PhoneBridge returned invalid device credentials.');
  const value=normalizeCredentials({deviceId:result.deviceId,deviceName:result.deviceName,agentToken:nextToken,installationId,cloudUrl:parsedCloudUrl.origin,enrolledAt:new Date().toISOString()});
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
  let screenUploadBusy=false,latestScreenFrame=null,screenRetryTimer=null;
  async function publishScreenFrame(frame){
    latestScreenFrame=frame;
    if(screenUploadBusy||screenRetryTimer)return;
    screenUploadBusy=true;
    let inFlightFrame=null;
    try{
      while(latestScreenFrame){
        const nextFrame=latestScreenFrame;latestScreenFrame=null;inFlightFrame=nextFrame;
        const current=activeCredentials;
        if(current?.deviceId&&current?.agentToken){
          await postJson('/api/agent/screen/frame',{deviceId:current.deviceId,imageBase64:nextFrame.toString('base64')},current.agentToken);
        }
        inFlightFrame=null;
      }
    }catch(error){
      if(!latestScreenFrame)latestScreenFrame=inFlightFrame;
      reportAgentEvent('screen-relay',error);
      if(!screenRetryTimer)screenRetryTimer=setTimeout(()=>{screenRetryTimer=null;if(latestScreenFrame)void publishScreenFrame(latestScreenFrame)},1200);
    }finally{
      screenUploadBusy=false;
      if(latestScreenFrame&&!screenRetryTimer)void publishScreenFrame(latestScreenFrame);
    }
  }  const screenCapturePublisher=startScreenCaptureStream({
    frameRate:10,
    onFrame:frame=>{void publishScreenFrame(frame)},
    onError:error=>reportAgentEvent('screen-capture',error)
  });
  process.once('exit',()=>screenCapturePublisher.stop());
  let activeRtcScreen=null,rtcPollBusy=false,rtcPollTimer=null;
  async function pollWebRtcScreen(){
    if(rtcPollBusy)return;
    const current=activeCredentials;
    if(!current?.deviceId||!current?.agentToken){rtcPollTimer=setTimeout(pollWebRtcScreen,1500);return;}
    rtcPollBusy=true;
    try{
      const pending=await postJson('/api/agent/screen/webrtc/poll',{deviceId:current.deviceId},current.agentToken);
      if(pending?.offer&&pending?.sessionId){
        if(activeRtcScreen){activeRtcScreen.close();activeRtcScreen=null;}
        const rtc=await answerScreenOffer({offer:pending.offer,ffmpegPath:require('ffmpeg-static'),frameRate:Number(process.env.PHONEBRIDGE_SCREEN_FPS)||20,width:pending.width||1280,height:pending.height||720,onError:error=>reportAgentEvent('webrtc-screen',error)});
        activeRtcScreen=rtc;
        await postJson('/api/agent/screen/webrtc/answer',{deviceId:current.deviceId,sessionId:pending.sessionId,answer:rtc.answer},current.agentToken);
      }
    }catch(error){if(error.statusCode!==404&&error.statusCode!==401)reportAgentEvent('webrtc-screen-signaling',error);}
    finally{rtcPollBusy=false;rtcPollTimer=setTimeout(pollWebRtcScreen,900);}
  }
  process.once('exit',()=>{if(rtcPollTimer)clearTimeout(rtcPollTimer);if(activeRtcScreen)activeRtcScreen.close();});
  void pollWebRtcScreen();
  await runReconnectLoop({
    credentials,
    claim:async current=>{
      if(nextPairingCredentials){const replacement=nextPairingCredentials;nextPairingCredentials=null;return{credentials:replacement};}
      await postJson('/api/agent/heartbeat',{deviceId:current.deviceId},current.agentToken);
      const pending=await postJson('/api/agent/transfers/claim',{deviceId:current.deviceId},current.agentToken);
      if(pending?.transfer){
        const transfer=pending.transfer;
        let chunksSinceHeartbeat=0;
        const received=await receiveTransfer({
          transfer,
          baseDir:path.join(resolveDocumentsDirectory(),'PhoneBridge','Incoming'),
          downloadChunk:async(id,index)=>{
            if(chunksSinceHeartbeat++%3===0)await postJson('/api/agent/heartbeat',{deviceId:current.deviceId},current.agentToken);
            return getBinary('/api/agent/transfers/'+encodeURIComponent(id)+'/chunks/'+index+'?deviceId='+encodeURIComponent(current.deviceId),current.agentToken);
          },
          complete:result=>postJson('/api/agent/transfers/'+encodeURIComponent(transfer.id)+'/complete',{deviceId:current.deviceId,...result},current.agentToken)
        });
        reportAgentEvent(received.retrying?'transfer-retry':'transfer-saved',new Error(transfer.fileName+(received.retrying?' is queued to resume':' saved in the PhoneBridge Incoming folder')));
      }
      return {ok:true};
    },
    reEnroll:async()=>waitForPairingCredentials(),
    sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    report:reportAgentEvent
  });
  bridge.close();
}

main().catch(error=>{reportAgentEvent('fatal',error);process.exit(1)});
