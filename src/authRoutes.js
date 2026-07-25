'use strict';

/*
 * Rotas de autenticação + administração de usuários, e os middlewares de
 * autorização (login obrigatório, admin, acesso por cliente). Sem deps externas.
 */

const express = require('express');
const mongoose = require('mongoose');
const { User, ScrtReport } = require('./models');
const auth = require('./auth');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  if (!u) return null;
  return {
    _id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    access: (u.access || []).map((a) => ({ client: String(a.client), level: a.level })),
  };
}

/** Carrega req.user (ou null) a partir do cookie de sessão. */
async function attachUser(req, res, next) {
  try {
    const uid = auth.sessionUserId(req);
    req.user = uid && isValidId(uid) ? await User.findById(uid).lean() : null;
  } catch (e) { req.user = null; }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });
  next();
}
const deny = (res) => res.status(403).json({ error: 'Você não tem acesso a este cliente.' });

/**
 * Controle de acesso por cliente nas rotas /api existentes.
 * Leitura (GET) exige nível 'view'; escrita exige 'edit'. Criar/excluir cliente
 * é só admin. Admin pode tudo.
 */
async function clientAccessGuard(req, res, next) {
  const user = req.user;
  const p = req.path;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  let m;

  // Criar cliente
  if (p === '/clients' && req.method === 'POST') return user.role === 'admin' ? next() : deny(res);

  // /clients/:id exato -> DELETE (admin) / PATCH (edit)
  if ((m = p.match(/^\/clients\/([a-f0-9]{24})$/i))) {
    if (req.method === 'DELETE') return user.role === 'admin' ? next() : deny(res);
    return auth.canEdit(user, m[1]) ? next() : deny(res);
  }
  // /clients/:id/... -> write=edit, read=view
  if ((m = p.match(/^\/clients\/([a-f0-9]{24})\//i))) {
    return (write ? auth.canEdit(user, m[1]) : auth.canView(user, m[1])) ? next() : deny(res);
  }
  // /reports/:id e /reports/:id/file -> resolve o cliente do relatório
  if ((m = p.match(/^\/reports\/([a-f0-9]{24})(\/file)?$/i))) {
    const rep = await ScrtReport.findById(m[1]).select('client').lean();
    if (!rep) return next(); // 404 vem do handler
    return (write ? auth.canEdit(user, rep.client) : auth.canView(user, rep.client)) ? next() : deny(res);
  }
  next(); // /clients (lista) e /inventories são filtrados no próprio handler
}

// ── Rotas públicas de auth ──
const authRouter = express.Router();

authRouter.get('/status', asyncHandler(async (req, res) => {
  const count = await User.estimatedDocumentCount();
  res.json({ needsSetup: count === 0, user: publicUser(req.user) });
}));

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado.' });
  res.json(publicUser(req.user));
});

authRouter.post('/setup', asyncHandler(async (req, res) => {
  const count = await User.estimatedDocumentCount();
  if (count > 0) return res.status(409).json({ error: 'O sistema já tem usuários — peça a um admin.' });
  const { name, email, password } = req.body || {};
  const err = validateCreate({ name, email, password });
  if (err) return res.status(400).json({ error: err });
  const { salt, hash } = auth.hashPassword(password);
  const user = await User.create({ name: String(name).trim(), email: String(email).toLowerCase().trim(), passwordHash: hash, passwordSalt: salt, role: 'admin', access: [] });
  auth.setSessionCookie(res, user._id);
  res.status(201).json(publicUser(user));
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');
  const user = await User.findOne({ email });
  if (!user || !auth.verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  auth.setSessionCookie(res, user._id);
  res.json(publicUser(user));
}));

authRouter.post('/logout', (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

// ── Rotas de administração de usuários ──
const adminRouter = express.Router();

function validateCreate({ name, email, password }) {
  if (!name || !String(name).trim()) return 'Informe o nome.';
  if (!email || !EMAIL_RE.test(String(email).trim())) return 'E-mail inválido.';
  if (!password || String(password).length < 6) return 'A senha precisa de ao menos 6 caracteres.';
  return null;
}
function parseAccess(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const client = String((a && a.client) || '').trim();
    if (!isValidId(client) || seen.has(client)) continue;
    seen.add(client);
    out.push({ client, level: (a && a.level) === 'edit' ? 'edit' : 'view' });
  }
  return out;
}

adminRouter.get('/users', asyncHandler(async (req, res) => {
  const users = await User.find().sort({ createdAt: 1 }).lean();
  res.json(users.map(publicUser));
}));

adminRouter.post('/users', asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  const err = validateCreate({ name, email, password });
  if (err) return res.status(400).json({ error: err });
  const exists = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (exists) return res.status(409).json({ error: 'Já existe um usuário com esse e-mail.' });
  const { salt, hash } = auth.hashPassword(password);
  const user = await User.create({
    name: String(name).trim(), email: String(email).toLowerCase().trim(),
    passwordHash: hash, passwordSalt: salt,
    role: role === 'admin' ? 'admin' : 'user',
    access: role === 'admin' ? [] : parseAccess(req.body.access),
  });
  res.status(201).json(publicUser(user));
}));

adminRouter.put('/users/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const update = {};
  const b = req.body || {};
  if (b.name !== undefined) { if (!String(b.name).trim()) return res.status(400).json({ error: 'Nome não pode ser vazio.' }); update.name = String(b.name).trim(); }
  if (b.role !== undefined) update.role = b.role === 'admin' ? 'admin' : 'user';
  if (b.access !== undefined) update.access = parseAccess(b.access);
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'A senha precisa de ao menos 6 caracteres.' });
    const { salt, hash } = auth.hashPassword(b.password);
    update.passwordHash = hash; update.passwordSalt = salt;
  }
  // Admin não tem acesso por cliente (vê tudo).
  if (update.role === 'admin') update.access = [];
  // Não deixar remover o último admin.
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (target.role === 'admin' && update.role === 'user') {
    const admins = await User.countDocuments({ role: 'admin' });
    if (admins <= 1) return res.status(422).json({ error: 'Não é possível rebaixar o último administrador.' });
  }
  const user = await User.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
  res.json(publicUser(user));
}));

adminRouter.delete('/users/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  if (String(req.params.id) === String(req.user._id)) return res.status(422).json({ error: 'Você não pode excluir a si mesmo.' });
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (target.role === 'admin') {
    const admins = await User.countDocuments({ role: 'admin' });
    if (admins <= 1) return res.status(422).json({ error: 'Não é possível excluir o último administrador.' });
  }
  await User.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

module.exports = { attachUser, requireAuth, requireAdmin, clientAccessGuard, authRouter, adminRouter };
