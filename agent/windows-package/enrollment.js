'use strict';

const crypto = require('node:crypto');
const { normalizeCredentials, uuidPattern, tokenPattern } = require('./credential-store');

async function redeemPairingCode({ code, previous = null, cloudUrl, exchange }) {
  if (typeof exchange !== 'function') throw new TypeError('Enrollment exchange is required.');
  const installationId = previous?.installationId || crypto.randomUUID();
  const result = await exchange({
    enrollmentCode: code,
    installationId,
    previousDeviceId: previous?.deviceId || null
  });
  if (!result || !uuidPattern.test(result.deviceId || '') || !tokenPattern.test(result.agentToken || '') ||
      typeof result.deviceName !== 'string' || !result.deviceName.trim() || result.deviceName.length > 80) return null;
  return normalizeCredentials({
    deviceId: result.deviceId,
    deviceName: result.deviceName,
    agentToken: result.agentToken,
    installationId,
    cloudUrl,
    enrolledAt: new Date().toISOString()
  });
}

module.exports = { redeemPairingCode };
