'use strict';

/*
 * Preenche as seções de produto (==E5 PRODUCT SUMMARY, ==P5 PRODUCT MAX
 * CONTRIBUTORS) nos SCRTs que já estão no banco.
 *
 *   node scripts/reparse-produtos.js            # ensaio: só mostra o que faria
 *   node scripts/reparse-produtos.js --aplicar  # grava
 *
 * O arquivo original de cada SCRT fica guardado em data/scrt-files/<id> desde o
 * upload, então dá para reler e extrair o que o parser antigo não extraía — sem
 * pedir para ninguém reenviar nada.
 *
 * SÓ mexe no campo `products`. Nenhum número de consumo é recalculado: se um
 * parse novo divergisse do que está gravado, isso mudaria o histórico faturável
 * em silêncio, que é exatamente o que não pode acontecer.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connectDb } = require('../src/db');
const { startLocalMongo, stopLocalMongo } = require('../src/localDb');
const { parseScrt } = require('../src/scrtParser');
const { ScrtReport, Client } = require('../src/models');

const SCRT_FILES_DIR = process.env.SCRT_FILES_DIR || path.join(__dirname, '..', 'data', 'scrt-files');
const temAlgo = (p) => !!p && ((p.msuBased || []).length || (p.unitBased || []).length || (p.maxContributors || []).length);

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  let uri = process.env.MONGODB_URI || null;
  let local = null;
  if (!uri) {
    const dbPath = path.join(__dirname, '..', 'data', 'mongodb');
    const port = Number(process.env.LOCAL_DB_PORT || 27017);
    local = await startLocalMongo({ dbPath, port });
    uri = `mongodb://127.0.0.1:${port}/tfpsystem`;
  }
  await connectDb(uri);

  const clientes = new Map((await Client.find().select('name').lean()).map((c) => [String(c._id), c.name]));
  const reports = await ScrtReport.find().select('client periodKey siteLabel sourceFileName products').lean();
  console.log(`${reports.length} SCRT(s) no banco.\n`);

  let semArquivo = 0; let semSecao = 0; let comDados = 0; let falhou = 0;
  for (const r of reports) {
    const arquivo = path.join(SCRT_FILES_DIR, String(r._id));
    const rotulo = `${clientes.get(String(r.client)) || '?'} · ${r.periodKey}${r.siteLabel ? ` · ${r.siteLabel}` : ''}`;
    if (!fs.existsSync(arquivo)) { semArquivo++; continue; }
    let produtos;
    try {
      produtos = parseScrt(fs.readFileSync(arquivo)).products;
    } catch (e) {
      falhou++;
      console.log(`  ✗ ${rotulo}: ${e.message}`);
      continue;
    }
    if (!temAlgo(produtos)) { semSecao++; continue; }
    comDados++;
    const resumo = `${(produtos.msuBased || []).length} produto(s) MSU · ${(produtos.unitBased || []).length} por unidade · ${(produtos.maxContributors || []).length} contribuidor(es)`;
    console.log(`  ${aplicar ? '✓' : '·'} ${rotulo}: ${resumo}`);
    if (aplicar) await ScrtReport.updateOne({ _id: r._id }, { $set: { products: produtos } });
  }

  console.log(`\n${comDados} com seção de produto · ${semSecao} sem a seção (multiplex) · ${semArquivo} sem o arquivo guardado · ${falhou} com erro de parse`);
  if (!aplicar) console.log('\n(ensaio — rode com --aplicar para gravar)');

  await mongoose.disconnect();
  if (local) await stopLocalMongo(local);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
