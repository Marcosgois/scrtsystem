'use strict';

/* Testa o parser contra o SCRT real (#JUN2026.csv) e casos de erro. */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseScrt, parseCsvLine, parseReportingPeriod, combineReports } = require('../src/scrtParser');

const SAMPLE = path.join(__dirname, '..', 'SCRT', 'CAIXA', '#JUN2026.csv');
const BB_SAMPLE = path.join(__dirname, '..', 'SCRT', 'BB', 'PR3001-MES02.csv');
const BRB_SAMPLE = path.join(__dirname, '..', 'SCRT', 'BRB', 'SCRT - Janeiro 2026 - SIG.csv');
const ITAU_XLSX = path.join(__dirname, '..', 'SCRT', 'ITAU', 'SCRT TFP Jan-26.xlsx');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('parseCsvLine:');
check('campos com aspas e vírgulas internas', () => {
  assert.deepStrictEqual(parseCsvLine('"a","b,c",123,"d""e"'), ['a', 'b,c', '123', 'd"e']);
});

console.log('parseReportingPeriod:');
check('período padrão do SCRT', () => {
  const p = parseReportingPeriod('2 Jun, 2026 - 1 Jul, 2026 inclusive (30 days)');
  assert.strictEqual(p.start.toISOString().slice(0, 10), '2026-06-02');
  assert.strictEqual(p.end.toISOString().slice(0, 10), '2026-07-01');
  assert.strictEqual(p.days, 30);
});
check('virada de ano (Dez -> Jan)', () => {
  const p = parseReportingPeriod('2 Dec, 2026 - 1 Jan, 2027 inclusive (30 days)');
  assert.strictEqual(p.start.getUTCMonth(), 11);
  assert.strictEqual(p.end.getUTCFullYear(), 2027);
});

console.log('parseScrt (#JUN2026.csv real):');
const parsed = parseScrt(fs.readFileSync(SAMPLE));

check('cliente CAIXA com acento decodificado (latin1)', () => {
  assert.ok(parsed.customerName.includes('CAIXA ECONOMICA FEDERAL'), parsed.customerName);
  assert.ok(parsed.customerName.includes('BRASÍLIA'), `acentuação falhou: ${parsed.customerName}`);
});
check('período = Jun/2026, chave 2026-06, 30 dias', () => {
  assert.strictEqual(parsed.periodKey, '2026-06');
  assert.strictEqual(parsed.periodLabel, 'Jun/2026');
  assert.strictEqual(parsed.reportingPeriod.days, 30);
});
check('6 máquinas no Multiplex', () => {
  assert.strictEqual(parsed.machines.length, 6);
  assert.strictEqual(parsed.processorsInMultiplex, 6);
  assert.deepStrictEqual(
    parsed.machines.map((m) => m.identifier),
    ['M1C1', 'M2C1', 'M3C1', 'M4C1', 'M5C1', 'M6C1']
  );
});
check('valores de Machine MSU Consumed por máquina', () => {
  assert.deepStrictEqual(
    parsed.machines.map((m) => m.msuConsumed),
    [2541509, 4026931, 3781560, 4543980, 3051106, 4095485]
  );
});
check('consumo mensal = soma de Machine MSU Consumed = 22.040.571', () => {
  assert.strictEqual(parsed.totalMsuConsumed, 22040571);
});
check('total dos containers confere com a soma das máquinas', () => {
  assert.strictEqual(parsed.containersTotalMsu, 22040571);
  assert.strictEqual(parsed.containers.length, 1);
  assert.strictEqual(parsed.containers[0].identifier, 'CPS1');
  assert.strictEqual(parsed.containers[0].name, 'Container TFP');
  assert.deepStrictEqual(parsed.containers[0].perMachineMsu, [2541509, 4026931, 3781560, 4543980, 3051106, 4095485]);
});
check('atributos da máquina M1C1', () => {
  const m1 = parsed.machines[0];
  assert.strictEqual(m1.serialNumber, '82-C5DC8');
  assert.strictEqual(m1.typeModel, '9175-760');
  assert.strictEqual(m1.ratedCapacityMsus, 10894);
  assert.strictEqual(m1.peakUtilizationMsus, 6037);
  assert.strictEqual(m1.missingLparData, 'Y');
});
check('sem warnings no arquivo real', () => {
  assert.deepStrictEqual(parsed.warnings, []);
});
check('metadados do relatório', () => {
  assert.strictEqual(parsed.scrtToolRelease, '30.1.9');
  assert.ok(parsed.runDateTime.includes('03 Jul 2026'));
  assert.ok(parsed.submitter.email && parsed.submitter.email.includes('@')); // e-mail real omitido do repo
});
check('LPARs (N7): 50 no total, soma = consumo mensal', () => {
  const usage = parsed.lpars.filter((l) => l.msuConsumed != null);
  assert.strictEqual(usage.length, 50);
  assert.strictEqual(usage.reduce((a, l) => a + l.msuConsumed, 0), 22040571);
});
check('LPARs associadas à máquina certa pela ordem das seções', () => {
  const porMaquina = {};
  for (const l of parsed.lpars) {
    if (l.msuConsumed != null) porMaquina[l.machine] = (porMaquina[l.machine] || 0) + l.msuConsumed;
  }
  for (const m of parsed.machines) {
    assert.strictEqual(porMaquina[m.identifier], m.msuConsumed, `máquina ${m.identifier}`);
  }
});
check('LPAR BRJP2@M1C1 com N7 (uso) e N5 (picos 4HRA) mesclados', () => {
  const b = parsed.lpars.find((l) => l.name === 'BRJP2' && l.machine === 'M1C1');
  assert.strictEqual(b.msuConsumed, 822411);
  assert.strictEqual(b.peakHourMsu, 3411);
  assert.strictEqual(b.os, 'z/OS');
  assert.strictEqual(b.peak4hraMsu, 3268);
  assert.strictEqual(b.secondPeak4hraMsu, 3152);
  assert.ok(b.peak4hraAt.includes('06 Jun 2026'));
});
check('linha em branco antes do banner ==B5 não quebra o parse (regressão)', () => {
  const prefixed = parseScrt(Buffer.concat([Buffer.from('\r\n'), fs.readFileSync(SAMPLE)]));
  assert.strictEqual(prefixed.totalMsuConsumed, 22040571);
  assert.strictEqual(prefixed.lpars.length, 50);
});

