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
 * No start do servidor a carga é barata: guarda-se a impressão digital do arquivo
 * carregado (AppMeta "lspr.fingerprint") e, se ela bate com a do arquivo em disco,
 * não se escreve nada. Se NÃO bate — tabela vazia, tabela parcial, versão nova do
 * arquivo publicada por um deploy, ou revisão de VALOR pela IBM sem mudar a
 * quantidade de modelos — reconcilia sozinha. Foi essa checagem que faltou quando
 * o z17 ME2 (type 9176) entrou na tabela e o banco continuou com a versão anterior.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { LsprModel, AppMeta } = require('./models');

const DATA_FILE = path.join(__dirname, 'data', 'lspr.json');
const CHAVE_META = 'lspr.fingerprint';

function loadFile() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const models = Array.isArray(raw) ? raw : raw.models || [];
  const source = (raw && raw.source) || '';
  return { models, source };
}

/*
 * Impressão digital do conteúdo do ARQUIVO. Contar modelos não basta: uma revisão
 * de valor pela IBM (um MSU corrigido, mesma quantidade de modelos) mudaria o
 * arquivo sem mudar a contagem, e o banco ficaria com o número velho para sempre —
 * a mesma classe de erro que deixou o z17 ME2 de fora.
 *
 * O que ela NÃO cobre: o banco derivar sozinho com o arquivo intacto (alguém
 * editando a coleção à mão). Detectar isso exigiria reler os 3 mil documentos a
 * cada start; para esse caso existe o `npm run import:lspr`, que força a carga.
 */
function digital(models) {
  const h = crypto.createHash('sha256');
  for (const m of models) {
    h.update(`${m.model}|${m.mips}|${m.msu}|${m.partitions}|${m.cps}|${m.ifls}|${m.icfs}|${m.zaaps}|${m.ziips}|${m.machineType}|${m.generation}|${m.family}\n`);
  }
  return h.digest('hex');
}

async function seedLspr({ replace = false, log = () => {} } = {}) {
  const { models, source } = loadFile();
  if (!models.length) return { seeded: false, count: await LsprModel.countDocuments() };

  const count = await LsprModel.countDocuments();
  const fp = digital(models);
  const gravada = await AppMeta.findOne({ key: CHAVE_META }).lean().catch(() => null);

  // Só pula quando a contagem E a impressão digital batem — ou seja, quando o
  // banco comprovadamente tem ESTE arquivo. `replace` força mesmo assim.
  if (count === models.length && gravada && gravada.value === fp && !replace) {
    return { seeded: false, count, fingerprint: fp };
  }

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
  if (total !== models.length) {
    throw new Error(`[LSPR] carga incompleta: ${total} no banco x ${models.length} no arquivo.`);
  }
  // A digital só é gravada DEPOIS da carga fechar. Se a carga morrer no meio, a
  // digital continua a antiga (ou ausente) e o próximo start refaz o serviço.
  await AppMeta.updateOne({ key: CHAVE_META }, { $set: { value: fp } }, { upsert: true });

  const sobra = removidos.deletedCount ? `, ${removidos.deletedCount} removido(s)` : '';
  log(`[LSPR] referência sincronizada: ${total} modelos (antes ${count}${sobra}).`);
  return { seeded: true, count: total, fingerprint: fp };
}

module.exports = { seedLspr, digital, CHAVE_META };
