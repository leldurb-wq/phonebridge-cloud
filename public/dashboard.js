import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const $ = id => document.getElementById(id);
const workspace = $('workspace');
const statusBox = $('workspaceStatus');
const recoveryLink = new URLSearchParams(location.search).get('password_recovery') === '1' || new URLSearchParams(location.search).get('type') === 'recovery' || new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery';
let supabase = null;
let currentUser = null;
let refreshTimer = null;
let screenTimer = null;
let screenKeepaliveTimer = null;
let screenBusy = false;
let controlBusy = false;
let lastLiveFrameAt = '';
let uiBound = false;

function status(message, error = false) {
  statusBox.textContent = message;
  statusBox.className = 'message show' + (error ? ' error' : '');
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
  const { data, error } = await supabase.from('devices').select('id,name,device_type,last_seen_at,created_at').eq('user_id', currentUser.id).order('created_at', { ascending: false });
  if (error) throw error;
  const list = $('deviceList');
  if (!data?.length) {
    list.innerHTML = '<p class="sub">No devices enrolled yet. Add your ThinkPad below.</p>';
    $('commandPanel').classList.add('hidden');
    return;
  }
  list.innerHTML = data.map(d => `<label class="device-option"><input type="radio" name="device" value="${escapeHtml(d.id)}"><span><b>${escapeHtml(d.name)}</b><small>${escapeHtml(d.device_type)} · Added ${escapeHtml(new Date(d.created_at).toLocaleString())}</small></span></label>`).join('');
  list.querySelector('input')?.click();
  $('commandPanel').classList.remove('hidden');
}
async function createEnrollment() {
  const name = $('deviceName').value.trim();
  if (!name) return status('Enter a name for your ThinkPad.', true);
  $('enrollButton').disabled = true;
  try {
    const headers = await authHeaders();
    const response = await fetch('/api/enrollments', { method: 'POST', headers, body: JSON.stringify({ deviceName: name }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create enrollment.');
    $('ticket').value = data.enrollmentCode;
    $('ticketPanel').classList.remove('hidden');
    status('One-time enrollment ticket created. It expires in 5 minutes. Copy it and enter it locally on your ThinkPad.');
  } catch (e) { status(e.message, true); }
  finally { $('enrollButton').disabled = false; }
}
async function queueCommand(action, payload = {}) {
  const deviceId = document.querySelector('input[name="device"]:checked')?.value;
  if (!deviceId) throw new Error('Select a device first.');
  const headers = await authHeaders();
  const approved = ['write_file','create_folder','desktop_control'].includes(action);
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
  const latestScreen = (data || []).find(c => c.action === 'screen_capture' && c.status === 'completed' && c.result?.imageBase64);
  if (latestScreen) {
    $('screenImage').src = 'data:' + (latestScreen.result.mimeType || 'image/jpeg') + ';base64,' + latestScreen.result.imageBase64;
    $('screenImage').classList.remove('hidden');
    $('screenPlaceholder').classList.add('hidden');
    $('screenStatus').textContent = 'Last captured: ' + new Date(latestScreen.result.capturedAt || latestScreen.completed_at || latestScreen.created_at).toLocaleTimeString();
  }
}
async function requestScreenFrame() {
  if (screenBusy) return;
  screenBusy = true;
  try { await queueCommand('screen_capture'); }
  catch (e) { $('screenStatus').textContent = 'Screen capture failed: ' + e.message; }
  finally { screenBusy = false; }
}
async function pollLiveScreenFrame() {
  const deviceId = document.querySelector('input[name="device"]:checked')?.value;
  if (!deviceId) return;
  try {
    const headers = await authHeaders();
    const response = await fetch('/api/screen-frame?deviceId=' + encodeURIComponent(deviceId), { headers, cache:'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load live frame.');
    const frame = data.frame;
    if (frame?.imageBase64 && frame.capturedAt !== lastLiveFrameAt) {
      lastLiveFrameAt = frame.capturedAt;
      $('screenImage').src = 'data:' + frame.mimeType + ';base64,' + frame.imageBase64;
      $('screenImage').classList.remove('hidden');
      $('screenPlaceholder').classList.add('hidden');
      $('screenStatus').textContent = 'Live · ' + new Date(frame.capturedAt).toLocaleTimeString();
    }
  } catch (e) { $('screenStatus').textContent = 'Live screen error: ' + e.message; }
}
function updateControlAvailability() {
  const enabled = $('controlEnabled').checked && !!screenTimer;
  $('pointerMode').disabled = !enabled;
  $('scrollUp').disabled = !enabled;
  $('scrollDown').disabled = !enabled;
  $('keyChoice').disabled = !enabled;
  $('sendKey').disabled = !enabled;
  $('typeText').disabled = !enabled;
  $('sendText').disabled = !enabled;
  $('screenImage').classList.toggle('control-ready', enabled);
  $('controlStatus').textContent = enabled ? 'Controls enabled. Click the screen image to move or click.' : 'Remote controls are disabled.';
}
async function sendDesktopControl(payload) {
  if (!$('controlEnabled').checked || !screenTimer) throw new Error('Start live screen view and enable remote controls first.');
  if (controlBusy) return;
  controlBusy = true;
  $('controlStatus').textContent = 'Sending control…';
  try {
    await queueCommand('desktop_control', payload);
    $('controlStatus').textContent = 'Control sent to your ThinkPad.';
  } catch (e) {
    $('controlStatus').textContent = 'Control failed: ' + e.message;
  } finally { controlBusy = false; }
}
function screenPoint(event) {
  const image = $('screenImage');
  const rect = image.getBoundingClientRect();
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
  return { x:Math.max(0,Math.min(1,(event.clientX-left)/width)), y:Math.max(0,Math.min(1,(event.clientY-top)/height)) };
}
function stopScreenView() {
  if (screenTimer) clearInterval(screenTimer);
  if (screenKeepaliveTimer) clearInterval(screenKeepaliveTimer);
  screenTimer = null;
  screenKeepaliveTimer = null;
  $('screenStart').disabled = false;
  $('screenStop').disabled = true;
  $('screenStatus').textContent = 'Screen view stopped. The last image remains visible.';
  if ($('controlEnabled')) { $('controlEnabled').checked = false; updateControlAvailability(); }
}
async function runUi(action, payload) {
  try {
    status('Sending task…');
    await queueCommand(action, payload);
  } catch (e) { status(e.message, true); }
}
function bindUi() {
  $('enrollButton').addEventListener('click', createEnrollment);
  $('copyTicket').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('ticket').value); status('Enrollment ticket copied. Paste it into the ThinkPad terminal only.'); }
    catch { $('ticket').select(); status('Select and copy the ticket manually.'); }
  });
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
  $('screenStart').addEventListener('click', async () => {
    if (screenTimer) return;
    $('screenStart').disabled = true;
    $('screenStop').disabled = false;
    $('screenStatus').textContent = 'Starting secure live stream…';
    try {
      await queueCommand('screen_stream_start');
      lastLiveFrameAt = '';
      await pollLiveScreenFrame();
      screenTimer = setInterval(pollLiveScreenFrame, 800);
      screenKeepaliveTimer = setInterval(() => queueCommand('screen_stream_keepalive').catch(() => {}), 20000);
      updateControlAvailability();
    } catch (e) {
      stopScreenView();
      $('screenStatus').textContent = 'Could not start live screen: ' + e.message;
    }
  });
  $('screenStop').addEventListener('click', async () => {
    stopScreenView();
    try { await queueCommand('screen_stream_stop'); }
    catch (e) { $('screenStatus').textContent = 'Stop request failed: ' + e.message; }
  });
  $('controlEnabled').addEventListener('change', () => {
    if ($('controlEnabled').checked && !window.confirm('Enable remote mouse and keyboard control of your ThinkPad? Only enable this while you are watching the screen.')) $('controlEnabled').checked = false;
    updateControlAvailability();
  });
  $('screenImage').addEventListener('click', event => {
    if (!$('controlEnabled').checked || !screenTimer) return;
    const point = screenPoint(event), mode = $('pointerMode').value;
    sendDesktopControl(mode === 'move' ? { type:'move', ...point } : { type:'click', ...point, button:mode });
  });
  $('screenImage').addEventListener('contextmenu', event => event.preventDefault());
  $('scrollUp').addEventListener('click', () => sendDesktopControl({ type:'scroll', delta:360 }));
  $('scrollDown').addEventListener('click', () => sendDesktopControl({ type:'scroll', delta:-360 }));
  $('sendKey').addEventListener('click', () => sendDesktopControl({ type:'key', key:$('keyChoice').value }));
  $('sendText').addEventListener('click', () => {
    const text = $('typeText').value;
    if (!text) return;
    if (!window.confirm('Type this text into the active ThinkPad window?')) return;
    sendDesktopControl({ type:'type', text });
  });
  $('refreshDevices').addEventListener('click', async () => { try { await loadDevices(); await loadCommands(); status('Device list refreshed.'); } catch (e) { status(e.message, true); } });
  $('deviceList').addEventListener('change', () => loadCommands().catch(e => status(e.message, true)));
}
async function activateSession(session) {
  if (!session?.user) return;
  currentUser = session.user;
  workspace.classList.remove('hidden');
  $('authCard').classList.add('hidden');
  $('accountLabel').textContent = session.user.email || 'Signed in';
  if (!uiBound) {
    bindUi();
    $('signOut').addEventListener('click', async () => { await supabase.auth.signOut(); });
    uiBound = true;
  }
  clearInterval(refreshTimer);
  try {
    await loadDevices();
    await loadCommands();
    refreshTimer = setInterval(() => loadCommands().catch(() => {}), 5000);
  } catch (e) { status(e.message || 'Could not load your devices.', true); }
}
function deactivateSession() {
  stopScreenView();
  clearInterval(refreshTimer);
  refreshTimer = null;
  currentUser = null;
  workspace.classList.add('hidden');
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
