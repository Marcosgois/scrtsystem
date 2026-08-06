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
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;

// ── Segredo de assinatura (persistido para as sessões sobreviverem a restart) ──
function loadSecret() {
  if (process.env.AUTH_SECRET) return String(process.env.AUTH_SECRET).trim();
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
// Fail-closed: um segredo vazio/curto (arquivo truncado, env com espaços) permitiria
// forjar tokens de sessão. Aborta o boot em vez de seguir com HMAC fraco.
if (!SECRET || SECRET.length < 32) {
  console.error('[auth] AUTH_SECRET ausente ou curto demais (< 32 chars). Abortando por segurança.');
  process.exit(1);
}

// ── Senha (scrypt) ──
// Parâmetros atuais (recomendação OWASP: N=2^17). Ficam gravados junto do hash
// para permitir upgrade incremental sem travar quem tem hash antigo.
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024; // 128*N*r ≈ 134 MB para N=2^17; o default de 32 MB não cabe
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

const encodeParams = (o) => `N=${o.N},r=${o.r},p=${o.p}`;
function decodeParams(s) {
  const o = { N: 16384, r: 8, p: 1 }; // sem params = defaults antigos do Node
  if (s) for (const kv of String(s).split(',')) { const [k, v] = kv.split('='); if (k && v && o[k.trim()] !== undefined) o[k.trim()] = Number(v); }
  return o;
}
function scrypt(password, salt, p) {
  return crypto.scryptSync(String(password), salt, KEYLEN, { N: p.N, r: p.r, p: p.p, maxmem: MAXMEM }).toString('hex');
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: scrypt(password, salt, SCRYPT), params: encodeParams(SCRYPT) };
}
function verifyPassword(password, salt, hash, params) {
  if (!salt || !hash) return false;
  let test;
  try { test = scrypt(password, salt, decodeParams(params)); } catch (e) { return false; }
  const a = Buffer.from(test, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// true se o hash usa parâmetros abaixo dos atuais (re-hashear no próximo login).
function needsRehash(params) { return decodeParams(params).N < SCRYPT.N; }
// Gasta o mesmo CPU de um verify quando o e-mail não existe, para o tempo de
// resposta não revelar se a conta existe (anti-enumeração).
function dummyVerify(password) { try { scrypt(password, DUMMY_SALT, SCRYPT); } catch (e) { /* ignore */ } }

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
// Atributos comuns ao cookie de sessão. Em produção ele ganha Secure, e daí sai
// uma consequência que não é óbvia: servir a aplicação em HTTP puro com
// NODE_ENV=production faz o navegador DESCARTAR o cookie — o login falha sem
// mensagem nenhuma. Atrás de um proxy reverso, portanto, o TLS não é opcional.
function cookieAttrs() {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  return attrs;
}
function setSessionCookie(res, user) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const uid = String((user && user._id) || user);
  const tv = Number((user && user.tokenVersion) || 0);
  const token = signSession({ uid, tv, exp });
  const attrs = [`${COOKIE}=${token}`, ...cookieAttrs(), `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`];
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  // Os mesmos atributos da emissão: um cookie Secure não é apagado por um
  // Set-Cookie que difira nos flags em alguns navegadores.
  res.setHeader('Set-Cookie', [`${COOKIE}=`, ...cookieAttrs(), 'Max-Age=0'].join('; '));
}
function sessionPayload(req) {
  return verifySession(readCookie(req, COOKIE));
}
function sessionUserId(req) {
  const payload = sessionPayload(req);
  return payload ? payload.uid : null;
}

// ── Autorização por cliente ──
// Nível efetivo do usuário para um cliente: 'admin' | 'edit' | 'view' | null.
function accessLevel(user, clientId) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  const id = String(clientId);
  const grant = (user.access || []).find((a) => String(a.client) === id);
  if (grant) return grant.level;
  // GERENTE: piso de 'view' em TODO cliente — inclusive nos criados depois.
  // É de propósito que isto não sincronize uma lista de acessos na criação do
  // cliente: lista precisaria de gancho na criação E de backfill dos existentes,
  // e sairia do ar no dia em que alguém criasse cliente por outro caminho.
  // Uma concessão explícita acima continua valendo e pode elevar para 'edit'.
  if (user.role === 'manager') return 'view';
  return null;
}
const canView = (user, clientId) => accessLevel(user, clientId) != null;
const canEdit = (user, clientId) => ['admin', 'edit'].includes(accessLevel(user, clientId));

module.exports = {
  COOKIE, hashPassword, verifyPassword, needsRehash, dummyVerify, signSession, verifySession,
  readCookie, setSessionCookie, clearSessionCookie, sessionUserId, sessionPayload,
  accessLevel, canView, canEdit,
};
