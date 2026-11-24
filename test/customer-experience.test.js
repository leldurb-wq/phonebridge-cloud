'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const zlib=require('node:zlib');
const root=path.join(__dirname,'..');
const html=()=>fs.readFileSync(path.join(root,'public/index.html'),'utf8');

test('cloud entrypoint preserves the complete original PhoneBridge navigation and visual shell',()=>{
 const page=html();
 for(const label of ['Home','Computer','Transfer','Drive','Dual AI','AI Control Room','Audio Player','Video Player','Sync','Workspace','Pairing','Setup','Security','Help'])assert.match(page,new RegExp('>'+label+'(?: player)?<\/a>','i'));
 assert.match(page,/id="mainContent"/);assert.match(page,/id="accountGate"/);assert.match(page,/id="cloudStageNotice"/);
});

test('homepage loads the customer dashboard after authentication using the existing Supabase client',()=>{
 const page=html();const dashboard=fs.readFileSync(path.join(root,'public/dashboard.js'),'utf8');
 const enter=page.match(/async function enterAccountApp\([^]*?\n/)[0];
 assert.match(enter,/await import\('\.\/dashboard\.js'\)/);
 assert.match(enter,/activateCustomerDashboard\(accountSupabase,session\)/);
 assert.doesNotMatch(enter,/await init\(\)|showPage\(/,'login does not boot the legacy interface or redirect into an old page');
 assert.equal((page.match(/createClient\(/g)||[]).length,1,'the homepage creates one Supabase client');
 assert.equal((page.match(/onAuthStateChange\(/g)||[]).length,1,'the homepage registers one auth listener');
 assert.doesNotMatch(dashboard,/createClient\(|onAuthStateChange\(|fetch\('\/config'/,'dashboard reuses the existing session client without another auth bootstrap');
 assert.match(dashboard,/export async function activateCustomerDashboard\(client, session\)/);
 const required=[...new Set([...dashboard.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(match=>match[1]))];
 const ids=[...page.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
 const counts=new Map();for(const id of ids)counts.set(id,(counts.get(id)||0)+1);
 assert.deepEqual(required.filter(id=>!counts.has(id)),[],'all dashboard selectors exist in the actual homepage');
 assert.deepEqual([...counts].filter(([,count])=>count>1),[],'homepage element IDs are unique');
 assert.match(page,/<section class="customer-dashboard hidden" id="appHome"/);
 assert.match(page,/id="customerDeviceWorkspace"/);
 assert.match(page,/<details class="legacy-experience" id="legacyExperience">/,'the original interface remains available as a secondary section');
});

test('Supabase login, registration, Google, phone and recovery use cloud config and the existing session',()=>{
 const page=html();
 for(const marker of ['fetch(\'/config\'','signInWithPassword','signUp(','signInWithOAuth','signInWithOtp','verifyOtp','resetPasswordForEmail','updateUser({password})','getSession()','signOut()'])assert.ok(page.includes(marker),`${marker} is present`);
 assert.doesNotMatch(page,/\/api\/session\/upgrade|\/api\/account\/config|pb31-token/);
 assert.match(page,/\/\@supabase\/supabase-js/);
});

test('the original workspace bootstrap does not call local host/session APIs',()=>{
 const page=html();
 const start=page.indexOf('async function init(){');const end=page.indexOf('async function pollPending(){',start);
 assert.ok(start>=0&&end>start);
 const bootstrap=page.slice(start,end);
 assert.doesNotMatch(bootstrap,/fetch\(['"]\/api\/(?!devices)/);
 assert.match(bootstrap,/Cloud workspace/);assert.match(page,/No local computer API was called/);
 assert.ok(page.includes("api('/api/enrollments'"));assert.match(page,/id="beginPair"/);
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

test('the customer dashboard labels unavailable features and leaves account controls on the homepage auth client',()=>{
 const js=fs.readFileSync(path.join(root,'public/dashboard.js'),'utf8');const page=html();
 assert.match(js,/Secure browser-to-computer file transfer is not implemented/);
 assert.match(js,/Authenticated video streaming from a paired computer is not implemented/);
 assert.match(page,/updateUser\(\{email\}\)/);assert.match(page,/updateUser\(\{password\}\)/);
 assert.doesNotMatch(js,/updateUser\(|signOut\(/,'dashboard does not attach duplicate authentication or account-settings handlers');
});

test('screen, mouse and keyboard controls stay out of the rendered computer page',()=>{
 const page=html();
 assert.match(page,/#computerPage> :not\(#cloudComputerWorkspace\)\{display:none!important\}/);
 assert.match(page,/screen, mouse and keyboard control are unavailable/);
 assert.doesNotMatch(page,/Agent Console|openAgentConsole/);
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
 for(const name of ['cloud-worker.js','credential-store.js','enrollment.js','reconnect-loop.js'])assert.deepEqual(archive.get(name),fs.readFileSync(path.join(root,'agent',name)),name+' in the download matches the reviewed agent source');
 assert.match(archive.get('Start-PhoneBridge-Agent.cmd').toString('utf8'),/node "%~dp0cloud-worker\.js"/);
});

test('pairing and command relay require the reviewed migration chain and service-role-only RPC grants',()=>{
 const dir=path.join(root,'supabase/migrations');const files=fs.readdirSync(dir).filter(name=>name.endsWith('.sql')).sort();
 assert.deepEqual(files,['001_phone_bridge_multiuser.sql','002_device_command_relay.sql','003_device_relay_functions.sql']);
 const base=fs.readFileSync(path.join(dir,files[0]),'utf8');const relay=fs.readFileSync(path.join(dir,files[1]),'utf8');const rpc=fs.readFileSync(path.join(dir,files[2]),'utf8');
 assert.match(base,/create table if not exists public\.devices/);assert.match(base,/devices owner all/);
 assert.match(relay,/create table if not exists public\.device_agents/);assert.match(relay,/create table if not exists public\.device_enrollments/);assert.match(relay,/create table if not exists public\.device_commands/);assert.match(relay,/revoke all on public\.device_agents from anon, authenticated/);assert.match(relay,/device commands owner read/);
 assert.match(rpc,/create or replace function public\.phonebridge_claim_device_command/);assert.match(rpc,/create or replace function public\.phonebridge_complete_device_command/);assert.match(rpc,/grant execute on function public\.phonebridge_claim_device_command\(uuid, text\) to service_role/);assert.match(rpc,/grant execute on function public\.phonebridge_complete_device_command\([\s\S]*?to service_role/);
 const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');assert.match(readme,/002_device_command_relay\.sql/);assert.match(readme,/003_device_relay_functions\.sql/);assert.match(readme,/Render does not run database migrations/);
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
