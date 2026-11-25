'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const zlib=require('node:zlib');
const root=path.join(__dirname,'..');
const html=()=>fs.readFileSync(path.join(root,'public/index.html'),'utf8');

test('cloud entrypoint presents the refreshed customer PhoneBridge navigation and welcome flow',()=>{
 const page=html();
 for(const label of ['Welcome','Overview','Pair a device','Computer','File transfer','Drive','Audio player','Video player','Sync','Workspace','Help & privacy','Setup','Security'])assert.match(page,new RegExp('>'+label+'(?: player)?<\/a>','i'));
 assert.match(page,/id="mainContent"/);assert.match(page,/id="accountGate"/);assert.match(page,/id="cloudStageNotice"/);
 assert.ok(page.includes("const pageNames=['welcome'"));assert.ok(page.includes("showPage(pageNames.includes(requested)?requested:(initialDevices?.length?'overview':'welcome'))"));
 assert.match(page,/welcomePairButton/);assert.doesNotMatch(page,/Dual AI|AI Control Room|Agent Console|openAgentConsole/);
});

test('authenticated users enter the original PhoneBridge workspace, not a separate dashboard or Agent Console',()=>{
 const page=html();const enter=page.slice(page.indexOf('async function enterAccountApp('),page.indexOf('async function initAccountAuth()'));
 assert.match(enter,/await init\(\)/);assert.doesNotMatch(enter,/dashboard\.js|activateCustomerDashboard/);
 assert.equal((page.match(/createClient\(/g)||[]).length,1,'the homepage creates one Supabase client');assert.equal((page.match(/onAuthStateChange\(/g)||[]).length,1,'the homepage registers one auth listener');
 assert.match(page,/<section class="phonebridge-workspace" id="phoneBridgeWorkspace">/);assert.doesNotMatch(page,/id="appHome"|customerDeviceWorkspace|Agent Console|openAgentConsole/);
 assert.match(page,/id="mainContent"/);assert.match(page,/id="accountGate"/);assert.match(page,/id="pairingCodeDisplay"/);
 const ids=[...page.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);const counts=new Map();for(const id of ids)counts.set(id,(counts.get(id)||0)+1);assert.deepEqual([...counts].filter(([,count])=>count>1),[],'homepage IDs are unique');const selectors=[...new Set([...page.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(m=>m[1]))];assert.deepEqual(selectors.filter(id=>!counts.has(id)),[],'all direct DOM lookups exist in the homepage');assert.equal(fs.existsSync(path.join(root,'public/dashboard.js')),false,'the secondary dashboard module is removed');
});

test('Supabase login, registration, Google, phone and recovery use cloud config and the existing session',()=>{
 const page=html();
 for(const marker of ['fetch(\'/config\'','signInWithPassword','signUp(','signInWithOAuth','signInWithOtp','verifyOtp','resetPasswordForEmail','updateUser({password})','getSession()','signOut()'])assert.ok(page.includes(marker),`${marker} is present`);
 assert.doesNotMatch(page,/\/api\/session\/upgrade|\/api\/account\/config|pb31-token/);
 assert.match(page,/\/\@supabase\/supabase-js/);
});

test('the original workspace bootstrap does not call local host/session APIs',()=>{
 const page=html();
 const start=page.indexOf('async function init(){');const end=page.indexOf('let pairingWatchTimer=',start);
 assert.ok(start>=0&&end>start);
 const bootstrap=page.slice(start,end);
 assert.doesNotMatch(bootstrap,/fetch\(['"]\/api\/(?!devices)/);
 assert.match(bootstrap,/PhoneBridge account/);assert.match(page,/No local computer API was called/);
 assert.ok(page.includes("api('/api/enrollments'"));assert.match(page,/id="beginPair"/);assert.match(page,/Cloud online/);
});

test('unavailable legacy API names cannot fall through to the customer SPA',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 const legacy=server.indexOf("app.use('/api',(req,res)=>res.status(501)");
 const staticStart=server.indexOf("app.use(express.static(path.join(__dirname,'public')");
 assert.ok(legacy>=0&&staticStart>legacy,'API fallback is before static frontend middleware');
 assert.match(server,/This API is not available in the cloud application yet/);
});

test('migrated inline browser script parses and contains no legacy certificate or service-worker setup',()=>{
 const page=html();const scripts=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 assert.equal(scripts.length,1);assert.doesNotThrow(()=>new vm.Script(scripts[0][1]));
 assert.doesNotMatch(page,/phonebridge-root\.cer|serviceWorker\.register|localStorage\.removeItem\(['"]pb31-token/);
});

test('device management APIs bind rename and revoke operations to the authenticated owner',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.match(server,/app\.patch\('\/api\/devices\/:deviceId'/);
 assert.match(server,/app\.delete\('\/api\/devices\/:deviceId'/);
 assert.match(server,/\.eq\('id',deviceId\)\.eq\('user_id',user\.id\)/);
});

test('pairing redemption rejects expired or already-consumed tickets and binds enrollment to ticket owner',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 const enrollment=server.slice(server.indexOf("app.post('/api/agent/enroll'"));
 assert.match(enrollment,/\.is\('consumed_at',null\)\.gt\('expires_at',new Date\(\)\.toISOString\(\)\)/);
 assert.match(enrollment,/\.eq\('id',ticket\.id\)\.is\('consumed_at',null\)\.gt\('expires_at',now\)/);
 assert.match(enrollment,/\.eq\('id',previousDeviceId\)\.eq\('user_id',ticket\.user_id\)/);
 assert.match(enrollment,/user_id:ticket\.user_id/);
});

test('agent polling has a shared abuse ceiling and an independent per-credential limit',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.match(server,/app\.post\('\/api\/agent\/commands\/claim', rateLimit\(300,60\*1000\), rateLimit\(60,60\*1000,agentRateScope\)/);
 assert.match(server,/app\.post\('\/api\/agent\/commands\/:commandId\/result', rateLimit\(300,60\*1000\), rateLimit\(60,60\*1000,agentRateScope\)/);
 assert.match(server,/crypto\.createHash\('sha256'\)\.update\(token\)\.digest\('hex'\)/);
});


test('the retained customer routing helper still distinguishes anonymous, signed-in and recovery sessions',async()=>{
 const {resolveCustomerView}=await import('../public/auth-routing.mjs');
 assert.equal(resolveCustomerView(null),'landing');
 assert.equal(resolveCustomerView({user:{id:'account-a'}}),'dashboard');
 assert.equal(resolveCustomerView({user:{id:'account-a'}},true),'recovery');
});

test('main PhoneBridge pages clearly mark unsupported cloud features and retain account settings on the shared auth client',()=>{
 const page=html();assert.match(page,/File transfer, Drive, synchronization, media streaming, screen viewing and remote input are not available/);
 assert.match(page,/updateUser\(\{email\}\)/);assert.match(page,/updateUser\(\{password\}\)/);
});

test('screen, mouse and keyboard controls stay out of the rendered computer page',()=>{
 const page=html();
 assert.match(page,/#computerPage> :not\(#cloudComputerWorkspace\)\{display:none!important\}/);
 assert.match(page,/screen viewing, mouse control and keyboard control are not available/i);
 assert.doesNotMatch(page,/Agent Console|openAgentConsole/);
});

test('main PhoneBridge computer view keeps pairing and status without task tools or history',()=>{
 const page=html();const detail=page.slice(page.indexOf('id="cloudComputerWorkspace"'),page.indexOf('</section>',page.indexOf('id="cloudComputerWorkspace"')));
 assert.match(page,/id="phonePanel"/);assert.match(page,/id="deviceManager"/);assert.match(page,/id="legacyDeviceList"/);
 assert.match(detail,/View the paired computer connection status/);assert.doesNotMatch(detail,/systemInfo|listFiles|readFile|writeFile|createFolder|launchApp|commandList|Recent tasks|remote-keyboard-toggle|screenFrame/);
});

test('cloud customer API disables tasks while preserving authenticated device heartbeat',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');const worker=fs.readFileSync(path.join(root,'agent/cloud-worker.js'),'utf8');
 assert.match(server,/app\.post\('\/api\/commands'[\s\S]*?status\(410\)/);
 assert.match(server,/app\.post\('\/api\/agent\/heartbeat'[\s\S]*?recordAgentHeartbeat/);
 assert.match(server,/commands\/claim'[\s\S]*?recordAgentHeartbeat/);
 assert.doesNotMatch(server,/rpc\('phonebridge_(claim|complete)_device_command'/);
 assert.match(worker,/postJson\('\/api\/agent\/heartbeat'/);
 assert.doesNotMatch(worker,/commands\/claim|commands\/.*\/result|workspace-tasks|function execute|allowedActions|safePath/);
});

test('phone-generated pairing is account-bound, short-lived, single-use and redeemed by the Windows Agent',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 const phone=server.slice(server.indexOf("app.post('/api/enrollments'"),server.indexOf('// Phone-generated pairing'));
 const redeem=server.slice(server.indexOf("app.post('/api/agent/enroll'"),server.indexOf("app.use('/api'"));
 assert.match(phone,/requireOwner\(req,res\)/);assert.match(phone,/user_id:user\.id/);assert.match(phone,/Date\.now\(\) \+ 5 \* 60 \* 1000/);assert.match(phone,/hashEnrollmentCode\(code,serviceKey\)/);
 assert.match(redeem,/rateLimit\(5,10\*60\*1000\)/);assert.match(redeem,/hashEnrollmentCode\(code,serviceKey\)/);assert.match(redeem,/update\(\{ consumed_at:now \}\)/);assert.match(redeem,/\.is\('consumed_at',null\)\.gt\('expires_at',now\)/);
 assert.match(redeem,/requestedDeviceName/);assert.match(redeem,/\.eq\('id',previousDeviceId\)\.eq\('user_id',ticket\.user_id\)/);
 const worker=fs.readFileSync(path.join(root,'agent/cloud-worker.js'),'utf8');
 assert.match(worker,/readline\.createInterface/);assert.match(worker,/Enter the six-digit code shown in PhoneBridge on your phone/);assert.match(worker,/postJson\('\/api\/agent\/enroll'/);assert.match(worker,/enrollmentCode:code/);assert.match(worker,/process\.argv\.includes\('--pair'\)/);
 assert.doesNotMatch(worker,/notepad\.exe|pairing-requests/);assert.doesNotMatch(server,/device_pairing_requests|phonebridge_complete_pairing_request|enrollments\/approve/);
});

test('main PhoneBridge pairing generates the code on the phone and verifies the computer heartbeat',()=>{
 const page=html();assert.match(page,/id="pairingCodeDisplay"/);assert.match(page,/Generate pairing code/);assert.match(page,/api\('\/api\/enrollments'/);
 assert.match(page,/Enter this code in the PhoneBridge Agent window on your computer/);assert.match(page,/fresh Agent heartbeat confirms the connection/);
 assert.doesNotMatch(page,/computerPin|enrollments\/approve|temporary six-digit code in Notepad/);
});

function readZipEntries(zipPath){
 const bytes=fs.readFileSync(zipPath);const eocd=Buffer.from([0x50,0x4b,0x05,0x06]);let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65558);i--)if(bytes.subarray(i,i+4).equals(eocd)){end=i;break}
 if(end<0)throw new Error('ZIP end record is missing');const count=bytes.readUInt16LE(end+10);let offset=bytes.readUInt32LE(end+16);const entries=new Map();
 for(let i=0;i<count;i++){if(bytes.readUInt32LE(offset)!==0x02014b50)throw new Error('ZIP central directory is invalid');const method=bytes.readUInt16LE(offset+10),compressedSize=bytes.readUInt32LE(offset+20),nameLength=bytes.readUInt16LE(offset+28),extraLength=bytes.readUInt16LE(offset+30),commentLength=bytes.readUInt16LE(offset+32),localOffset=bytes.readUInt32LE(offset+42);const name=bytes.toString('utf8',offset+46,offset+46+nameLength);const localNameLength=bytes.readUInt16LE(localOffset+26),localExtraLength=bytes.readUInt16LE(localOffset+28),start=localOffset+30+localNameLength+localExtraLength,compressed=bytes.subarray(start,start+compressedSize);const contents=method===0?Buffer.from(compressed):method===8?zlib.inflateRawSync(compressed):(()=>{throw new Error('Unsupported ZIP compression method')})();entries.set(name,contents);offset+=46+nameLength+extraLength+commentLength;}
 return entries;
}

test('downloadable Windows Agent archive contains its launcher and every current worker dependency',()=>{
 const archive=readZipEntries(path.join(root,'public/downloads/PhoneBridge-Agent-Windows.zip'));
 for(const name of ['README.txt','Start-PhoneBridge-Agent.cmd','cloud-worker.js','credential-store.js','enrollment.js','reconnect-loop.js'])assert.ok(archive.has(name),'ZIP includes '+name);
 assert.equal(archive.has('workspace-tasks.js'),false,'ZIP does not include remote task support');
 for(const name of ['cloud-worker.js','credential-store.js','enrollment.js','reconnect-loop.js'])assert.deepEqual(archive.get(name),fs.readFileSync(path.join(root,'agent',name)),name+' in the download matches the reviewed agent source');
 assert.match(archive.get('Start-PhoneBridge-Agent.cmd').toString('utf8'),/node "%~dp0cloud-worker\.js"/);
});

test('pairing and command relay use reviewed migrations in order and service-role-only RPC grants',()=>{
 const dir=path.join(root,'supabase/migrations');const files=fs.readdirSync(dir).filter(name=>name.endsWith('.sql')).sort();
 assert.deepEqual(files,['001_phone_bridge_multiuser.sql','002_device_command_relay.sql','003_device_relay_functions.sql']);
 const base=fs.readFileSync(path.join(dir,files[0]),'utf8');const relay=fs.readFileSync(path.join(dir,files[1]),'utf8');const rpc=fs.readFileSync(path.join(dir,files[2]),'utf8');
 assert.match(base,/create table if not exists public\.devices/);assert.match(base,/devices owner all/);
 assert.match(relay,/create table if not exists public\.device_agents/);assert.match(relay,/create table if not exists public\.device_enrollments/);assert.match(relay,/create table if not exists public\.device_commands/);assert.match(relay,/revoke all on public\.device_agents from anon, authenticated/);assert.match(relay,/device commands owner read/);
 assert.match(rpc,/create or replace function public\.phonebridge_claim_device_command/);assert.match(rpc,/create or replace function public\.phonebridge_complete_device_command/);assert.match(rpc,/grant execute on function public\.phonebridge_claim_device_command\(uuid, text\) to service_role/);assert.match(rpc,/grant execute on function public\.phonebridge_complete_device_command\([\s\S]*?to service_role/);
 const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');assert.match(readme,/002_device_command_relay\.sql/);assert.match(readme,/003_device_relay_functions\.sql/);assert.match(readme,/phone-generated pairing codes are stored in/i);assert.match(readme,/Render does not (run migrations automatically|apply database migrations)/);
});


test('pairing codes are created only for the bearer account, expire in five minutes and are stored as HMACs',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');const begin=server.indexOf("app.post('/api/enrollments'");const end=server.indexOf('// Owner-authenticated command queue',begin);const route=server.slice(begin,end);
 assert.match(route,/const user = await requireOwner\(req,res\)/);assert.match(route,/user_id:user\.id/);assert.match(route,/Date\.now\(\) \+ 5 \* 60 \* 1000/);assert.match(route,/hashEnrollmentCode\(code,serviceKey\)/);assert.match(route,/rateLimit\(10,10\*60\*1000\)/);
 const pairing=fs.readFileSync(path.join(root,'agent/pairing-code.js'),'utf8');assert.match(pairing,/createHmac\('sha256',secret\)/);assert.match(pairing,/randomInt\(0,1000000\)/);
});

test('device enrollment records the ticket owner and consumes an unexpired ticket with a compare-and-set update',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');const redeem=server.slice(server.indexOf("app.post('/api/agent/enroll'"),server.indexOf("app.use('/api'"));
 assert.match(redeem,/\.is\('consumed_at',null\)\.gt\('expires_at',new Date\(\)\.toISOString\(\)\)/);assert.match(redeem,/update\(\{ consumed_at:now \}\)\.eq\('id',ticket\.id\)\.is\('consumed_at',null\)\.gt\('expires_at',now\)/);assert.match(redeem,/user_id:ticket\.user_id/);
});
