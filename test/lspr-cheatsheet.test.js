'use strict';

/* Conversor do "Configuration Summary" do zPCR (CheatSheet*.html) para o
   src/data/lspr.json. Dado de capacidade errado no banco vira proposta comercial
   errada, então o parser é estrito: prefere PARAR a gravar linha pela metade.
   Este teste trava as armadilhas reais do formato da IBM. */

const { parseCheatSheet, comparar, geracaoDaFamilia, numero } = require('../scripts/parse-lspr-cheatsheet');

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

const CABECALHO = `<tr>
<th align="center"><font size="+1">Model</font></th>
<th align="center"><font size="+1">MIPS</font></th>
<th align="center"><font size="+1">MSU</font></th>
<th align="center"><font size="+1">#Partitions</font></th>
<th align="center"><font size="+1">#CPs</font></th>
<th align="center"><font size="+1">#IFLs</font></th>
<th align="center"><font size="+1">#ICFs</font></th>
<th align="center"><font size="+1">#zAAPs</font></th>
<th align="center"><font size="+1">#zIIPs</font></th>
</tr>`;

const familia = (nome) => `<tr>
<th align="center" colspan=9><font size="+1">${nome}</font></th>
</tr>
${CABECALHO}`;

const linha = (...cels) => `<tr>\n${cels.map((c) => `<td align="right"><font size="+1">${c}</font></td>`).join('\n')}\n</tr>`;

const doc = (corpo) => `<HTML><TITLE>Configuration Summary</TITLE>
<p>IBM Z&#8482; processors.
<table align=center border cellspacing=1 cellPadding=1 width="100%".>
${corpo}
</table></HTML>`;

// ── Caso feliz, com as três armadilhas do formato ──
const html = doc([
  familia('IBM Z z17/700'),
  linha('9175-701', '2,477', '306', '85', '1', '207', '207', '0', '207'),
  linha('9175-790', '99,999', '1,234', '85', '90', '118', '118', '0', '118'),
  familia('LinuxONE Emperor 5 9175/400'),
  linha('9175-401_L', '296', '37', '85', '1', '207', '207', '0', '0'),
  familia('System z10 BC/Z00'),
  linha('2098-Z01', '26', '3', '30', '1', '5', '5', '5', '5'),
  familia('zEnterprise EC12/700'),
  linha('2827-701', '1,514', '187', '60', '1', '101', '101', '101', '101'),
].join('\n'));

const { modelos, familias } = parseCheatSheet(html);

check('lê uma família por tabela', familias.length === 4, familias);
check('lê todas as linhas de modelo', modelos.length === 5, modelos.length);

const m701 = modelos.find((m) => m.model === '9175-701');
check('separador de milhar vira número (2,477 -> 2477)', m701.mips === 2477, m701.mips);
check('as 9 colunas caem no campo certo',
  m701.msu === 306 && m701.partitions === 85 && m701.cps === 1
  && m701.ifls === 207 && m701.icfs === 207 && m701.zaaps === 0 && m701.ziips === 207, m701);
check('machineType é o prefixo de 4 dígitos', m701.machineType === '9175', m701.machineType);

// O zPCR desempata o modelo que sai nas duas tabelas com o sufixo _L. Se o parser
// não aceitar o sufixo, a linha LinuxONE explode; se ele INVENTAR o sufixo, vira
// "9175-401_L_L" e o registro nunca casa com a máquina cadastrada.
const linuxone = modelos.find((m) => m.family.startsWith('LinuxONE'));
check('modelo _L vem do arquivo e é preservado como está', linuxone.model === '9175-401_L', linuxone.model);
check('família LinuxONE herda a geração pelo machine type (9175 -> z17)',
  linuxone.generation === 'z17', linuxone.generation);

check('geração sai do nome da família', m701.generation === 'z17', m701.generation);
check('System z10 BC vira "z10 BC"', modelos.find((m) => m.model === '2098-Z01').generation === 'z10 BC');
check('zEnterprise EC12 vira "zEC12"', modelos.find((m) => m.model === '2827-701').generation === 'zEC12');
check('zEnterprise 196 vira "z196"', geracaoDaFamilia('zEnterprise 196/700') === 'z196');
check('zEnterprise zBC12 vira "zBC12"', geracaoDaFamilia('zEnterprise zBC12/A00') === 'zBC12');

check('célula vazia vira null, não 0', numero('') === null && numero('-') === null, [numero(''), numero('-')]);
check('zero continua zero', numero('0') === 0);

// ── O parser tem de PARAR, não improvisar ──
const explode = (corpo, oQue) => {
  try { parseCheatSheet(doc(corpo)); return `não lançou (${oQue})`; } catch (e) { return null; }
};
check('linha com menos de 9 células -> erro',
  !explode([familia('IBM Z z17/700'), linha('9175-701', '2,477', '306')].join('\n'), 'células a menos'));
check('tabela com outro número de colunas -> erro',
  !explode(['<tr><th align="center" colspan=7><font size="+1">IBM Z z17/700</font></th></tr>',
    CABECALHO, linha('9175-701', '1', '1', '1', '1', '1', '1', '1', '1')].join('\n'), 'colspan 7'));
check('modelo fora do padrão NNNN-XXX -> erro',
  !explode([familia('IBM Z z17/700'), linha('Total', '1', '1', '1', '1', '1', '1', '1', '1')].join('\n'), 'linha de total'));
check('linha de dados antes de qualquer família -> erro',
  !explode([CABECALHO, linha('9175-701', '1', '1', '1', '1', '1', '1', '1', '1')].join('\n'), 'sem família'));
check('modelo repetido -> erro (chave única no banco engoliria a segunda)',
  !explode([familia('IBM Z z17/700'),
    linha('9175-701', '1', '1', '1', '1', '1', '1', '1', '1'),
    linha('9175-701', '2', '2', '2', '2', '2', '2', '2', '2')].join('\n'), 'duplicado'));

// ── Diff ──
const atuais = [
  { model: '9175-701', machineType: '9175', generation: 'z17', family: 'IBM Z z17/700', mips: 2477, msu: 306, partitions: 85, cps: 1, ifls: 207, icfs: 207, zaaps: 0, ziips: 207 },
  { model: '9999-001', machineType: '9999', generation: 'zX', family: 'Fantasma', mips: 1, msu: 1, partitions: 1, cps: 1, ifls: 1, icfs: 1, zaaps: 1, ziips: 1 },
];
const d = comparar(atuais, modelos);
check('diff acha os novos', d.adicionados.length === 4, d.adicionados.map((m) => m.model));
check('diff acha o que sumiu', d.removidos.length === 1 && d.removidos[0].model === '9999-001', d.removidos);
check('modelo idêntico não conta como alterado', d.alterados.length === 0, d.alterados);

const mexido = modelos.map((m) => (m.model === '9175-701' ? { ...m, msu: 307 } : m));
const d2 = comparar(atuais, mexido);
check('diff acha o MSU mudado (não é cego)',
  d2.alterados.length === 1 && d2.alterados[0].difs[0].de === 306 && d2.alterados[0].difs[0].para === 307, d2.alterados);

if (failures) { console.error(`\nLSPR/CHEATSHEET: ${failures} FALHA(S)`); process.exit(1); }
console.log('\nLSPR/CHEATSHEET: TODOS OS TESTES PASSARAM');
