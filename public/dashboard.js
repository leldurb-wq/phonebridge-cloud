import { resolveCustomerView } from './auth-routing.mjs';

const $ = id => document.getElementById(id);
const workspace = $('customerDeviceWorkspace');
const appHome = $('appHome');
const statusBox = $('workspaceStatus');
let supabase = null;
let currentUser = null;
let refreshTimer = null;
let uiBound = false;

function status(message, error = false) {
  const className = 'message show' + (error ? ' error' : '');
  statusBox.textContent = message;
  statusBox.className = className;
  const mainStatus = $('mainStatus');
  if (mainStatus) { mainStatus.textContent = message; mainStatus.className = className; }
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Please sign in again.');
  return { authorization: 'Bearer ' + session.access_token, 'content-type': 'application/json' };
}
async function loadDevices() {
  const headers = await authHeaders();
  const response = await fetch('/api/devices', { headers, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not load devices.');
  const devices = result.devices || [];
  $('mainDeviceList').innerHTML = devices.length ? devices.map(d => `<div class="command-row"><b>${escapeHtml(d.name)}</b><span>${d.connected ? 'Online' : 'Offline'}</span><small>${escapeHtml(d.deviceType || 'Windows computer')} · ${d.lastSeenAt ? 'Last seen ' + escapeHtml(new Date(d.lastSeenAt).toLocaleString()) : 'Agent has not connected yet'}</small><div><button type="button" data-open-device="${escapeHtml(d.id)}">Open</button><button type="button" data-rename-device="${escapeHtml(d.id)}">Rename</button><button type="button" data-revoke-device="${escapeHtml(d.id)}">Remove</button></div></div>`).join('') : '<p class="sub">No computer paired yet. Use Pair a Device to get started.</p>';
  const list = $('deviceList');
  if (!devices.length) {
    list.innerHTML = '<p class="sub">No devices paired yet. Start pairing from the main workspace.</p>';
    $('commandPanel').classList.add('hidden');
    return;
  }
  const selected=document.querySelector('input[name="device"]:checked')?.value;
  list.innerHTML = devices.map(d => `<label class="device-option"><input type="radio" name="device" value="${escapeHtml(d.id)}" ${d.id===selected?'checked':''}><span><b>${escapeHtml(d.name)}</b><small>${escapeHtml(d.deviceType || 'Windows computer')} · ${d.connected ? 'Online' : 'Offline'}</small></span></label>`).join('');
  if(!selected||!devices.some(d=>d.id===selected)){
    const firstDevice=list.querySelector('input');
    if(firstDevice)firstDevice.checked=true;
  }
  $('commandPanel').classList.remove('hidden');
}
async function createEnrollment() {
  const name = $('pairDeviceName').value.trim();
  if (!name) return status('Enter a name for your computer.', true);
  $('pairDeviceButton').disabled = true;
  try {
    const headers = await authHeaders();
    const response = await fetch('/api/enrollments', { method: 'POST', headers, body: JSON.stringify({ deviceName: name }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start pairing.');
    $('pairCode').value = data.enrollmentCode;
    $('agentCommand').textContent = 'Double-click Start-PhoneBridge-Agent.cmd in the extracted agent folder, then enter the code shown above.';
    $('pairCodePanel').classList.remove('hidden');
    status('Six-digit code created. Enter it on the Windows computer to approve pairing. This page will refresh the device list while you wait.');
  } catch (e) { status(e.message, true); }
  finally { $('pairDeviceButton').disabled = false; }
}
async function queueCommand(action, payload = {}) {
  const deviceId = document.querySelector('input[name="device"]:checked')?.value;
  if (!deviceId) throw new Error('Select a device first.');
  const headers = await authHeaders();
  const approved = ['write_file','create_folder'].includes(action);
  const response = await fetch('/api/commands', { method: 'POST', headers, body: JSON.stringify({ deviceId, action, payload, approved }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not queue this task.');
  status('Task queued. Your ThinkPad must be enrolled and its cloud worker running to receive it.');
  await loadCommands();
}
async function loadCommands() {
  const deviceId = document.querySelector('input[name="device"]:checked')?.value;
  if (!deviceId) return;
  const { data, error } = await supabase.from('device_commands').select('id,action,status,error_message,result,created_at,completed_at').eq('device_id', deviceId).order('created_at', { ascending: false }).limit(8);
  if (error) throw error;
  $('commandList').innerHTML = (data || []).map(c => {
    const detail = c.error_message || (c.result ? JSON.stringify(c.result) : '');
    return `<div class="command-row"><b>${escapeHtml(c.action)}</b><span>${escapeHtml(c.status)}</span><small>${escapeHtml(new Date(c.created_at).toLocaleTimeString())}${detail ? ' · ' + escapeHtml(detail.slice(0, 1200)) : ''}</small></div>`;
  }).join('') || '<p class="sub">No tasks yet.</p>';
}
async function runUi(action, payload) {
  try {
    status('Sending task…');
    await queueCommand(action, payload);
  } catch (e) { status(e.message, true); }
}
function bindUi() {
  $('pairDeviceButton').addEventListener('click', createEnrollment);
  $('copyPairCode').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('pairCode').value); status('Six-digit pairing code copied. Enter it only on the Windows computer you want to approve.'); }
    catch { $('pairCode').select(); status('Select and copy the pairing code manually.'); }
  });
  $('mainRefreshDevices').addEventListener('click', async () => { try { await loadDevices(); status('Your paired devices are refreshed.'); } catch (e) { status(e.message, true); } });
  $('mainDeviceList').addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    const deviceId=button.dataset.openDevice||button.dataset.renameDevice||button.dataset.revokeDevice;
    if(button.dataset.openDevice){showDeviceWorkspace(deviceId);return;}
    if(button.dataset.renameDevice){
      const current=button.closest('.command-row')?.querySelector('b')?.textContent||'';
      const name=window.prompt('New name for this computer:',current)?.trim();
      if(!name||name===current)return;
      try{const response=await fetch('/api/devices/'+encodeURIComponent(deviceId),{method:'PATCH',headers:await authHeaders(),body:JSON.stringify({name})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not rename computer.');await loadDevices();status('Computer renamed.');}catch(e){status(e.message,true);}return;
    }
    if(button.dataset.revokeDevice){
      const name=button.closest('.command-row')?.querySelector('b')?.textContent||'this computer';
      if(!window.confirm(`Remove ${name} from your account? Its saved agent credential will no longer authenticate.`))return;
      try{const response=await fetch('/api/devices/'+encodeURIComponent(deviceId),{method:'DELETE',headers:await authHeaders()});const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not remove computer.');if(document.querySelector('input[name="device"]:checked')?.value===deviceId)try{sessionStorage.removeItem('pb-device-view');}catch{}await loadDevices();showDashboard();status('Computer removed. Pair it again to reconnect.');}catch(e){status(e.message,true);}
    }
  });
  $('customerNav').addEventListener('click',event=>{
    const button=event.target.closest('[data-page]');if(!button)return;
    const page=button.dataset.page;
    document.querySelectorAll('#customerNav [data-page]').forEach(item=>item.setAttribute('aria-current',String(item===button)));
    $('featurePlaceholder').classList.add('hidden');
    if(page==='home'){showDashboard('home');return;}
    if(page==='pairing'||page==='setup'){showDashboard(page);$('pairDevicePanel').scrollIntoView({behavior:'smooth',block:'start'});return;}
    if(page==='computer'||page==='workspace'){
      const device=document.querySelector('input[name="device"]:checked');
      if(device){showDeviceWorkspace(device.value);return;}
      showDashboard(page);status('Pair a computer to open its device workspace.',true);return;
    }
    const unavailable={
      transfer:['File transfer','Secure browser-to-computer file transfer is not implemented in the cloud worker yet. Current device file actions are limited to listing, reading and writing small text files inside the PhoneBridge workspace.'],
      drive:['Drive','The private cloud file library is not connected to this application yet. The legacy desktop library uses local storage and cannot safely serve multi-user cloud accounts.'],
      dualAi:['Dual AI','No authenticated Dual AI provider is configured in the cloud application.'],
      aiControl:['AI Control Room','No server-side AI Control Room integration is configured. No simulated responses are shown.'],
      audio:['Audio Player','Authenticated audio streaming from a paired computer is not implemented.'],
      video:['Video Player','Authenticated video streaming from a paired computer is not implemented.'],
      sync:['Sync','Cross-device file and workspace synchronization is not implemented in the cloud application.'],
      security:['Security','Device actions use your signed-in account. Pairing codes expire after five minutes and are single-use; device credentials are server-validated. Remove a paired computer from Home to revoke it.'],
      help:['Help','Pair a Windows Agent from Home. It connects outbound to the cloud and does not require a shared Wi-Fi network or router port forwarding.']
    };
    const [title,copy]=unavailable[page]||['PhoneBridge', 'This workspace section is not available.'];
    $('featureTitle').textContent=title;$('featureCopy').textContent=copy;
    showDashboard(page);$('featurePlaceholder').classList.remove('hidden');$('featurePlaceholder').scrollIntoView({behavior:'smooth',block:'start'});
  });
  $('deviceList').addEventListener('change',()=>{const selected=document.querySelector('input[name="device"]:checked');if(selected){try{sessionStorage.setItem('pb-device-view',selected.value);}catch{}}loadCommands().catch(e=>status(e.message,true));});
  $('systemInfo').addEventListener('click', () => runUi('system_info'));
  $('listFiles').addEventListener('click', () => runUi('list_files', { path: '.' }));
  $('readFile').addEventListener('click', () => {
    const path = $('filePath').value.trim();
    if (!path) return status('Enter a relative file path inside the PhoneBridge workspace.', true);
    runUi('read_file', { path });
  });
  $('launchApp').addEventListener('click', () => runUi('launch_app', { app: $('appChoice').value }));
  $('createFolder').addEventListener('click', () => {
    const path = $('folderPath').value.trim();
    if (!path) return status('Enter a folder path inside the PhoneBridge workspace.', true);
    if (!window.confirm('Approve creating this folder on your ThinkPad?\n\n' + path)) return;
    runUi('create_folder', { path });
  });
  $('writeFile').addEventListener('click', () => {
    const path = $('writePath').value.trim(), content = $('writeContent').value;
    if (!path) return status('Enter a file path inside the PhoneBridge workspace.', true);
    if (!window.confirm('Approve writing or replacing this file on your ThinkPad?\n\n' + path)) return;
    runUi('write_file', { path, content });
  });
  $('refreshDevices').addEventListener('click', async () => { try { await loadDevices(); await loadCommands(); status('Device list refreshed.'); } catch (e) { status(e.message, true); } });
  $('backToHome').addEventListener('click',showDashboard);
}
function showDashboard(page='home'){
  workspace.classList.add('hidden');appHome.classList.remove('hidden');
  document.querySelectorAll('#customerNav [data-page]').forEach(item=>item.setAttribute('aria-current',String(item.dataset.page===page)));
  try{sessionStorage.removeItem('pb-device-view');}catch{}
}
function showDeviceWorkspace(deviceId){
  const radio=[...document.querySelectorAll('input[name="device"]')].find(item=>item.value===deviceId);
  if(!radio)return status('That computer is no longer in your account. Refresh the device list.',true);
  radio.checked=true;
  try{sessionStorage.setItem('pb-device-view',deviceId);}catch{}
  appHome.classList.add('hidden');workspace.classList.remove('hidden');
  loadCommands().catch(e=>status(e.message,true));
}
async function activateSession(session) {
  if (!session?.user) return;
  currentUser = session.user;
  appHome.classList.remove('hidden');
  workspace.classList.add('hidden');
  $('accountEmail').textContent = session.user.email || 'Email not available';
  if (!uiBound) {
    bindUi();
    uiBound = true;
  }
  clearInterval(refreshTimer);
  try {
    await loadDevices();
    await loadCommands();
    let requestedDevice='';
    try{requestedDevice=sessionStorage.getItem('pb-device-view')||'';}catch{}
    if(requestedDevice&&[...document.querySelectorAll('input[name="device"]')].some(input=>input.value===requestedDevice)){
      workspace.classList.remove('hidden');appHome.classList.add('hidden');
    }else if(requestedDevice){try{sessionStorage.removeItem('pb-device-view');}catch{}}
    refreshTimer = setInterval(async () => { try { await loadDevices(); await loadCommands(); } catch (_) {} }, 10000);
  } catch (e) { status(e.message || 'Could not load your devices.', true); }
}
/** Use the Supabase client already initialized by the homepage's account flow. */
export async function activateCustomerDashboard(client, session) {
  if (!client || resolveCustomerView(session) !== 'dashboard') return;
  supabase = client;
  await activateSession(session);
  document.body.classList.add('customer-dashboard-active');
}
