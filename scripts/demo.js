'use strict';

/*
 * Modo demonstração: sobe o TFPSystem com um MongoDB em memória.
 * Útil para testar sem banco instalado — OS DADOS NÃO PERSISTEM ao encerrar.
 * Para uso real, configure MONGODB_URI no .env e rode: npm start
 */

const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  console.log('⚠️  MODO DEMO: MongoDB em memória — os dados serão perdidos ao encerrar (Ctrl+C).');
  console.log('   Para persistir de verdade, configure MONGODB_URI no .env e rode "npm start".\n');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('tfpsystem');

  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  await connectDb(process.env.MONGODB_URI);

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`TFPSystem (demo) rodando em http://localhost:${port}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
