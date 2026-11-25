'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {generatePairingCode,hashEnrollmentCode,hashLegacyPairingCode}=require('../agent/pairing-code');
const {normalizeCredentials,readCredentials,writeCredentials}=require('../agent/credential-store');
const {runReconnectLoop}=require('../agent/reconnect-loop');
const {redeemPairingCode}=require('../agent/enrollment');
const {isDeviceOnline,ONLINE_WINDOW_MS}=require('../agent/device-status');
const {getClientAddress}=require('../agent/client-address');

const valid={deviceId:'dd85c046-d2a3-4a19-909c-209e344b30a6',deviceName:'ThinkPad',agentToken:'A'.repeat(43),installationId:'4892a34b-e54b-4dd9-9c34-f04ac01a45af'};
const pause=async()=>{};

test('pairing enrollment issues a six digit code and stores only a keyed hash',()=>{
  const secret='server-only-test-secret';
  for(let i=0;i<100;i++){
    const code=generatePairingCode();
    assert.match(code,/^\d{6}$/);
    const stored=hashEnrollmentCode(code,secret);
    assert.match(stored,/^[a-f0-9]{64}$/);
    assert.equal(stored,hashEnrollmentCode(code,secret));
    assert.notEqual(stored,crypto.createHash('sha256').update(code).digest('hex'));
    assert.equal(hashLegacyPairingCode(code),crypto.createHash('sha256').update(code).digest('hex'));
  }
});

test('fresh pairing exchanges the six-digit code and creates a valid persistent agent credential',async()=>{
  let sent;
  const code='004271';
  const enrolled=await redeemPairingCode({code,cloudUrl:'https://phonebridge-cloud.onrender.com',exchange:async payload=>{
    sent=payload;
    return {deviceId:valid.deviceId,deviceName:'ThinkPad T430',agentToken:valid.agentToken};
  }});
  assert.equal(sent.enrollmentCode,code);
  assert.equal(sent.previousDeviceId,null);
  assert.match(sent.installationId,/^[0-9a-f-]{36}$/i);
  assert.equal(enrolled.deviceId,valid.deviceId);
  assert.equal(enrolled.agentToken,valid.agentToken);
  assert.equal(enrolled.deviceName,'ThinkPad T430');
  assert.equal(enrolled.cloudUrl,'https://phonebridge-cloud.onrender.com');
});

test('re-enrollment preserves the installed agent identity and returns malformed responses as invalid',async()=>{
  let sent;
  const previous={...valid,cloudUrl:'https://phonebridge-cloud.onrender.com'};
  const enrolled=await redeemPairingCode({code:'912345',previous,cloudUrl:previous.cloudUrl,exchange:async payload=>{
    sent=payload;
    return {deviceId:valid.deviceId,deviceName:'ThinkPad T430',agentToken:'B'.repeat(43)};
  }});
  assert.equal(sent.previousDeviceId,valid.deviceId);
  assert.equal(sent.installationId,valid.installationId);
  assert.equal(enrolled.installationId,valid.installationId);
  assert.equal(await redeemPairingCode({code:'123456',cloudUrl:previous.cloudUrl,exchange:async()=>({deviceId:'bad',agentToken:'bad',deviceName:''})}),null);
});

