'use strict';

/*
 * Importa o contrato MLC da CAIXA a partir de "mlc/mlc caixa.xlsx".
 *
 * Traz só os PARÂMETROS do contrato (3 anos): Baseline anual, Valor por MSU,
 * Encargo de Crescimento por MSU, CBA% e os encargos fixos (Produtos Flat,
 * Dev/Test). O consumo mensal NÃO é importado — vem do SCRT do sistema.
 *
 * Uso:  node scripts/import-mlc-caixa.js [caminho-do-xlsx] [--dry]
 *   --dry  só mostra o que gravaria, sem tocar no banco.
 *
 * O arquivo da planilha é dado do cliente e fica fora do repositório.
 */

const fs = require('fs');
const path = require('path');
const { readXlsxSheets } = require('../src/xlsx');
const { computeMlcView } = require('../src/mlc');

const ROOT = path.join(__dirname, '..');
const CLIENT_NAME = 'CAIXA';
const START_PERIOD = '2024-06'; // Ano 1 = Med/Jun 24 .. Med/Mai 25
const CBA_PCT = 0.19; // rótulo "Consumo com CBA (19%)" na planilha

/** Linhas da planilha (0-based); valores começam na coluna 2. */
const LINHA = {
  baselineAnualMsu: 16, // "Baseline Anual (MSU)"
  valorPorMsu: 13, // "Valor por MSU"
  encargoCrescimento: 22, // "Encargos de Crescimento por MSU"
  produtosFlat: 24, // "Encargos Mensais Produtos Flat"
  devTest: 26, // "Dev/Test"
};

function celula(rows, linha, colAno) {
  const v = rows[linha] && rows[linha][2 + colAno];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function montarContrato(rows) {
  const years = [0, 1, 2].map((a) => ({
    label: `Ano ${a + 1}`,
    baselineAnnualMsu: celula(rows, LINHA.baselineAnualMsu, a),
    valorPorMsu: celula(rows, LINHA.valorPorMsu, a),
    encargoCrescimentoPorMsu: celula(rows, LINHA.encargoCrescimento, a),
    cbaPct: CBA_PCT,
    encargos: [
      { nome: 'Produtos Flat', valorMensal: celula(rows, LINHA.produtosFlat, a) },
      { nome: 'Dev/Test', valorMensal: celula(rows, LINHA.devTest, a) },
    ],
  }));
  return { startPeriodKey: START_PERIOD, years };
}

async function main() {
  const xlsxPath = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || path.join(ROOT, 'mlc', 'mlc caixa.xlsx');
  const dry = process.argv.includes('--dry');
  if (!fs.existsSync(xlsxPath)) {
    console.error(`Planilha não encontrada: ${xlsxPath}`);
    process.exit(1);
  }

  const rows = readXlsxSheets(fs.readFileSync(xlsxPath))[0].rows;
  const contract = montarContrato(rows);

  console.log(`Planilha: ${path.relative(ROOT, xlsxPath)}`);
  console.log('Contrato MLC montado:');
  contract.years.forEach((y) => {
    console.log(`  ${y.label}: baseline ${y.baselineAnnualMsu.toLocaleString('pt-BR')} MSU · `
      + `R$/MSU ${y.valorPorMsu} · encargo cresc./MSU ${y.encargoCrescimentoPorMsu} · CBA ${y.cbaPct * 100}%`);
    y.encargos.forEach((e) => console.log(`     - ${e.nome}: R$ ${e.valorMensal.toLocaleString('pt-BR')}/mês`));
  });

  if (dry) {
    console.log('\n--dry: nada gravado.');
    // Prova offline: aplica o consumo da própria planilha e confere Ano 1.
    const consumo = {};
    for (let a = 0; a < 3; a++) {
      const linhaConsumo = [30, 37, 45][a];
      for (let m = 0; m < 12; m++) {
        const v = Number(rows[linhaConsumo] && rows[linhaConsumo][2 + m]);
        if (Number.isFinite(v) && v > 0) consumo[require('../src/mlc').addMonths(START_PERIOD, a * 12 + m)] = v;
      }
    }
    const view = computeMlcView(contract, consumo);
    const ano1 = view.years[0];
    console.log(`\nConferência offline (Ano 1, 1º mês): consumo=${ano1.months[0].consumedMsu} `
      + `-> c/ growth R$ ${ano1.months[0].monthlyWithGrowthRs.toFixed(2)} `
      + `-> c/ CBA R$ ${ano1.months[0].withCbaRs.toFixed(2)}`);
    return;
  }

  // Grava no banco via o mesmo caminho do servidor.
  require('dotenv').config();
  const mongoose = require('mongoose');
  const { connectDb } = require('../src/db');
  const { Client } = require('../src/models');
  const uri = process.env.MONGODB_URI || require('../src/db').LOCAL_URI;
  await connectDb(process.env.MONGODB_URI);

  const client = await Client.findOne({ name: CLIENT_NAME });
  if (!client) {
    console.error(`Cliente "${CLIENT_NAME}" não encontrado no banco.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  client.mlcContract = contract;
  await client.save();
  console.log(`\nContrato gravado no cliente ${client.name} (${client._id}).`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
