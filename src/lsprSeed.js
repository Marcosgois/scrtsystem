'use strict';

/*
 * Carrega a tabela de referência LSPR (zPCR Configuration Summary) no MongoDB.
 * São dados públicos da IBM (MIPS/MSU/#CPs máximos por modelo IBM Z), versionados
 * em src/data/lspr.json. Rodado no start do servidor: se a coleção estiver vazia,
 * popula; se já tiver dados, não faz nada (idempotente). Use replace=true para
 * forçar a reimportação quando chegar uma versão nova do arquivo.
 */

const fs = require('fs');
const path = require('path');
const { LsprModel } = require('./models');

const DATA_FILE = path.join(__dirname, 'data', 'lspr.json');

function loadFile() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const models = Array.isArray(raw) ? raw : raw.models || [];
  const source = (raw && raw.source) || '';
  return { models, source };
}

async function seedLspr({ replace = false, log = () => {} } = {}) {
  const count = await LsprModel.estimatedDocumentCount();
  if (count > 0 && !replace) return { seeded: false, count };

  const { models, source } = loadFile();
  if (!models.length) return { seeded: false, count };

  if (replace) await LsprModel.deleteMany({});
  const docs = models.map((m) => ({ ...m, source: m.source || source }));
  // insertMany em lotes; ordered:false ignora duplicatas se algo já existir.
  await LsprModel.insertMany(docs, { ordered: false }).catch((e) => {
    // Em modo não-replace, colisões de índice único são esperadas e toleráveis.
    if (!replace && e && e.code === 11000) return;
    throw e;
  });
  const total = await LsprModel.estimatedDocumentCount();
  log(`[LSPR] referência carregada: ${total} modelos${replace ? ' (reimportado)' : ''}.`);
  return { seeded: true, count: total };
}

module.exports = { seedLspr };
