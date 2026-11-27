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
 assert.ok(page.includes("const pageNames=['welcome','session','pairing','overview'"));assert.ok(page.includes("renderCurrentSessions(initialDevices);const requested=location.hash.slice(1);showPage(initialDevices===null||initialDevices?.length?'session':pageNames.includes(requested)?requested:'welcome')"));
 for(const feature of ['computer','transfer','library','sync','notes','audio','video','pairing','setup','help'])assert.match(page,new RegExp('data-page-link="'+feature+'"'));
 assert.match(page,/welcomePairButton/);assert.match(page,/feature-open/);assert.match(page,/PHONE-FIRST DASHBOARD/);assert.doesNotMatch(page,/Dual AI|AI Control Room|Agent Console|openAgentConsole/);
});

test('post-pairing opens the cinematic feature workspace only after a fresh online check-in',()=>{
 const page=html();
 assert.match(page,/const online=\(devices\|\|\[\]\)\.find\(device=>device\.connected&&\(!pairingBaseline\.has\(device\.id\)\|\|device\.lastSeenAt!==pairingBaseline\.get\(device\.id\)\)\)/);
 assert.match(page,/showPage\('overview'\);toast\(online\.name\+' is online\. Your workspace is ready\.'\)/);
 assert.match(page,/const baseline=new Map\(\(before\|\|\[\]\)\.map\(device=>\[device\.id,device\.lastSeenAt\|\|null\]\)\)/);
 assert.match(page,/showPage\('overview'\);toast\(online\.name\+' connected\. Your workspace is ready\.'\)/);
 assert.match(page,/class="pbx-feature-grid"/);
 assert.equal((page.match(/class="pbx-feature(?: is-limited)?"/g)||[]).length,11);
 for(const feature of ['File transfer','Private Drive','My devices','Audio files','Video files','Secure pairing','Help & privacy','Folder sync','Workspace notes','Screen access','Security controls'])assert.ok(page.includes('<strong>'+feature+'</strong>'),feature+' appears in the workspace');
 assert.match(page,/@keyframes pbx-orbit/);assert.match(page,/@keyframes pbx-card-enter/);assert.match(page,/pbx-workspace-enter/);
 assert.match(page,/body\[data-page\]:not\(\[data-page="overview"\]\) #workspace>#dynamicWorkspace/);
 assert.match(page,/body\[data-page="computer"\] #workspace>#deviceManager/);
});

test('workspace feature pages share a back-to-workspace control',()=>{
 const page=html();
 assert.match(page,/<div class="workspace-backbar" aria-label="Workspace navigation">[\s\S]*?href="#overview" data-page-link="overview" aria-label="Back to PhoneBridge workspace"[\s\S]*?BACK TO WORKSPACE/);
 const backStyle=page.slice(page.indexOf('id="pbx-workspace-back-navigation"'),page.indexOf('</style>',page.indexOf('id="pbx-workspace-back-navigation"')));
 for(const route of ['transfer','library','computer','help','pairing','session','audio','video','sync','notes','security','setup'])assert.ok(backStyle.includes('body[data-page="'+route+'"] .workspace-backbar'),route+' page displays the back control');
 assert.match(page,/document\.querySelectorAll\('\[data-page-link\]'\)\.forEach\(a=>a\.addEventListener\('click',e=>\{e\.preventDefault\(\);showPage\(a\.dataset\.pageLink\)\}\)\)/);
 assert.match(backStyle,/\.workspace-back-button\{[\s\S]*background:linear-gradient\(120deg,#102b43,#0a1a2d\)/);
});

test('main workspace always shows paired sessions and the desktop welcome view fits the viewport',()=>{
 const page=html();
 assert.match(page,/id="workspaceSessionList"/);assert.match(page,/id="workspaceRefreshSessions"/);assert.match(page,/id="workspaceSessionCount"/);
 assert.match(page,/const lists=\[\$\('currentSessionList'\),\$\('workspaceSessionList'\)\]/);
 assert.match(page,/renderPcDeviceChoices\(\);renderCurrentSessions\(items\)/);
 assert.match(page,/workspaceSessionList'\)\.addEventListener\('click',handleSessionListClick\)/);
 const fit=page.slice(page.indexOf('id="pbx-welcome-viewport-fit"'),page.indexOf('</style>',page.indexOf('id="pbx-welcome-viewport-fit"')));
 assert.match(fit,/height:100svh/);assert.match(fit,/height:calc\(100svh - 68px\)/);assert.match(fit,/pairing-universe\{height:clamp/);
});

test('cinematic workspace uses a full-bleed dark outer shell without light page gutters',()=>{
 const page=html();const theme=page.slice(page.indexOf('id="pbx-workspace-dark-surroundings"'),page.indexOf('</style>',page.indexOf('id="pbx-workspace-dark-surroundings"')));
 assert.match(theme,/html\{background:#050914!important\}/);
 assert.match(theme,/body\[data-page="overview"\][\s\S]*background:[\s\S]*#050914!important/);
 assert.match(theme,/body\[data-page="overview"\] \.shell\{width:100%;max-width:none/);
 assert.match(theme,/body\[data-page="overview"\] \.topbar\{[\s\S]*background:rgba\(4,10,22,\.9\)!important/);
 assert.match(theme,/body\[data-page="overview"\] \.phonebridge-workspace>p:first-child\{display:none!important\}/);
 assert.match(theme,/body\[data-page="overview"\] #overview\.hero\{display:none!important\}/);
 assert.match(theme,/body\[data-page="overview"\] #workspace>\.card\{display:none!important\}/);
 assert.match(theme,/body\[data-page="overview"\] \.nav,body\[data-page="overview"\] \.mobile-tabbar,body\[data-page="overview"\] \.a11y-bar\{display:none!important\}/);
 assert.match(theme,/body\[data-page="overview"\] #workspace>#dynamicWorkspace\{width:100%;max-width:none/);
});

test('low-power PCs use a lighter PhoneBridge workspace rendering mode',()=>{
 const page=html();
 assert.match(page,/navigator\.hardwareConcurrency\)<=4/);
 assert.match(page,/pb-performance-mode/);
 const style=page.slice(page.indexOf('id="pbx-performance-optimizations"'),page.indexOf('</style>',page.indexOf('id="pbx-performance-optimizations"')));
 for(const marker of ['#dynamicWorkspace:before','.pbx-ambient','.pbx-visual-halo','.pbx-feature{opacity:1!important;transform:none!important}','backdrop-filter:none!important','animation:none!important'])assert.ok(style.includes(marker),marker+' is optimized on low-power devices');
});

test('PC workspace startup avoids duplicate transfer lookups and loads history only when opened',()=>{
 const page=html(),start=page.indexOf('async function init(){'),end=page.indexOf('let pairingWatchTimer=',start),bootstrap=page.slice(start,end);
 assert.match(bootstrap,/await ensureTransferClient\(\);const \[initialDevices\]=await Promise\.all\(\[loadDevices\(\),loadTransferPhones\(\)\]\)/);
 assert.doesNotMatch(bootstrap,/await loadTransferHistory\(\)/);
 assert.match(bootstrap,/document\.body\.dataset\.page==='transfer'\)loadTransferHistory\(\)/);
 const heartbeat=page.slice(page.indexOf('async function heartbeatTransferClient()'),page.indexOf('async function loadTransferPhones()'));
 assert.match(heartbeat,/document\.body\.dataset\.page==='transfer'/);
 assert.match(page,/if\(name==='transfer'&&accountStarted\)\{loadTransferHistory\(\);if\(phoneClient\)loadDevices\(\);else loadTransferPhones\(\)\}/);
});

test('PhoneBridge is permanently dark with no light-mode toggle or saved theme preference',()=>{
 const page=html();const oldTheme=page.indexOf('phonebridge-redesign.css');const unifiedTheme=page.indexOf('phonebridge-unified.css');
 assert.ok(oldTheme>=0&&unifiedTheme>oldTheme&&unifiedTheme<page.indexOf('</head>'),'unified theme loads after the legacy stylesheet');
 assert.match(page,/<html lang="en" data-theme="dark">/,'dark mode is active before first paint');
 assert.match(page,/<meta name="theme-color" content="#050914">/,'browser chrome uses the dark theme color');
 assert.doesNotMatch(page,/themeToggle|Light mode|Dark mode|pb-theme|applyTheme\(/,'there is no theme toggle or persisted light-mode setting');
 assert.match(page,/document\.documentElement\.dataset\.theme='dark'/,'the app enforces dark mode during startup');
 const css=fs.readFileSync(path.join(root,'public/phonebridge-unified.css'),'utf8');
 const darkTheme=css.lastIndexOf('/* PhoneBridge dark workspace palette');
 assert.ok(darkTheme>css.indexOf('/* Account entry'),'dark palette is the final theme override');
 for(const marker of ['html[data-theme="dark"] body[data-page]','color-scheme:dark!important','background:#07111f','html[data-theme="dark"] body .card','html[data-theme="dark"] body .mobile-tabbar','html[data-theme="dark"] body #previewOverlay .card'])assert.ok(css.includes(marker),`${marker} keeps the dark UI active on feature screens`);
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
 assert.ok(page.includes("http://127.0.0.1:32145/pairing/start"));assert.ok(page.includes("/api/enrollments/approve"));assert.match(page,/id="beginPair"/);assert.match(page,/Cloud online/);
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

test('a saved paired device opens a session review with continue and revoke actions before workspace entry',()=>{
 const page=html();
 assert.match(page,/id="sessionReviewPage"/);assert.match(page,/id="currentSessionList"/);
 assert.match(page,/function renderCurrentSessions\(devices\)/);
 assert.match(page,/data-session-continue/);assert.match(page,/data-session-revoke/);
 assert.match(page,/showPage\('overview'\);toast\('Your PhoneBridge session is ready\.'/);
 assert.match(page,/api\('\/api\/devices\/'.*method:'DELETE'/);
 assert.match(page,/sessionReviewPage'\)\.classList\.toggle\('hidden',name!=='session'\)/);
 assert.match(page,/Revoke the pairing for .*Your PhoneBridge sign-in will remain active/);
 assert.match(page,/body\[data-page="session"\].*#workspace/s);
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

test('main PhoneBridge pages mark cloud file transfer and private Drive as available while retaining unsupported feature notices',()=>{
 const page=html();assert.match(page,/File transfer and private cloud Drive are available/);assert.match(page,/Live screen viewing is available when the Windows connector is running/);
 assert.match(page,/updateUser\(\{email\}\)/);assert.match(page,/updateUser\(\{password\}\)/);assert.match(page,/openPhoneVideo/);assert.match(page,/phoneVideoPicker/);assert.match(page,/data-page-link=\"video\"/);assert.doesNotMatch(page,/\.nav a\[data-page-link=\\\"video\\\"\].*display:none!important/);
});

test('live screen controls are visible in the rendered computer page',()=>{
 const page=html();
 assert.doesNotMatch(page,/#computerPage> :not\(#cloudComputerWorkspace\)\{display:none!important\}/);
 assert.match(page,/id="liveScreen"/);assert.match(page,/id="screenFrame"/);assert.match(page,/api\/screen\/ticket/);assert.match(page,/api\/screen\/frame\?ticket=/);
 assert.doesNotMatch(page,/Agent Console|openAgentConsole/);
});

test('main PhoneBridge computer view keeps pairing and status without task tools or history',()=>{
 const page=html();const detail=page.slice(page.indexOf('id="cloudComputerWorkspace"'),page.indexOf('</section>',page.indexOf('id="cloudComputerWorkspace"')));
 assert.match(page,/id="phonePanel"/);assert.match(page,/id="deviceManager"/);assert.match(page,/id="legacyDeviceList"/);
 assert.match(detail,/View your paired computer connection and open its live desktop/);assert.doesNotMatch(detail,/systemInfo|listFiles|readFile|writeFile|createFolder|launchApp|commandList|Recent tasks|remote-keyboard-toggle|screenFrame/);
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

test('computer-initiated pairing requires approval from the signed-in phone before enrollment',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 const approval=server.slice(server.indexOf("app.post('/api/enrollments/approve'"),server.indexOf("app.post('/api/agent/enrollment-status'"));
 const status=server.slice(server.indexOf("app.post('/api/agent/enrollment-status'"),server.indexOf("// Task execution"));
 const redeem=server.slice(server.indexOf("app.post('/api/agent/enroll'"),server.indexOf("app.use('/api'"));
 assert.match(approval,/requireOwner\(req,res\)/);assert.match(approval,/approved_at:now/);assert.match(approval,/eq\('user_id',user.id\)/);assert.match(approval,/hashEnrollmentCode\(code,serviceKey\)/);
 assert.match(status,/status:ticket.approved_at\?'approved':'waiting'/);
 assert.match(redeem,/if \(!ticket.approved_at\)/);assert.match(redeem,/update\(\{ consumed_at:now \}\)/);
 const worker=fs.readFileSync(path.join(root,'agent/cloud-worker.js'),'utf8');
 assert.match(worker,/createLocalPairingBridge/);assert.match(worker,/enrollment-status/);assert.match(worker,/postJson\('\/api\/agent\/enroll'/);const local=fs.readFileSync(path.join(root,'agent/local-pairing-bridge.js'),'utf8');assert.match(local,/pairing\/start/);assert.match(local,/127\.0\.0\.1/);
 assert.doesNotMatch(worker,/readline|process\.argv\.includes|Enter the six-digit code shown in PhoneBridge on your phone/);
});
test('PhoneBridge pairing generates the code on the computer and asks the phone to approve it',()=>{
 const page=html();assert.match(page,/id="pairingCodeDisplay"/);assert.match(page,/Pair this computer/);assert.match(page,/http:\/\/127\.0\.0\.1:32145\/pairing\/start/);assert.match(page,/body\[data-page="pairing"\] #pairScreen:not\(\.hidden\)\{display:block!important[^}]*grid-template-columns:minmax\(0,1fr\)!important/);
 assert.match(page,/id="phonePairCode"/);assert.match(page,/id="approvePair"/);assert.ok(page.includes("/api/enrollments/approve"));
 assert.doesNotMatch(page,/HOW IT WORKS|Three steps\. One connection|Start on your computer|Approve on your phone|fresh secure check-in/);assert.doesNotMatch(page,/id="pairHelp"/);const pairing=page.slice(page.indexOf('id="phonePanel"'),page.indexOf('id="workspace"'));assert.doesNotMatch(pairing,/phone-generated code|Agent window/);
});

test('cloud CORS allows the Render app and the official PhoneBridge custom domain only',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.match(server,/process\.env\.APP_ORIGIN[\s\S]*https:\/\/phonebridge\.msbundle\.store/);
 assert.match(server,/allowedOrigins\.has\(origin\)/);
 assert.match(server,/Access-Control-Allow-Headers','Authorization, Content-Type/);
 assert.match(server,/Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE, OPTIONS/);
});

test('PhoneBridge transfers work in both directions with authenticated phone destinations and sequential resilient chunks',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8'),page=html(),worker=fs.readFileSync(path.join(root,'agent/cloud-worker.js'),'utf8'),receiver=fs.readFileSync(path.join(root,'agent/file-transfer.js'),'utf8');
 for(const route of ["app.post('/api/transfers'","app.put('/api/transfers/:transferId/chunks/:index'","app.post('/api/transfers/:transferId/complete'","app.get('/api/transfers/:transferId'","app.post('/api/agent/transfers/claim'","app.delete('/api/transfers/:transferId'","app.get('/api/agent/transfers/:transferId/chunks/:index'","app.post('/api/agent/transfers/:transferId/complete'"])assert.ok(server.includes(route),route+' exists');
 assert.match(server,/PC_TRANSFER_CHUNK=8\*1024\*1024/);assert.match(server,/PC_TRANSFER_MAX=2\*1024\*1024\*1024/);assert.match(server,/requireOwner\(req,res\)/);assert.match(server,/requireAgent\(req,res/);assert.match(server,/X-Chunk-SHA256/);assert.match(server,/Date\.now\(\)-2\*60\*1000/);assert.match(server,/\['completed','failed','queued'\]/);assert.match(server,/touchError/);
 assert.match(page,/id="pcDeviceSelect"/);assert.match(page,/id="pcFileInput"/);assert.match(page,/crypto\.subtle\.digest/);assert.match(page,/X-Chunk-SHA256/);assert.match(page,/2 GB per file/);
 assert.match(worker,/receiveTransfer/);assert.match(worker,/resolveDocumentsDirectory\(\),'PhoneBridge','Incoming'/);assert.match(worker,/Environment\+SpecialFolder\]::MyDocuments/);assert.match(worker,/api\/agent\/transfers\/claim/);
 assert.match(receiver,/createWriteStream|writeSync/);assert.match(receiver,/createHash\('sha256'\)/);assert.match(receiver,/fs\.renameSync/);assert.match(receiver,/existing\.size===size/);assert.match(receiver,/firstChunk/);assert.match(receiver,/Promise\.allSettled/);assert.match(receiver,/batchStart\+=3/);assert.match(server,/app\.post\('\/api\/transfer-clients\/register'/);assert.match(server,/app\.get\('\/api\/transfer-clients'/);assert.match(server,/app\.get\('\/api\/transfers\/inbox'/);assert.match(server,/app\.post\('\/api\/transfers\/:transferId\/receive'/);assert.match(server,/direction==='pc_to_phone'/);assert.match(server,/target_client_id/);assert.match(page,/Choose the current phone/);assert.match(page,/Send files to your phone/);assert.match(page,/pollPhoneInbox/);assert.match(page,/transferHistory/);assert.match(page,/Array\.from\(\{length:1\},worker\)/);assert.match(page,/function uploadTransferChunk\(/);assert.match(page,/xhr\.open\('PUT'/);assert.match(page,/xhr\.timeout=120000/);assert.match(page,/attempt<5/);assert.match(page,/750\*Math\.pow\(2,attempt\)/);assert.match(server,/ensureTransferInDrive\(user\.id,transfer\)/);assert.match(server,/ensureTransferInDrive\(agent\.userId,data\)/);assert.match(server,/TRANSFER_DRIVE_PREFIX='phonebridge-transfer:'/);assert.match(server,/phone_transfer_chunks[\s\S]*?X-Chunk-SHA256/);assert.match(server,/Completed transfer chunks back Drive entries/);
 assert.doesNotMatch(worker,/readline|executeCommand|workspace-tasks|process\.exec\(/);
});

test('cloud file transfer routes store private owner-scoped files and enforce per-file and account quotas',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8'),page=html();
 assert.match(server,/app\.get\('\/api\/files'/);assert.match(server,/app\.post\('\/api\/upload'/);assert.match(server,/app\.get\('\/api\/download'/);assert.match(server,/app\.patch\('\/api\/files'/);assert.match(server,/app\.delete\('\/api\/files'/);
 assert.match(server,/const FILE_BUCKET='user-files'/);assert.match(server,/const FILE_LIMIT=250\*1024\*1024/);assert.match(server,/const ACCOUNT_STORAGE_LIMIT=10\*1024\*1024\*1024/);
 assert.match(server,/storage\.from\(FILE_BUCKET\)\.upload/);assert.match(server,/storage\.from\(FILE_BUCKET\)\.download/);assert.match(server,/\.eq\('id',id\)\.eq\('user_id',user\.id\)/);
 assert.match(page,/pathOnly==='\/api\/files'/);assert.match(page,/pathOnly==='\/api\/upload'&&method==='POST'/);assert.match(page,/pathOnly==='\/api\/download'&&method==='GET'/);
 assert.match(page,/x\.setRequestHeader\('Authorization','Bearer '\+accountToken\)/);assert.match(page,/fetch\('\/api\/download\?id='/);
 assert.doesNotMatch(page,/X-PB-Account-Token/);
});

test('video and audio transfers infer browser media MIME types from file extensions',()=>{
 const page=html();
 assert.match(page,/function fileMimeType\(name,fallback=''/);
 for(const mapping of ["mp4:'video/mp4'","m4v:'video/mp4'","mov:'video/quicktime'","webm:'video/webm'","mp3:'audio/mpeg'","m4a:'audio/mp4'"])assert.ok(page.includes(mapping),'MIME mapping '+mapping);
 assert.match(page,/type:fileMimeType\(file\.name,file\.type\)/);
 assert.match(page,/type:fileMimeType\(item\.name,item\.type\)/);
 assert.match(page,/wmv.*flv.*f4v.*ts.*m2ts/);
});
test('Drive and transfer history share previews for text and common Office formats',()=>{
 const page=html();
 assert.match(page,/async function renderFilePreview\(name,url,stage\)/);
 assert.match(page,/async function openFilePreview\(id\)[\s\S]*?renderFilePreview\(f\.name,url/);
 assert.match(page,/async function openTransferFile\(id\)[\s\S]*?renderFilePreview\(item\.name,url/);
 for(const ext of ['txt','csv','json','xml','md','rtf','docx','xlsx','xlsm','pptx'])assert.ok(page.includes("'"+ext+"'"),'preview handler recognises '+ext);
 assert.match(page,/mammoth@1\.9\.0/);assert.match(page,/xlsx@0\.18\.5/);assert.match(page,/jszip@3\.10\.1/);
 assert.match(page,/Preview ready · Download original is always available/);
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
 for(const name of ['README.txt','Start-PhoneBridge.cmd','Start-PhoneBridge-Background.vbs','cloud-worker.js','credential-store.js','enrollment.js','reconnect-loop.js','local-pairing-bridge.js','file-transfer.js','screen-capture.js'])assert.ok(archive.has(name),'ZIP includes '+name);
 assert.equal(archive.has('workspace-tasks.js'),false,'ZIP does not include remote task support');
 for(const name of ['cloud-worker.js','credential-store.js','enrollment.js','reconnect-loop.js','local-pairing-bridge.js','file-transfer.js'])assert.deepEqual(archive.get(name),fs.readFileSync(path.join(root,'agent',name)),name+' in the download matches the reviewed agent source');
 assert.match(archive.get('Start-PhoneBridge.cmd').toString('utf8'),/Start-PhoneBridge-Background\.vbs/);
});

test('pairing and command relay use reviewed migrations in order and service-role-only RPC grants',()=>{
 const dir=path.join(root,'supabase/migrations');const files=fs.readdirSync(dir).filter(name=>name.endsWith('.sql')).sort();
 assert.deepEqual(files,['001_phone_bridge_multiuser.sql','002_device_command_relay.sql','003_device_relay_functions.sql','004_computer_initiated_pairing.sql','005_resumable_pc_file_transfers.sql','006_bidirectional_phone_transfers.sql']);
 const base=fs.readFileSync(path.join(dir,files[0]),'utf8');const relay=fs.readFileSync(path.join(dir,files[1]),'utf8');const rpc=fs.readFileSync(path.join(dir,files[2]),'utf8');const pairing=fs.readFileSync(path.join(dir,files[3]),'utf8');const transfers=fs.readFileSync(path.join(dir,files[4]),'utf8');const bidirectional=fs.readFileSync(path.join(dir,files[5]),'utf8');
 assert.match(base,/create table if not exists public\.devices/);assert.match(base,/devices owner all/);
 assert.match(relay,/create table if not exists public\.device_agents/);assert.match(relay,/create table if not exists public\.device_enrollments/);assert.match(relay,/create table if not exists public\.device_commands/);assert.match(relay,/revoke all on public\.device_agents from anon, authenticated/);assert.match(relay,/device commands owner read/);
 assert.match(rpc,/create or replace function public\.phonebridge_claim_device_command/);assert.match(rpc,/create or replace function public\.phonebridge_complete_device_command/);assert.match(rpc,/grant execute on function public\.phonebridge_claim_device_command\(uuid, text\) to service_role/);assert.match(rpc,/grant execute on function public\.phonebridge_complete_device_command\([\s\S]*?to service_role/);assert.match(pairing,/add column if not exists approved_at timestamptz/);assert.ok(transfers.includes('create table if not exists public.phone_transfers'));assert.ok(transfers.includes('create table if not exists public.phone_transfer_chunks'));assert.ok(transfers.includes('transfer-chunks'));assert.ok(transfers.includes('grant all on public.phone_transfers, public.phone_transfer_chunks to service_role'));assert.match(bidirectional,/add column if not exists direction text not null default 'phone_to_pc'/);assert.match(bidirectional,/create table if not exists public.phone_transfer_clients/);assert.match(bidirectional,/primary key \(user_id,id\)/);assert.match(bidirectional,/grant all on public.phone_transfer_clients to service_role/);
 const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');assert.match(readme,/002_device_command_relay\.sql/);assert.match(readme,/003_device_relay_functions\.sql/);assert.match(readme,/computer-generated pairing code/i);assert.match(readme,/Render does not (run migrations automatically|apply database migrations)/);
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

test('Drive media previews use short-lived authenticated streaming sessions and browser-ready transcoding',()=>{
 const page=html(),server=fs.readFileSync(path.join(root,'server.js'),'utf8'),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 assert.ok(page.includes('async function authenticatedDrivePreviewUrl(id,name)'));
 assert.ok(page.includes("fetch('/api/preview-session'"));
 assert.ok(page.includes("const previewHeaders=headers({'Content-Type':'application/json'});"));
 assert.ok(page.includes("if(accountSession?.access_token)h.set('Authorization','Bearer '+accountSession.access_token)"));
 assert.ok(page.includes('async function playMedia(kind,id)'));
 assert.ok(page.includes('const url=await authenticatedDrivePreviewUrl(f.id,f.name)'));
 assert.ok(page.includes('const url=await authenticatedDrivePreviewUrl(id,f.name)'));
 assert.ok(server.includes("app.post('/api/preview-session'"));assert.ok(server.includes("app.get('/api/media-preview/:token'"));
 assert.ok(server.includes("require('ffmpeg-static')"));assert.ok(server.includes("'libx264'"));assert.ok(server.includes("'libmp3lame'"));assert.ok(server.includes("'yuv420p'"));assert.ok(server.includes('res.sendFile(session.outputPath'));
 assert.equal(pkg.dependencies['ffmpeg-static']!==undefined,true);
 assert.ok(page.includes("VLC Media Player"));assert.ok(page.includes("Windows Media Player"));
 assert.ok(page.includes("width:min(96vw,1440px)"));assert.ok(page.includes("height:min(76dvh,900px)"));
 assert.ok(page.includes("Playback error '+code+' | Original file unchanged"));
});


test('mobile video previews open directly and downloads use expiring native download links',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8'),page=html();
 assert.ok(server.includes("app.post('/api/download-session'"));
 assert.ok(server.includes("app.get('/api/file-download/:token'"));
 assert.ok(server.includes('downloadSessions.set(token,{userId:user.id,fileId:id,expiresAt:now+DOWNLOAD_SESSION_TTL})'));
 assert.ok(server.includes("res.setHeader('Content-Disposition',disposition)"));
 assert.ok(server.includes("createSignedUrl(file.object_path,Math.ceil(DOWNLOAD_SESSION_TTL/1000),{download:safeName})"));
 assert.ok(server.includes('return res.redirect(302,data.signedUrl)'));
 assert.ok(page.includes("fetch('/api/download-session'"));
 assert.ok(page.includes("const prefix='/api/file-download/'"));
 assert.ok(page.includes('a.href=data.url'));
 assert.ok(page.includes('if(phoneClient)await playInside();else showMediaChoice(f,playInside)'));
 assert.ok(page.includes('if(phoneClient)await startPlayback();else showMediaChoice(f,startPlayback)'));
 assert.ok(page.includes("$('previewDownload').dataset.fileId=item.id"));
 assert.ok(page.includes('authenticatedDrivePreviewUrl(item.id,item.name)'));
 assert.ok(!page.includes('const blob=await fetchTransferBlob(item,item.direction'));
 assert.ok(!page.includes('const b=await r.blob(),u=URL.createObjectURL(b),a=document.createElement(\'a\')'));
});

test('media streams serve originals first with a conversion fallback for browser-incompatible codecs',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8'),page=html();
 assert.ok(server.includes("app.get('/api/media-stream/:token',rateLimit(1200,10*60*1000),handleMediaStream)"));
 assert.ok(server.includes('const convert=req.query.convert===\'1\'||!session.directPlay'));
 assert.ok(server.includes('await serveOriginalMedia(session,req,res)'));
 assert.ok(server.includes('createSignedUrl(file.object_path,1800)'));
 assert.ok(server.includes('transferChunkCache.get(chunk.sha256'));
 assert.ok(server.includes('mediaSrc:["\'self\'",\'blob:\',\'https://*.supabase.co\']'));
 assert.ok(page.includes('function mediaConversionFallback(url)'));
 assert.ok(page.includes("target.searchParams.set('convert','1')"));
 assert.ok(page.includes('function retryLibraryMedia(media,file,statusId)'));
 assert.ok(page.includes('drivePreviewUrls.delete(failed.id)'));
 assert.ok(page.includes("if(typeof handle.createWritable==='function')"));
});
test('browser upload recovery resumes from the server manifest after the same file is selected again',()=>{
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8'),page=html();
 assert.ok(server.includes("req.query.manifest==='1'"));assert.ok(server.includes('uploadedChunks=chunks.map(x=>x.index)'));assert.ok(server.includes('target_client_id,direction,file_name'));
 for(const value of ['phonebridge-upload-resume-v1','lastModified:file.lastModified','firstHash:fingerprint.firstHash,lastHash:fingerprint.lastHash','startOrResumeTransfer(file','savedChunk?.sha256===digest','prepared.uploadedChunks','choose the same file again to resume'])assert.ok(page.includes(value),'missing '+value);
 assert.ok(!page.includes("if(state.transfer.status==='uploading')await api('/api/transfers/'+transferId,{method:'DELETE'})"));
});

test('phone browser delivery resumes verified OPFS chunks and avoids large in-memory fallback',()=>{
 const page=html();
 for(const value of ['typeof handle.createWritable===\'function\'','createWritable({keepExistingData:true})','position:index*chunkSize','existing.slice(offset,offset+expected)','meta.sha256','fileSize>256*1024*1024','writable persistent file handle'])assert.ok(page.includes(value),'missing '+value);
});


test('live screen relay authenticates paired Windows frames and serves owner-scoped JPEG polling for all browsers',()=>{
 const page=html();
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 const routes=fs.readFileSync(path.join(root,'agent/screen-relay-routes.js'),'utf8');
 const worker=fs.readFileSync(path.join(root,'agent/cloud-worker.js'),'utf8');
 const capture=fs.readFileSync(path.join(root,'agent/screen-capture.js'),'utf8');
 assert.match(server,/installScreenRelayRoutes/);assert.match(routes,/device_agents[\s\S]*?token_hash[\s\S]*?enabled/);assert.match(routes,/requireOwner\(req,res\)/);assert.match(routes,/api\/screen\/frame/);assert.match(routes,/X-PB-Frame-At/);assert.match(routes,/Content-Type','image\/jpeg/);
 assert.match(worker,/captureScreenJpeg\(\)/);assert.match(worker,/api\/agent\/screen\/frame/);assert.match(capture,/gdigrab/);assert.match(capture,/image2pipe/);assert.match(page,/api\/screen\/frame\?ticket=/);assert.match(page,/pathOnly===\x27\/api\/screen\/ticket\x27&&method===\x27POST\x27/);assert.match(page,/setInterval\(pollLiveScreenFrame,400\)/);
});
