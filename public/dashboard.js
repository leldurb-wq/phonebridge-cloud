import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const $ = id => document.getElementById(id);
const workspace = $('workspace');
const appHome = $('appHome');
const statusBox = $('workspaceStatus');
const recoveryLink = new URLSearchParams(location.search).get('password_recovery') === '1' || new URLSearchParams(location.search).get('type') === 'recovery' || new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery';
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
  $('mainDeviceList').innerHTML = devices.length ? devices.map(d => `<div class="command-row"><b>${escapeHtml(d.name)}</b><span>${d.connected ? 'Online' : 'Offline'}</span><small>${escapeHtml(d.deviceType || 'Windows computer')} · ${d.lastSeenAt ? 'Last seen ' + escapeHtml(new Date(d.lastSeenAt).toLocaleString()) : 'Agent has not connected yet'}</small><button type="button" data-open-device="${escapeHtml(d.id)}">View computer</button></div>`).join('') : '<p class="sub">No computer paired yet. Use Pair a computer to get started.</p>';
  const list = $('deviceList');
  if (!devices.length) {
    list.innerHTML = '<p class="sub">No devices paired yet. Start pairing from the main workspace.</p>';
    $('commandPanel').classList.add('hidden');
    return;
  }
  const selected=document.querySelector('input[name="device"]:checked')?.value;
  list.innerHTML = devices.map(d => `<label class="device-option"><input type="radio" name="device" value="${escapeHtml(d.id)}" ${d.id===selected?'checked':''}><span><b>${escapeHtml(d.name)}</b><small>${escapeHtml(d.deviceType || 'Windows computer')} · ${d.connected ? 'Online' : 'Offline'}</small></span></label>`).join('');
  if(!selected||!devices.some(d=>d.id===selected))list.querySelector('input')?.click();
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
function markUnsupportedPanels() {
  const unavailable = new Map([
    ['4. Live screen view','Screen capture is not available in the cloud worker yet.'],
    ['5. Remote mouse & keyboard','Remote mouse and keyboard control is not available in the cloud worker yet.']
  ]);
  for (const panel of document.querySelectorAll('#workspace .dashboard-grid > .dashboard-panel')) {
    const heading=panel.querySelector('h3')?.textContent.trim();
    if (!unavailable.has(heading)) continue;
    panel.replaceChildren(Object.assign(document.createElement('h3'),{textContent:'Not available yet'}));
    const note=document.createElement('p');
    note.className='dashboard-note';
    note.textContent=unavailable.get(heading);
    panel.append(note);
  }
}
async function runUi(action, payload) {
  try {
    status('Sending task…');
    await queueCommand(action, payload);
  } catch (e) { status(e.message, true); }
}
function bindUi() {
  markUnsupportedPanels();
  $('pairDeviceButton').addEventListener('click', createEnrollment);
  $('copyPairCode').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('pairCode').value); status('Six-digit pairing code copied. Enter it only on the Windows computer you want to approve.'); }
    catch { $('pairCode').select(); status('Select and copy the pairing code manually.'); }
  });
  $('mainRefreshDevices').addEventListener('click', async () => { try { await loadDevices(); status('Your paired devices are refreshed.'); } catch (e) { status(e.message, true); } });
  $('mainDeviceList').addEventListener('click',event=>{const button=event.target.closest('[data-open-device]');if(!button)return;const radio=[...document.querySelectorAll('input[name="device"]')].find(item=>item.value===button.dataset.openDevice);if(radio)radio.click();appHome.classList.add('hidden');workspace.classList.remove('hidden');loadCommands().catch(e=>status(e.message,true));});
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
  $('deviceList').addEventListener('change', () => loadCommands().catch(e => status(e.message, true)));
}
async function activateSession(session) {
  if (!session?.user) return;
  currentUser = session.user;
  appHome.classList.remove('hidden');
  workspace.classList.add('hidden');
  $('authCard').classList.add('hidden');
  $('accountLabel').textContent = session.user.email || 'Signed in';
  if (!uiBound) {
    bindUi();
    $('signOut').addEventListener('click', async () => { await supabase.auth.signOut(); });
    $('openAgentConsole').addEventListener('click', () => { appHome.classList.add('hidden'); workspace.classList.remove('hidden'); });
    $('backToHome').addEventListener('click', () => { workspace.classList.add('hidden'); appHome.classList.remove('hidden'); });
    uiBound = true;
  }
  clearInterval(refreshTimer);
  try {
    await loadDevices();
    await loadCommands();
    refreshTimer = setInterval(async () => { try { await loadDevices(); await loadCommands(); } catch (_) {} }, 10000);
  } catch (e) { status(e.message || 'Could not load your devices.', true); }
}
function deactivateSession() {
  clearInterval(refreshTimer);
  refreshTimer = null;
  currentUser = null;
  workspace.classList.add('hidden');
  appHome.classList.add('hidden');
  $('authCard').classList.remove('hidden');
}
async function init() {
  try {
    const configResponse = await fetch('/config', { cache: 'no-store' });
    const config = await configResponse.json();
    if (!configResponse.ok || !config.ready) return;
    supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
    supabase.auth.onAuthStateChange((event, nextSession) => {
      // A recovery link must show the password form, not the workspace.
      if (event === 'PASSWORD_RECOVERY') { deactivateSession(); return; }
      // Defer Supabase calls until after its auth callback completes.
      setTimeout(() => {
        if (recoveryLink) deactivateSession();
        else if (nextSession) activateSession(nextSession);
        else deactivateSession();
      }, 0);
    });
    const { data: { session } } = await supabase.auth.getSession();
    if (recoveryLink) deactivateSession();
    else if (session) await activateSession(session);
  } catch (e) { status(e.message || 'Could not load your workspace.', true); }
}
// The login page owns the recovery callback and token exchange. Do not create a second Supabase client on recovery URLs.
if (!recoveryLink) init();
