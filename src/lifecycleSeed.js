'use strict';

/*
 * Carga inicial do ciclo de vida das máquinas IBM Z, transcrita da tabela
 * "IBM Mainframe Life Cycle History" (referência pública da IBM).
 *
 * CUIDADO AO MEXER: só INSERE o que falta, nunca atualiza o que já existe. Se
 * você corrigir uma data pela tela de administração, a correção sobrevive ao
 * próximo restart — a semente não sobrescreve nada.
 *
 * Datas em "AAAA-MM-DD". Campo vazio (null) = ainda não anunciado pela IBM, que
 * é o caso das gerações recentes (z17, z16), sem data de fim de suporte.
 */

const CICLO_DE_VIDA = [
  // type,  model,     family,      ann,          ga,           hwWdfm,       licWdfm,      coslEos
  ['9176', 'MER',     'z17 MER',   '2026-07-07', '2026-08-12', null,         null,         null],
  ['9176', 'ME2',     'z17 ME2',   '2026-07-07', '2026-08-12', null,         null,         null],
  ['9175', 'ME1',     'z17',       '2025-04-08', '2025-06-18', null,         null,         null],
  ['3932', 'AGZ',     'z16 AGZ',   '2023-04-04', '2023-05-17', '2027-03-31', '2028-03-31', null],
  ['3932', 'A02',     'z16 A02',   '2023-04-04', '2023-05-17', '2027-03-31', '2028-03-31', null],
  ['3931', 'A01',     'z16',       '2022-04-05', '2022-05-31', '2025-12-31', '2026-12-31', null],
  ['8562', 'T02',     'z15 T02',   '2020-04-14', '2020-05-15', '2024-06-30', '2025-06-30', null],
  ['8561', 'T01',     'z15',       '2019-09-12', '2019-09-23', '2023-12-31', '2024-12-31', null],
  ['3907', 'ZR1',     'z14 ZR1',   '2018-04-10', '2018-05-31', '2021-09-30', '2022-09-30', '2027-12-31'],
  ['3906', 'M0n',     'z14',       '2017-07-17', '2017-09-13', '2021-06-30', '2022-06-30', '2027-12-31'],
  ['2965', 'Nnn',     'z13s',      '2016-02-16', '2016-03-10', '2019-06-30', '2020-06-30', '2024-12-31'],
  ['2964', 'Nnn',     'z13',       '2015-01-14', '2015-03-09', '2019-06-30', '2020-06-30', '2024-12-31'],
  ['2828', 'Hnn',     'zBC12',     '2013-07-23', '2013-09-20', '2016-12-31', '2017-12-31', '2023-12-31'],
  ['2827', 'Hnn',     'zEC12',     '2012-08-28', '2012-09-19', '2016-12-31', '2017-12-31', '2023-12-31'],
  ['2818', 'Mnn',     'z114',      '2011-07-12', '2011-09-09', '2014-06-30', '2015-06-30', '2022-12-31'],
  ['2817', 'Mnn',     'z196',      '2010-07-22', '2010-09-10', '2014-06-30', '2015-06-30', '2021-12-31'],
  ['2098', 'E10',     'z10 BC',    '2008-10-21', '2008-10-28', '2012-06-30', '2013-06-30', '2019-12-31'],
  ['2097', 'Enn',     'z10 EC',    '2008-02-26', '2008-02-26', '2012-06-30', '2013-06-30', '2019-12-31'],
  ['2096', 'R07/S07', 'z9 BC',     '2006-04-27', '2006-05-26', '2010-06-30', null,         '2019-01-31'],
  ['2094', 'Snn',     'z9 EC',     '2005-07-26', '2005-09-16', '2010-06-30', null,         '2017-10-31'],
  ['2086', 'A04',     'z890',      '2004-04-07', '2004-05-28', '2007-12-31', null,         '2016-10-31'],
  ['2084', '',        'z990',      '2003-05-13', '2003-06-16', '2008-06-30', null,         '2014-12-31'],
  ['2064', '2nn',     'z900 G2',   '2002-04-30', '2002-05-15', '2006-06-30', null,         '2014-12-31'],
  ['2066', '',        'z800',      '2002-02-19', '2002-03-29', '2005-12-31', null,         '2014-12-31'],
  ['2064', '1nn',     'z900 G1',   '2000-10-03', '2000-12-18', '2006-06-30', null,         '2014-12-31'],
];

const paraDoc = ([type, model, family, ann, ga, hwWdfm, licWdfm, coslEos]) =>
  ({ type, model, family, ann, ga, hwWdfm, licWdfm, coslEos });

/**
 * Insere o que faltar. Idempotente e não destrutivo: o que já está no banco
 * (inclusive corrigido à mão) fica como está.
 */
async function seedLifecycle({ log } = {}) {
  const { MachineLifecycle } = require('./models');
  const existentes = await MachineLifecycle.find().select('type model').lean();
  const jaTem = new Set(existentes.map((d) => `${d.type}|${d.model || ''}`));

  const faltando = CICLO_DE_VIDA.map(paraDoc).filter((d) => !jaTem.has(`${d.type}|${d.model || ''}`));
  if (!faltando.length) return { inseridos: 0, total: existentes.length };

  await MachineLifecycle.insertMany(faltando, { ordered: false });
  if (log) log(`[ciclo de vida] ${faltando.length} máquina(s) IBM Z carregada(s).`);
  return { inseridos: faltando.length, total: existentes.length + faltando.length };
}

module.exports = { seedLifecycle, CICLO_DE_VIDA };