console.log('parseScrt (casos de erro):');
check('arquivo não-SCRT é rejeitado', () => {
  assert.throws(() => parseScrt(Buffer.from('col1,col2\n1,2\n')), /não reconhecido/i);
});
check('SCRT sem Reporting Period é rejeitado', () => {
  assert.throws(
    () => parseScrt(Buffer.from('"== SCRT REPORT =="\n"Customer Name","X"\n')),
    /Reporting Period/i
  );
});

check('SCRT sem seção de máquinas é rejeitado', () => {
  assert.throws(
    () => parseScrt(Buffer.from([
      '"==B5== SCRT ENTERPRISE REPORT =="',
      '"Customer Name","X"',
      '"Reporting Period","2 Jan, 2027 - 1 Feb, 2027 inclusive (30 days)"',
      '',
    ].join('\r\n'))),
    /Seção de máquinas/i
  );
});

console.log('parseScrt (Sub-Capacity/MVM — arquivo real BRB, máquina única):');
check('SCRT - Janeiro 2026 - SIG.csv: campos planos + Reporting Period na C5', () => {
  const p = parseScrt(fs.readFileSync(BRB_SAMPLE));
  assert.strictEqual(p.customerName, 'BANCO DE BRASILIA S.A.');
  assert.strictEqual(p.periodKey, '2026-01');
  assert.strictEqual(p.reportingPeriod.days, 31);
  assert.strictEqual(p.scrtToolRelease, '30.1.2'); // vem de "Tool Release" na seção C5
  assert.strictEqual(p.machines.length, 1);
  assert.strictEqual(p.machines[0].identifier, '82-967C8');
  assert.strictEqual(p.machines[0].typeModel, '3931-609');
  assert.strictEqual(p.totalMsuConsumed, 520762);
  const usage = p.lpars.filter((l) => l.msuConsumed != null);
  assert.strictEqual(usage.reduce((a, l) => a + l.msuConsumed, 0), 520762);
});

console.log('parseScrt (separador ";" e aspas simples — formato ITAÚ):');
check('detecta separador ";" e remove aspas simples que envolvem o valor', () => {
  // Formato exportado do ITAÚ: delimitado por ";", valores entre aspas simples,
  // colunas vazias à direita e vírgula dentro do período (não deve confundir).
  const itau = [
    "==B5========= SCRT SUB-CAPACITY MVM REPORT - IBM Corp ====;;;;",
    "Customer Name;'BANCO ITAU SA';;;;",
    "Machine Serial Number;82-C9D48;;;;",
    "Machine Type and Model;9175-717;Machine Model change observed;;;",
    "Machine MSU Consumed;554392;;;;",
    "==C5====;;;;",
    "Reporting Period;'2 Jan, 2026 - 1 Feb, 2026 inclusive (31 days)';;;;",
    "",
  ].join('\r\n');
  const p = parseScrt(Buffer.from('﻿' + itau, 'utf8')); // com BOM, como o arquivo real
  assert.strictEqual(p.customerName, 'BANCO ITAU SA'); // aspas simples removidas
  assert.strictEqual(p.periodKey, '2026-01'); // vírgula do período não quebra
  assert.strictEqual(p.reportingPeriod.days, 31);
  assert.strictEqual(p.machines.length, 1);
  assert.strictEqual(p.machines[0].identifier, '82-C9D48');
  assert.strictEqual(p.machines[0].typeModel, '9175-717');
  assert.strictEqual(p.totalMsuConsumed, 554392);
});

