'use strict';

const fs = require('fs');

/**
 * Sobe um MongoDB local PERSISTENTE com os dados gravados na pasta do projeto
 * (./data/mongodb). Usa o binário mongod real baixado pelo mongodb-memory-server —
 * nada é instalado no sistema, e os dados sobrevivem a restarts.
 */
async function startLocalMongo({ dbPath, port }) {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  fs.mkdirSync(dbPath, { recursive: true });
  const mongod = await MongoMemoryServer.create({
    instance: {
      dbPath,
      port,
      storageEngine: 'wiredTiger',
    },
  });
  return mongod;
}

/** Para o mongod local SEM apagar a pasta de dados. */
async function stopLocalMongo(mongod) {
  if (mongod) await mongod.stop({ doCleanup: false });
}

module.exports = { startLocalMongo, stopLocalMongo };
