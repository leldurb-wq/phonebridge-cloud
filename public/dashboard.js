import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const $ = id => document.getElementById(id);
const workspace = $('workspace');
const statusBox = $('workspaceStatus');
const recoveryLink = new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery';
let supabase = null;
let currentUser = null;
let refreshTimer = null;
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
init();
