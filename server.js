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
// Atrás de um proxy reverso, HOST=127.0.0.1 impede que a aplicação seja alcançada
// direto na porta dela, por fora do TLS. Vazio = todas as interfaces (o padrão em
// desenvolvimento, onde não há proxy na frente).
const HOST = process.env.HOST || undefined;
// Com MONGODB_URI definido no .env (Atlas/servidor próprio), usa esse banco.
// Sem MONGODB_URI, sobe um MongoDB local persistente com dados em ./data/mongodb.
const MONGODB_URI = process.env.MONGODB_URI || null;
const LOCAL_DB_PATH = path.join(__dirname, 'data', 'mongodb');
const LOCAL_DB_PORT = Number(process.env.LOCAL_DB_PORT || 27017);

const app = express();
// Não anunciar o framework (reduz fingerprinting). O nginx já faz server_tokens off.
app.disable('x-powered-by');

// Content-Security-Policy (defesa em profundidade contra XSS): o nginx já envia
// HSTS/X-Frame-Options/X-Content-Type-Options/Referrer-Policy, mas não CSP. Como
// o front usa scripts e handlers inline, 'unsafe-inline' é necessário hoje; o
// resto fica trancado em 'self' (nada de script/-conexão/-frame externos).
//
// Exceção escopada: o widget AskZ (IBM watsonx Orchestrate) é embutido SÓ na página
// de consumo, então o host da IBM é liberado apenas ali — o resto do app segue estrito.
const WXO_ORIGIN = process.env.WXO_ORIGIN || 'https://br-sao.watson-orchestrate.cloud.ibm.com';
const WXO_WSS = WXO_ORIGIN.replace(/^https:/, 'wss:');
// O Cloudflare injeta o beacon de Web Analytics (Browser Insights) em TODA página
// proxied; sem liberar o domínio dele, o navegador bloqueia o beacon.min.js (erro no
// console). Vai na CSP base porque a injeção acontece em todas as páginas.
const CF_INSIGHTS = 'https://static.cloudflareinsights.com';   // beacon.min.js
const CF_INSIGHTS_RUM = 'https://cloudflareinsights.com';      // POST das métricas
function cspHeader(req) {
  const askz = req.path === '/consumo' || req.path === '/index.html'; // páginas com o widget
  const x = askz ? ' ' + WXO_ORIGIN : '';
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `img-src 'self' data: blob:${x}`,
    `font-src 'self' data:${x}`,
    `style-src 'self' 'unsafe-inline'${x}`,
    `script-src 'self' 'unsafe-inline' ${CF_INSIGHTS}${x}`,
    `worker-src 'self' blob:${x}`,
    `frame-src 'self'${x}`,
    `connect-src 'self' ${CF_INSIGHTS_RUM}${askz ? ' ' + WXO_ORIGIN + ' ' + WXO_WSS : ''}`,
  ].join('; ');
}
app.use((req, res, next) => { res.setHeader('Content-Security-Policy', cspHeader(req)); next(); });

// Inventários de software chegam como JSON grande (centenas de produtos) — 25 MB cobre com folga.
app.use(express.json({ limit: '25mb' }));

// Log de acesso: uma linha por requisição (quem, o quê, status, tempo).
// Vem antes de tudo para registrar também o que é recusado por falta de acesso.
const log = require('./src/logger');
app.use(log.requestLogger(sessionUserId));

// ── API com autenticação e autorização ──
app.use('/api', attachUser);                        // req.user (ou null) a partir do cookie
app.use('/api/auth', authRouter);                   // público: status/setup/login/logout/me
app.use('/api', requireAuth);                       // o resto exige login
app.use('/api', require('./src/audit').middleware); // trilha de auditoria das mutações
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
  // Upload cortado no meio. O multer 2.x passou a sinalizar a queda da conexão
  // com Error("Request aborted"/"Request closed"/"Request error") — antes só
  // chegava o "Unexpected end of form" do busboy, que ainda vale para corpo
  // multipart truncado. Sem os dois casos, cliente que desiste vira 500.
  if (err && /unexpected end of form|request (aborted|closed|error)/i.test(err.message || '')) {
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
    console.error(`\n[MongoDB] Não foi possível conectar em ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
    console.error(`[MongoDB] ${err.message}`);
    console.error('[MongoDB] Confira o MONGODB_URI no arquivo .env e tente de novo.\n');
    await stopLocalMongo(localMongod);
    process.exit(1);
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`IBM Z Control Desk rodando em http://${HOST || 'localhost'}:${PORT}`);
    console.log(`[log] ${log.resumo()}`);
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
