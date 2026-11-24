'use strict';

const net = require('node:net');

function getClientAddress(req, runningOnRender = process.env.RENDER === 'true') {
  const cloudflareAddress = req.get?.('cf-connecting-ip') || req.headers?.['cf-connecting-ip'];
  if (runningOnRender && typeof cloudflareAddress === 'string' && net.isIP(cloudflareAddress.trim())) {
    return cloudflareAddress.trim().toLowerCase();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

module.exports = { getClientAddress };
