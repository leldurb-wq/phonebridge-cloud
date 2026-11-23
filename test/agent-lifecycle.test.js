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

test('failed re-enrollment does not keep retrying a known invalid token',async()=>{
  const controller=new AbortController();let claims=0,tries=0;
  await runReconnectLoop({credentials:valid,claim:async()=>{claims++;const e=new Error('revoked');e.statusCode=401;throw e;},reEnroll:async()=>{tries++;if(tries===2)controller.abort();throw new Error('code not ready');},onCommand:async()=>{},sleep:pause,report:()=>{},signal:controller.signal});
  assert.equal(claims,1);assert.equal(tries,2);
});