test('canonical credentials survive a worker restart and authenticate with the stored token',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-agent-'));
  const file=path.join(dir,'cloud-device.json');
  try{
    writeCredentials(file,valid);
    const afterRestart=readCredentials(file);
    assert.deepEqual(afterRestart,valid);
    const controller=new AbortController();let claimedWith='';
    await runReconnectLoop({credentials:afterRestart,claim:async creds=>{claimedWith=creds.agentToken;controller.abort();return{};},reEnroll:async()=>assert.fail('valid token must not re-enroll'),onCommand:async()=>{},sleep:pause,report:()=>{},signal:controller.signal});
    assert.equal(claimedWith,valid.agentToken);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('legacy id/token credential keys are migrated to the current format',()=>{
  const legacy=normalizeCredentials({id:valid.deviceId,name:'ThinkPad',token:valid.agentToken});
  assert.equal(legacy.deviceId,valid.deviceId);
  assert.equal(legacy.agentToken,valid.agentToken);
  assert.match(legacy.installationId,/^[0-9a-f-]{36}$/i);
});

test('current ThinkPad credential shape without deviceName migrates without losing its cloud target',()=>{
  const oldShape=normalizeCredentials({cloudUrl:'https://phonebridge-cloud.onrender.com',deviceId:valid.deviceId,agentToken:valid.agentToken,enrolledAt:'2026-11-22T00:00:00.000Z'});
  assert.equal(oldShape.deviceName,'Windows computer');
  assert.equal(oldShape.cloudUrl,'https://phonebridge-cloud.onrender.com');
  assert.equal(oldShape.enrolledAt,'2026-11-22T00:00:00.000Z');
});

test('corrupt or mismatched credentials are rejected for safe re-pairing',()=>{
  assert.throws(()=>normalizeCredentials({deviceId:'not-a-device',agentToken:'bad',deviceName:'ThinkPad'}));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pb-agent-bad-'));
  const file=path.join(dir,'cloud-device.json');
  try{fs.writeFileSync(file,'{bad json');assert.throws(()=>readCredentials(file));}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});

for(const reason of ['expired','revoked']){
  test(`${reason} credentials trigger one-time re-enrollment instead of repeated auth retries`,async()=>{
    const controller=new AbortController();let oldAttempts=0,newAttempts=0,enrollmentCount=0;
    const renewed={...valid,deviceId:'387b31a8-fdee-4ba5-b405-68907cc1bbbd',agentToken:'B'.repeat(43)};
    await runReconnectLoop({credentials:valid,claim:async creds=>{
      if(creds===valid){oldAttempts++;const error=new Error(reason);error.statusCode=401;throw error;}
      newAttempts++;controller.abort();return{};
    },reEnroll:async current=>{assert.equal(current,valid);enrollmentCount++;return renewed;},onCommand:async()=>{},sleep:pause,report:()=>{},signal:controller.signal});
    assert.equal(oldAttempts,1);assert.equal(enrollmentCount,1);assert.equal(newAttempts,1);
  });
}

test('network interruptions retry the saved credential without forcing enrollment',async()=>{
  const controller=new AbortController();let calls=0,waits=[];
  await runReconnectLoop({credentials:valid,claim:async()=>{calls++;if(calls===1){const e=new Error('offline');e.code='ECONNRESET';throw e;}controller.abort();return{};},reEnroll:async()=>assert.fail('transient network loss must preserve credentials'),onCommand:async()=>{},sleep:async ms=>waits.push(ms),report:()=>{},signal:controller.signal});
  assert.equal(calls,2);assert.deepEqual(waits,[5000,3000]);
});

test('agent ignores legacy task responses while keeping its connection heartbeat',async()=>{
  const controller=new AbortController();let executed=0,disabled=0;
  await runReconnectLoop({credentials:valid,claim:async()=>{controller.abort();return{command:{id:'old-task',action:'system_info'}};},reEnroll:async()=>assert.fail('task delivery should not force enrollment'),sleep:pause,report:kind=>{if(kind==='task-disabled')disabled++;},signal:controller.signal});
  assert.equal(executed,0);assert.equal(disabled,1);
});

test('device heartbeat status is online only for enabled agents with a recent non-future heartbeat',()=>{
  const now=Date.parse('2026-11-23T12:00:00.000Z');
  assert.equal(isDeviceOnline(true,new Date(now-10_000).toISOString(),now),true);
  assert.equal(isDeviceOnline(true,new Date(now-ONLINE_WINDOW_MS).toISOString(),now),false);
  assert.equal(isDeviceOnline(false,new Date(now-1_000).toISOString(),now),false);
  assert.equal(isDeviceOnline(true,new Date(now+60_000).toISOString(),now),false);
  assert.equal(isDeviceOnline(true,'invalid',now),false);
});

test('Render rate limits use the validated Cloudflare client address instead of one shared proxy address',()=>{
  const req={headers:{'cf-connecting-ip':'203.0.113.24'},ip:'10.0.0.5'};
  assert.equal(getClientAddress(req,true),'203.0.113.24');
  assert.equal(getClientAddress(req,false),'10.0.0.5');
  assert.equal(getClientAddress({headers:{'cf-connecting-ip':'not-an-ip'},ip:'10.0.0.5'},true),'10.0.0.5');
});

test('failed re-enrollment does not keep retrying a known invalid token',async()=>{
  const controller=new AbortController();let claims=0,tries=0;
  await runReconnectLoop({credentials:valid,claim:async()=>{claims++;const e=new Error('revoked');e.statusCode=401;throw e;},reEnroll:async()=>{tries++;if(tries===2)controller.abort();throw new Error('code not ready');},onCommand:async()=>{},sleep:pause,report:()=>{},signal:controller.signal});
  assert.equal(claims,1);assert.equal(tries,2);
});
