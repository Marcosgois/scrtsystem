'use strict';

const mongoose = require('mongoose');

/**
 * Índices que existiram em versões anteriores e precisam sair do banco.
 * O Mongoose cria os índices novos, mas nunca remove os antigos — e um índice
 * obsoleto continua sendo aplicado, bloqueando gravações válidas.
 */
const OBSOLETE_INDEXES = [
  {
    collection: 'scrtreports',
    name: 'client_1_periodKey_1',
    // Era "um SCRT por cliente/mês"; hoje o mês é a soma de várias origens
    // (sites diferentes), com índice {client, periodKey, sourceKey}.
    reason: 'permitir vários SCRTs no mesmo mês (sites diferentes)',
  },
];

async function dropObsoleteIndexes(connection) {
  for (const { collection, name, reason } of OBSOLETE_INDEXES) {
    try {
      const coll = connection.db.collection(collection);
      const indexes = await coll.indexes();
      if (!indexes.some((i) => i.name === name)) continue;
      await coll.dropIndex(name);
      console.log(`[MongoDB] índice obsoleto "${name}" removido — ${reason}.`);
    } catch (err) {
      // Coleção ainda não existe (banco novo) ou índice já removido: sem problema.
      if (err.codeName === 'NamespaceNotFound' || err.code === 26 || err.code === 27) continue;
      console.warn(`[MongoDB] não foi possível remover o índice "${name}": ${err.message}`);
    }
  }
}

/**
 * Migra documentos gravados antes do merge mensal, que não têm sourceKey
 * (campo obrigatório do índice novo).
 */
async function backfillSourceKeys(connection) {
  const coll = connection.db.collection('scrtreports');
  let antigos;
  try {
    antigos = await coll.find({ sourceKey: { $exists: false } }).toArray();
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound' || err.code === 26) return;
    throw err;
  }
  if (!antigos.length) return;

  for (const doc of antigos) {
    const serials = [...new Set(
      (doc.machines || [])
        .map((m) => String(m.serialNumber || m.identifier || '').trim().toUpperCase())
        .filter(Boolean)
    )].sort();
    await coll.updateOne(
      { _id: doc._id },
      { $set: { sourceKey: serials.length ? serials.join('|') : 'SEM-MAQUINA' } }
    );
  }
  console.log(`[MongoDB] ${antigos.length} relatório(s) antigo(s) receberam sourceKey.`);
}

async function connectDb(uri) {
  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] erro de conexão:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[MongoDB] desconectado');
  });
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  // Ordem importa: limpar índices obsoletos e preencher campos novos ANTES de
  // criar os índices atuais, senão a criação falha em bases já existentes.
  await dropObsoleteIndexes(mongoose.connection);
  await backfillSourceKeys(mongoose.connection);

  const { Client, ScrtReport, Inventory } = require('./models');
  await Promise.all([Client.init(), ScrtReport.init(), Inventory.init()]);

  console.log(`[MongoDB] conectado em ${uri.replace(/\/\/[^@]+@/, '//***@')}`);
}

module.exports = { connectDb };
