'use strict';

/*
 * Autenticação e autorização — sem dependências externas.
 * Senha: scrypt (KDF nativo do Node). Sessão: token assinado por HMAC guardado
 * num cookie httpOnly (SameSite=Lax). Segredo persistido em data/auth-secret.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'zcd_session';
const SESSION_DAYS = 30;

// ── Segredo de assinatura (persistido para as sessões sobreviverem a restart) ──
function loadSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const dir = path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'auth-secret');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    fs.mkdirSync(dir, { recursive: true });
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch (e) {
    console.warn('[auth] não foi possível persistir o segredo; usando um efêmero:', e.message);
    return crypto.randomBytes(48).toString('hex');
  }
}
const SECRET = loadSecret();

// ── Senha ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(test, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Token de sessão (payload.assinatura, ambos base64url) ──
const b64 = (buf) => Buffer.from(buf).toString('base64url');
function signSession(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}

// ── Cookies ──
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(res, userId) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const token = signSession({ uid: String(userId), exp });
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function sessionUserId(req) {
  const payload = verifySession(readCookie(req, COOKIE));
  return payload ? payload.uid : null;
}

// ── Autorização por cliente ──
// Nível efetivo do usuário para um cliente: 'admin' | 'edit' | 'view' | null.
function accessLevel(user, clientId) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  const id = String(clientId);
  const grant = (user.access || []).find((a) => String(a.client) === id);
  return grant ? grant.level : null;
}
const canView = (user, clientId) => accessLevel(user, clientId) != null;
const canEdit = (user, clientId) => ['admin', 'edit'].includes(accessLevel(user, clientId));

module.exports = {
  COOKIE, hashPassword, verifyPassword, signSession, verifySession,
  readCookie, setSessionCookie, clearSessionCookie, sessionUserId,
  accessLevel, canView, canEdit,
};