console.log('parseScrt (planilha .xlsx com aba por máquina — arquivo real ITAÚ):');
check('SCRT TFP Jan-26.xlsx: 12 abas combinadas somam 14.194.272 MSU', () => {
  if (!fs.existsSync(ITAU_XLSX)) { console.log('    (arquivo ausente — pulado)'); return; }
  const { readXlsxSheets, rowsToCsv } = require('../src/xlsx');
  const sheets = readXlsxSheets(fs.readFileSync(ITAU_XLSX));
  assert.strictEqual(sheets.length, 12);
  const parsedSheets = sheets.map((s) => parseScrt(Buffer.from(rowsToCsv(s.rows), 'utf8')));
  const combined = combineReports(parsedSheets);
  assert.strictEqual(combined.customerName, 'BANCO ITAU SA');
  assert.strictEqual(combined.periodKey, '2026-01');
  assert.strictEqual(combined.machines.length, 12);
  assert.strictEqual(combined.totalMsuConsumed, 14194272);
  const usage = combined.lpars.filter((l) => l.msuConsumed != null);
  assert.strictEqual(usage.reduce((a, l) => a + l.msuConsumed, 0), 14194272);
});

console.log('parseScrt (SCRT duplo-codificado — arquivo real BB):');
check('PR3001-MES02.csv do BB: linhas empacotadas em um campo são re-interpretadas', () => {
  // Formato do SCRT do Banco do Brasil: cada linha vira um único campo CSV
  // (aspas internas dobradas). O parser detecta e re-interpreta.
  const p = parseScrt(fs.readFileSync(BB_SAMPLE));
  assert.strictEqual(p.customerName, 'BANCO DO BRASIL');
  assert.strictEqual(p.periodKey, '2026-02');
  assert.strictEqual(p.machines.length, 9);
  assert.strictEqual(p.totalMsuConsumed, 25966092);
  // Soma das LPARs (N7) confere com o total (parsing correto de ponta a ponta).
  const usage = p.lpars.filter((l) => l.msuConsumed != null);
  assert.strictEqual(usage.reduce((a, l) => a + l.msuConsumed, 0), 25966092);
  assert.deepStrictEqual(p.warnings, []);
});

console.log('parseScrt (variações sintéticas):');
check('máquina única e números com vírgula', () => {
  const synth = [
    '"==B5== SCRT ENTERPRISE REPORT =="',
    '"Customer Name","BANCO TESTE"',
    '"Reporting Period","2 Jan, 2027 - 1 Feb, 2027 inclusive (30 days)"',
    '"Machine identifier","","","","","M1C1"',
    '"Machine Serial Number","","","","","AA-111"',
    '"Machine MSU Consumed","","","","","1,234,567"',
    '',
  ].join('\r\n');
  const p = parseScrt(Buffer.from(synth, 'latin1'));
  assert.strictEqual(p.machines.length, 1);
  assert.strictEqual(p.totalMsuConsumed, 1234567);
  assert.strictEqual(p.periodKey, '2027-01');
  assert.strictEqual(p.periodLabel, 'Jan/2027');
  assert.deepStrictEqual(p.lpars, []);
});
check('divergência entre containers e máquinas gera warning', () => {
  const synth = [
    '"==B5== SCRT ENTERPRISE REPORT =="',
    '"Customer Name","BANCO TESTE"',
    '"Reporting Period","2 Jan, 2027 - 1 Feb, 2027 inclusive (30 days)"',
    '"Machine identifier","","","","","M1C1","M2C1"',
    '"Machine MSU Consumed","","","","",100,200',
    '""',
    '"Container Identifier","Container Name","TOTAL MSU Consumption","",""',
    '"CPS1","Container TFP","250","","",100,150',
    '',
  ].join('\r\n');
  const p = parseScrt(Buffer.from(synth, 'latin1'));
  assert.strictEqual(p.totalMsuConsumed, 300);
  assert.strictEqual(p.containersTotalMsu, 250);
  assert.strictEqual(p.warnings.length, 1);
  assert.ok(p.warnings[0].includes('difere'));
});

console.log(failures === 0 ? '\nTODOS OS TESTES DO PARSER PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
process.exit(failures === 0 ? 0 : 1);
