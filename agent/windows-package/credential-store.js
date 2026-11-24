'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{40,50}$/;

function normalizeCredentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Credential file is not a JSON object.');
  // Earlier packaged agents used id/token keys. Convert those locally to the current
  // schema instead of treating a valid credential as irrecoverably corrupt.
  const deviceId = input.deviceId || input.id;
  const agentToken = input.agentToken || input.token;
  const deviceName = input.deviceName || input.name || 'Windows computer';
  const installationId = input.installationId;
  let cloudUrl=input.cloudUrl;
  if(cloudUrl!==undefined){
    let parsed;
    try{parsed=new URL(cloudUrl);}catch(_){throw new Error('Saved cloud URL is invalid.');}
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('Saved cloud URL is invalid.');
    cloudUrl=parsed.origin;
  }
  if (!uuidPattern.test(deviceId || '') || !tokenPattern.test(agentToken || '') ||
      typeof deviceName !== 'string' || deviceName.length > 80 ||
      (installationId !== undefined && !uuidPattern.test(installationId))) {
    throw new Error('Credential file has an unsupported or incomplete format.');
  }
  return {
    deviceId, deviceName, agentToken, installationId:installationId || crypto.randomUUID(),
    ...(cloudUrl?{cloudUrl}:{}),
    ...(typeof input.enrolledAt==='string'?{enrolledAt:input.enrolledAt}:{})
  };
}

function readCredentials(filePath) {
  if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error('Agent credential file must not be a symbolic link.');
  return normalizeCredentials(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function writeCredentials(filePath, credentials, secureFile = () => {}) {
  const normalized = normalizeCredentials(credentials);
  const tempPath = filePath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), { mode:0o600, flag:'wx' });
    secureFile(tempPath);
    fs.renameSync(tempPath, filePath);
    secureFile(filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
  return normalized;
}

module.exports = { normalizeCredentials, readCredentials, writeCredentials, uuidPattern, tokenPattern };
