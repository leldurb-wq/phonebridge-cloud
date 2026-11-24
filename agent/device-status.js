'use strict';

const ONLINE_WINDOW_MS = 90_000;

function isDeviceOnline(enabled, lastSeenAt, now = Date.now()) {
  if (enabled !== true || typeof lastSeenAt !== 'string') return false;
  const age = now - Date.parse(lastSeenAt);
  return Number.isFinite(age) && age >= 0 && age < ONLINE_WINDOW_MS;
}

module.exports = { isDeviceOnline, ONLINE_WINDOW_MS };
