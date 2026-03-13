import crypto from 'crypto';
import { verifyToken } from '../services/collab/tokenService.js';
import { ALLOW_LOCAL_AUTH_BYPASS, COLLAB_REQUIRE_TOKEN, COLLAB_TOKEN_SECRET, OWNER_TOKEN_SECRET, PORT, TUNNEL_MODE } from '../config/constants.js';

export function getBearerToken(req) {
  const header = req.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

export function getQueryToken(req) {
  const token = req.query?.token;
  if (!token) return null;
  if (Array.isArray(token)) return token[0];
  return String(token);
}

export function isTunnelMode() {
  return !['false', '0', 'no'].includes(TUNNEL_MODE.toLowerCase().trim());
}

export function isLocalAddress(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('::ffff:127.0.0.1')) return true;
  return false;
}

function isAllowedLocalHost(host) {
  if (!host) return false;
  const normalized = String(host).toLowerCase();
  return normalized === `localhost:${PORT}`
    || normalized === `127.0.0.1:${PORT}`
    || normalized === `[::1]:${PORT}`;
}

function hasForwardingHeaders(req) {
  return Boolean(
    req.headers?.forwarded
    || req.headers?.['x-forwarded-for']
    || req.headers?.['x-forwarded-host']
    || req.headers?.['x-forwarded-proto']
    || req.headers?.['x-real-ip']
  );
}

export function getClientIp(req) {
  return req.socket?.remoteAddress || req.ip || '';
}

function verifyOwnerToken(token) {
  if (!OWNER_TOKEN_SECRET || !token) {
    return null;
  }
  const expected = crypto.createHash('sha256').update(OWNER_TOKEN_SECRET).digest('hex');
  const actual = crypto.createHash('sha256').update(String(token)).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }
  return { role: 'owner' };
}

function requireScopedBearerToken(req) {
  const token = getBearerToken(req);
  const payload = verifyToken(token);
  if (!payload) return { ok: false, payload: null };
  return { ok: true, payload };
}

export function requireTokenFromQuery(req) {
  if (!COLLAB_REQUIRE_TOKEN || !COLLAB_TOKEN_SECRET) return { ok: false, payload: null };
  const token = getQueryToken(req);
  const payload = verifyToken(token);
  if (!payload) return { ok: false, payload: null };
  return { ok: true, payload };
}

export function isLocalBootstrapAllowed(req) {
  if (!ALLOW_LOCAL_AUTH_BYPASS || isTunnelMode() || hasForwardingHeaders(req) || !isLocalAddress(getClientIp(req))) {
    return false;
  }
  const origin = req.headers?.origin;
  const referer = req.headers?.referer;
  if (origin) {
    try {
      return isAllowedLocalHost(new URL(String(origin)).host);
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      return isAllowedLocalHost(new URL(String(referer)).host);
    } catch {
      return false;
    }
  }
  return false;
}

export function requireOwnerAuth(req) {
  if (!OWNER_TOKEN_SECRET) return { ok: false, payload: null };
  const token = getBearerToken(req);
  const payload = verifyOwnerToken(token);
  if (!payload) return { ok: false, payload: null };
  return { ok: true, payload };
}

export function requireAuthIfRemote(req) {
  const ownerAuth = requireOwnerAuth(req);
  if (ownerAuth.ok) {
    return ownerAuth;
  }
  if (!COLLAB_REQUIRE_TOKEN || !COLLAB_TOKEN_SECRET) {
    return { ok: false, payload: null };
  }
  return requireScopedBearerToken(req);
}

export function authorizeProjectAccess(req, projectId, auth = null) {
  const effectiveProjectId = typeof projectId === 'string' ? projectId.trim() : '';
  if (!effectiveProjectId) {
    return { ok: false, statusCode: 400, error: 'Missing project id', payload: null };
  }
  const authResult = auth || requireAuthIfRemote(req);
  if (!authResult.ok) {
    return { ok: false, statusCode: 401, error: 'Unauthorized', payload: null };
  }
  const payload = authResult.payload || req.collabAuth || null;
  if (!payload) {
    return { ok: true, statusCode: 200, error: null, payload: null };
  }
  if (payload.role === 'owner') {
    return { ok: true, statusCode: 200, error: null, payload };
  }
  if (payload.projectId !== effectiveProjectId) {
    return { ok: false, statusCode: 403, error: 'Forbidden', payload };
  }
  return { ok: true, statusCode: 200, error: null, payload };
}
