'use strict';

/*
 * Carrega a tabela de referência LSPR (zPCR Configuration Summary) no MongoDB.
 * São dados públicos da IBM (MIPS/MSU/#CPs máximos por modelo IBM Z), versionados
 * em src/data/lspr.json e gerados por scripts/parse-lspr-cheatsheet.js.
 *
 * A carga é uma RECONCILIAÇÃO, não um "apaga e insere": upsert de cada modelo e,
 * no fim, remoção só do que saiu do arquivo. Duas razões:
 *
 *  1. `deleteMany({})` seguido de `insertMany` deixa uma janela em que a coleção
 *     está vazia. Nessa janela, `attachLspr` devolve lspr=null — e a máquina
 *     congelada num contrato ou num MO/MES nesse instante grava msu/mips nulos no
 *     snapshot, que é histórico e não se auto-corrige depois.
 *  2. Se a carga morrer no meio (queda de conexão), o upsert deixa a tabela
 *     completa até onde chegou e o próximo start termina o serviço — enquanto o
 *     apaga-e-insere deixaria a tabela pela metade.
 *
 * No start do servidor a carga é barata: se a contagem no banco já bate com a do
 * arquivo, não escreve nada. Se NÃO bate (tabela vazia, parcial, ou versão nova do
 * arquivo publicada por um deploy), reconcilia sozinha — foi o que faltou quando o
 * z17 ME2 (type 9176) entrou na tabela e o banco continuou com a versão anterior.
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
  const { models, source } = loadFile();
  if (!models.length) return { seeded: false, count: await LsprModel.countDocuments() };

  const count = await LsprModel.countDocuments();
  // Contagem igual à do arquivo = nada a fazer. `replace` força a reconciliação
  // mesmo assim (é o caminho do npm run import:lspr, para quando um VALOR mudou
  // sem mudar a quantidade de modelos).
  if (count === models.length && !replace) return { seeded: false, count };

  const docs = models.map((m) => ({ ...m, source: m.source || source }));
  const ops = docs.map((d) => ({
    updateOne: { filter: { model: d.model }, update: { $set: d }, upsert: true },
  }));
  // Lotes de 500: o bulkWrite inteiro num comando só estoura o limite de 16 MB do
  // BSON com 3 mil e poucos modelos.
  for (let i = 0; i < ops.length; i += 500) {
    await LsprModel.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }
  // Só agora o que saiu do arquivo é removido — nunca antes de inserir.
  const removidos = await LsprModel.deleteMany({ model: { $nin: docs.map((d) => d.model) } });

  const total = await LsprModel.countDocuments();
  const sobra = removidos.deletedCount ? `, ${removidos.deletedCount} removido(s)` : '';
  log(`[LSPR] referência sincronizada: ${total} modelos (antes ${count}${sobra}).`);
  if (total !== models.length) {
    throw new Error(`[LSPR] carga incompleta: ${total} no banco x ${models.length} no arquivo.`);
  }
  return { seeded: true, count: total };
}

module.exports = { seedLspr };
