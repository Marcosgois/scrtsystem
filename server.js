'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { connectDb } = require('./src/db');
const { startLocalMongo, stopLocalMongo } = require('./src/localDb');
const apiRoutes = require('./src/routes');
const { attachUser, requireAuth, requireAdmin, clientAccessGuard, authRouter, adminRouter } = require('./src/authRoutes');
const { sessionUserId } = require('./src/auth');
const { User } = require('./src/models');

const PORT = process.env.PORT || 3000;
// Com MONGODB_URI definido no .env (Atlas/servidor próprio), usa esse banco.
// Sem MONGODB_URI, sobe um MongoDB local persistente com dados em ./data/mongodb.
const MONGODB_URI = process.env.MONGODB_URI || null;
const LOCAL_DB_PATH = path.join(__dirname, 'data', 'mongodb');
const LOCAL_DB_PORT = Number(process.env.LOCAL_DB_PORT || 27017);

const app = express();
// Inventários de software chegam como JSON grande (centenas de produtos) — 25 MB cobre com folga.
app.use(express.json({ limit: '25mb' }));

// ── API com autenticação e autorização ──
app.use('/api', attachUser);                        // req.user (ou null) a partir do cookie
app.use('/api/auth', authRouter);                   // público: status/setup/login/logout/me
app.use('/api', requireAuth);                       // o resto exige login
app.use('/api/admin', requireAdmin, adminRouter);   // administração de usuários
app.use('/api', clientAccessGuard);                 // acesso por cliente (view/edit)
app.use('/api', apiRoutes);                          // rotas existentes dos módulos

// ── Páginas ──
const sendPage = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
const pageGuard = (req, res, next) => (sessionUserId(req) ? next() : res.redirect('/login'));
const adminPageGuard = async (req, res, next) => {
  const uid = sessionUserId(req);
  const u = uid ? await User.findById(uid).select('role').lean().catch(() => null) : null;
  if (!u) return res.redirect('/login');
  if (u.role !== 'admin') return res.redirect('/consumo');
  next();
};

app.get('/', sendPage('home.html'));               // homepage pública
app.get('/login', sendPage('login.html'));         // login (+ setup do 1º admin)
app.get('/consumo', pageGuard, sendPage('index.html'));
app.get('/mlc', pageGuard, sendPage('mlc.html'));
app.get('/inventario', pageGuard, sendPage('inventario.html'));
app.get('/infra', pageGuard, sendPage('infra.html'));
app.get('/contratos', pageGuard, sendPage('contratos.html'));
app.get('/admin', adminPageGuard, sendPage('admin.html'));

// Bloqueia acesso direto aos HTMLs protegidos pelo estático.
const PROTECTED_HTML = new Set(['/index.html', '/mlc.html', '/inventario.html', '/infra.html', '/contratos.html', '/admin.html']);
app.use((req, res, next) => {
  if (PROTECTED_HTML.has(req.path) && !sessionUserId(req)) return res.redirect('/login');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Erros da API respondem JSON; erros de entrada do cliente viram 4xx, não 500.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: `Falha no upload: ${err.message}` });
  }
  if (err && /unexpected end of form/i.test(err.message || '')) {
    return res.status(400).json({ error: 'Upload interrompido — envie o arquivo novamente.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição.' });
  }
  if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message || 'Requisição inválida.' });
  }
  if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
    return res.status(400).json({ error: 'Dados inválidos na requisição.' });
  }
  console.error('[API]', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

async function main() {
  let uri = MONGODB_URI;
  let localMongod = null;

  if (!uri) {
    try {
      localMongod = await startLocalMongo({ dbPath: LOCAL_DB_PATH, port: LOCAL_DB_PORT });
      uri = `mongodb://127.0.0.1:${LOCAL_DB_PORT}/tfpsystem`;
      console.log(`[MongoDB] banco local persistente: ${LOCAL_DB_PATH} (porta ${LOCAL_DB_PORT})`);
    } catch (err) {
      console.error(`\n[MongoDB] Falha ao subir o banco local em ${LOCAL_DB_PATH} (porta ${LOCAL_DB_PORT}).`);
      console.error(`[MongoDB] ${err.message}`);
      console.error('[MongoDB] Se a porta estiver em uso, defina LOCAL_DB_PORT=27018 no .env,');
      console.error('[MongoDB] ou aponte MONGODB_URI para o seu MongoDB (Atlas ou local).\n');
      process.exit(1);
    }
  }

  try {
    await connectDb(uri);
    // Referência LSPR (dados públicos IBM): popula na 1ª vez, idempotente depois.
    const { seedLspr } = require('./src/lsprSeed');
    await seedLspr({ log: console.log }).catch((e) => console.warn('[LSPR] seed ignorado:', e.message));
  } catch (err) {
    console.error(`\n[MongoDB] Não foi possível conectar em ${uri}`);
    console.error(`[MongoDB] ${err.message}`);
    console.error('[MongoDB] Confira o MONGODB_URI no arquivo .env e tente de novo.\n');
    await stopLocalMongo(localMongod);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`IBM Z Control Desk rodando em http://localhost:${PORT}`);
  });

  // Encerramento limpo: fecha o HTTP, desconecta e para o mongod SEM apagar os dados.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] encerrando…`);
    server.close();
    try {
      const mongoose = require('mongoose');
      await mongoose.disconnect();
      await stopLocalMongo(localMongod);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main();
}

module.exports = { app };
