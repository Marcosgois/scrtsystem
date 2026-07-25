'use strict';

/*
 * Reimporta a tabela LSPR (src/data/lspr.json) no banco, substituindo a atual.
 * Use quando chegar uma versão nova do zPCR Configuration Summary.
 *
 *   npm run import:lspr
 *
 * Respeita MONGODB_URI do .env; sem ele, sobe o Mongo local persistente
 * (mesmo banco que a aplicação usa).
 */

require('dotenv').config();
const path = require('path');
const { connectDb } = require('../src/db');
const { startLocalMongo, stopLocalMongo } = require('../src/localDb');
const { seedLspr } = require('../src/lsprSeed');

async function main() {
  let uri = process.env.MONGODB_URI || null;
  let local = null;
  if (!uri) {
    const dbPath = path.join(__dirname, '..', 'data', 'mongodb');
    const port = Number(process.env.LOCAL_DB_PORT || 27017);
    local = await startLocalMongo({ dbPath, port });
    uri = `mongodb://127.0.0.1:${port}/tfpsystem`;
  }
  await connectDb(uri);
  const res = await seedLspr({ replace: true, log: console.log });
  console.log(`LSPR: ${res.count} modelos no banco.`);
  const mongoose = require('mongoose');
  await mongoose.disconnect();
  if (local) await stopLocalMongo(local);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
