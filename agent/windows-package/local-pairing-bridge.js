'use strict';

const http = require('node:http');

const POLL_INTERVAL_MS = 2500;
const MAX_STATUS_FAILURES = 8;

function safeError(error) {
  return String(error?.message || error || 'Unknown pairing error').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}

function createLocalPairingBridge({
  createTicket,
  checkStatus,
  onApproved,
  origin = 'https://phonebridge-cloud.onrender.com',
  port = 32145,
  host = '127.0.0.1'
}) {
  let current = null;
  let closed = false;
  let polling = false;

  const statusSnapshot = () => current ? {
    status: current.status,
    expiresAt: current.expiresAt,
    error: current.error || null,
    lastError: current.lastError || null,
    retryCount: current.statusFailures || 0
  } : {
    status: 'idle',
    expiresAt: null,
    error: null,
    lastError: null,
    retryCount: 0
  };

  const json = (res, status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body)
    });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const requestOrigin = req.headers.origin || '';
    if (requestOrigin !== origin) {
      res.writeHead(403, { 'cache-control': 'no-store' });
      return res.end();
    }

    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type');
    res.setHeader('access-control-allow-private-network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.url === '/health' && req.method === 'GET') {
      return json(res, 200, { ok: true });
    }
    if (req.url === '/pairing/status' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...statusSnapshot() });
    }
    if (req.url !== '/pairing/start' || req.method !== 'POST') {
      return json(res, 404, { ok: false, error: 'Not found.' });
    }

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8192) return json(res, 413, { ok: false, error: 'Request too large.' });
    }

    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Invalid request.' });
    }

    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
    if (accessToken.length < 20 || accessToken.length > 4096) {
      return json(res, 400, { ok: false, error: 'Sign in to PhoneBridge and try again.' });
    }

    if (polling || (current && ['waiting', 'connecting'].includes(current.status) &&
        Date.parse(current.expiresAt) > Date.now())) {
      return json(res, 409, { ok: false, error: 'A pairing request is already active on this computer.' });
    }

    try {
      const ticket = await createTicket(accessToken);
      if (!ticket?.ok || !/^\d{6}$/.test(ticket.pairingCode || '') ||
          !Number.isFinite(Date.parse(ticket.expiresAt || ''))) {
        throw new Error('Cloud returned an invalid pairing ticket.');
      }

      current = {
        code: ticket.pairingCode,
        expiresAt: ticket.expiresAt,
        status: 'waiting',
        statusFailures: 0,
        lastError: null,
        error: null
      };
      void poll();
      return json(res, 201, {
        ok: true,
        pairingCode: current.code,
        expiresAt: current.expiresAt
      });
    } catch (error) {
      return json(res, 502, { ok: false, error: safeError(error) });
    }
  });

  async function poll() {
    if (polling || closed) return;
    polling = true;

    try {
      while (!closed && current?.status === 'waiting') {
        if (Date.parse(current.expiresAt) <= Date.now()) {
          current.status = 'expired';
          break;
        }

        try {
          const result = await checkStatus(current.code);
          if (!result || !['approved', 'waiting', 'expired'].includes(result.status)) {
            throw new Error(result?.error || 'Cloud returned an invalid approval status.');
          }

          current.statusFailures = 0;
          current.lastError = null;

          if (result.status === 'approved') {
            current.status = 'connecting';
            try {
              await onApproved(current.code);
              current.status = 'connected';
              current.error = null;
            } catch (error) {
              current.status = 'error';
              current.error = safeError(error);
            }
            break;
          }

          if (result.status === 'expired') {
            current.status = 'expired';
            break;
          }
        } catch (error) {
          current.statusFailures = (current.statusFailures || 0) + 1;
          current.lastError = safeError(error);

          if (current.statusFailures >= MAX_STATUS_FAILURES) {
            current.status = 'error';
            current.error = 'Phone approval could not be checked after repeated cloud errors: ' + current.lastError;
            break;
          }
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } finally {
      polling = false;
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({
      server,
      getStatus: statusSnapshot,
      close() {
        closed = true;
        server.close();
      }
    }));
  });
}

module.exports = { createLocalPairingBridge };
