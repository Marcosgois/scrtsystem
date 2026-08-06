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

/** Renomeia os campos de storage das máquinas de infra para memória. */
async function renameStorageToMemory(connection) {
  const coll = connection.db.collection('inframachines');
  try {
    const res = await coll.updateMany(
      { $or: [{ storageTB: { $exists: true } }, { storageAddTB: { $exists: true } }] },
      { $rename: { storageTB: 'memoryTB', storageAddTB: 'memoryAddTB' } }
    );
    if (res.modifiedCount) console.log(`[MongoDB] ${res.modifiedCount} máquina(s): storage → memória.`);
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound' || err.code === 26) return;
    console.warn(`[MongoDB] rename storage→memória: ${err.message}`);
  }
}

/**
 * Troca o booleano `dormant` das máquinas pelo enum `status`.
 * A ordem importa: marcar as dormentes primeiro, depois o resto como ativa, e só
 * então remover o campo antigo — senão o passo 2 apagaria a informação do passo 1.
 */
async function backfillMachineStatus(connection) {
  const coll = connection.db.collection('inframachines');
  try {
    const dormentes = await coll.updateMany(
      { status: { $exists: false }, dormant: true },
      { $set: { status: 'dormente' } }
    );
    const ativas = await coll.updateMany(
      { status: { $exists: false } },
      { $set: { status: 'ativa' } }
    );
    await coll.updateMany({ dormant: { $exists: true } }, { $unset: { dormant: 1 } });
    const total = dormentes.modifiedCount + ativas.modifiedCount;
    if (total) console.log(`[MongoDB] ${total} máquina(s): dormant → status (${dormentes.modifiedCount} dormente).`);
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound' || err.code === 26) return;
    console.warn(`[MongoDB] migração dormant→status: ${err.message}`);
  }
}

/*
 * Migra o contrato único (contractYearStart + mlcContract) para a lista
 * contractPeriods. Antes o cliente tinha um mês-âncora só e os anos saíam em
 * blocos de 12 meses ao infinito; agora são contratos em sequência, com a
 * contagem de anos reiniciando a cada um.
 *
 * Idempotente: só toca em quem ainda não tem contractPeriods. O nome sai do ano
 * de início ("Contrato 2023") — o usuário renomeia depois se quiser.
 */
async function migrateContractPeriods(connection) {
  const coll = connection.db.collection('clients');
  let antigos;
  try {
    antigos = await coll.find({
      $and: [
        { $or: [{ contractPeriods: { $exists: false } }, { contractPeriods: { $size: 0 } }] },
        { $or: [{ contractYearStart: { $type: 'string' } }, { 'mlcContract.startPeriodKey': { $type: 'string' } }] },
      ],
    }).toArray();
  } catch (err) {
    if (err.codeName === 'NamespaceNotFound' || err.code === 26) return;
    throw err;
  }
  if (!antigos.length) return;

  for (const c of antigos) {
    const mlc = c.mlcContract || {};
    const inicio = c.contractYearStart || mlc.startPeriodKey;
    if (!inicio || !/^\d{4}-\d{2}$/.test(inicio)) continue;
    await coll.updateOne({ _id: c._id }, {
      $set: {
        contractPeriods: [{
          _id: new mongoose.Types.ObjectId(),
          name: `Contrato ${inicio.slice(0, 4)}`,
          startPeriodKey: inicio,
          endPeriodKey: null,          // vigente: quem encerra é o usuário
          years: mlc.years || [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
      },
    });
  }
  console.log(`[MongoDB] ${antigos.length} cliente(s): contrato único → contractPeriods.`);
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
  await renameStorageToMemory(mongoose.connection);
  await backfillMachineStatus(mongoose.connection);
  await migrateContractPeriods(mongoose.connection);

  const { Client, ScrtReport, Inventory, Contract, MigrationEvent, AuditLog, MachineLifecycle, Region } = require('./models');
  await Promise.all([Client.init(), ScrtReport.init(), Inventory.init(), Contract.init(), MigrationEvent.init(), AuditLog.init(), MachineLifecycle.init(), Region.init()]);

  // Ciclo de vida das máquinas IBM Z: referência pública que o app assume existir.
  // Fica AQUI (e não no server.js) porque existem vários caminhos de boot — app,
  // demo e testes — e todos passam por connectDb. Só insere o que falta, então
  // correção feita na tela de administração nunca é sobrescrita.
  await require('./lifecycleSeed').seedLifecycle({ log: console.log })
    .catch((e) => console.warn('[ciclo de vida] seed ignorado:', e.message));

  console.log(`[MongoDB] conectado em ${uri.replace(/\/\/[^@]+@/, '//***@')}`);
}

module.exports = { connectDb };
