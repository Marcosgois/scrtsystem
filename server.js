'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { connectDb } = require('./src/db');
const { startLocalMongo, stopLocalMongo } = require('./src/localDb');
const apiRoutes = require('./src/routes');

const PORT = process.env.PORT || 3000;
// Com MONGODB_URI definido no .env (Atlas/servidor próprio), usa esse banco.
// Sem MONGODB_URI, sobe um MongoDB local persistente com dados em ./data/mongodb.
const MONGODB_URI = process.env.MONGODB_URI || null;
const LOCAL_DB_PATH = path.join(__dirname, 'data', 'mongodb');
const LOCAL_DB_PORT = Number(process.env.LOCAL_DB_PORT || 27017);

const app = express();
// Inventários de software chegam como JSON grande (centenas de produtos) — 25 MB cobre com folga.
app.use(express.json({ limit: '25mb' }));
app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

// Rota amigável do módulo de Inventário (além de /inventario.html servido pelo estático).
app.get('/inventario', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inventario.html'));
});

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
  } catch (err) {
    console.error(`\n[MongoDB] Não foi possível conectar em ${uri}`);
    console.error(`[MongoDB] ${err.message}`);
    console.error('[MongoDB] Confira o MONGODB_URI no arquivo .env e tente de novo.\n');
    await stopLocalMongo(localMongod);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`TFPSystem rodando em http://localhost:${PORT}`);
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
