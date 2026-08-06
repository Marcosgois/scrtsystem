'use strict';

/*
 * Agregação do painel gerencial: dado um recorte de clientes (uma região com as
 * descendentes, ou uma seleção avulsa), responde consumo total de MSU, evolução
 * mês a mês, top 5 clientes, parque instalado por geração e o agregado de MLC.
 *
 * REGRA QUE NÃO PODE SER QUEBRADA: o consumo faturável de cada cliente depende
 * das TAGS DE MÁQUINA dele — máquina de tag ignorada (dev/test) sai da conta. Por
 * isso o cálculo é feito POR CLIENTE, com o mergeByMonth e o tagContextOf da tela
 * individual, e só DEPOIS somado. Somar os relatórios crus daria um total maior e
 * o painel não bateria com a soma das telas de cliente.
 *
 * Funções puras (recebem os dados já lidos do banco) para poderem ser testadas
 * sem subir servidor.
 */

const id = (v) => (v == null ? null : String(v && v._id ? v._id : v));

/**
 * Série mensal faturável de UM cliente, com a mesma regra da tela dele.
 * @returns Map periodKey -> MSU faturável
 */
function serieDoCliente(client, reports, { mergeByMonth, tagContextOf }) {
  const meses = mergeByMonth(reports || [], tagContextOf(client));
  const m = new Map();
  for (const r of meses) m.set(r.periodKey, Number(r.totalMsuConsumed) || 0);
  return m;
}

/**
 * Consumo do recorte: total, evolução mensal e ranking de clientes.
 *
 * @param clients  [{ _id, name, machineTags, machineTagDefs }]
 * @param reportsByClient  Map clientId -> [relatórios do cliente]
 * @param helpers  { mergeByMonth, tagContextOf } vindos do routes.js
 * @param meses    janela do ranking (padrão 12 últimos meses com dado)
 */
function agregarConsumo(clients, reportsByClient, helpers, { meses = 12 } = {}) {
  const porCliente = new Map();
  const totaisMes = new Map();

  for (const c of clients) {
    const serie = serieDoCliente(c, reportsByClient.get(id(c)) || [], helpers);
    porCliente.set(id(c), serie);
    for (const [k, v] of serie) totaisMes.set(k, (totaisMes.get(k) || 0) + v);
  }

  const chaves = [...totaisMes.keys()].sort();
  const evolucao = chaves.map((k) => ({ periodKey: k, totalMsuConsumed: totaisMes.get(k) }));

  // Janela do ranking: os N últimos meses que TÊM dado (não os N do calendário),
  // senão um mês ainda sem SCRT zeraria a comparação entre clientes.
  const janela = new Set(chaves.slice(-meses));
  const ranking = clients.map((c) => {
    const serie = porCliente.get(id(c)) || new Map();
    let total = 0;
    for (const k of janela) total += serie.get(k) || 0;
    return { clientId: id(c), name: c.name, totalMsuConsumed: total, mesesComDado: [...serie.keys()].filter((k) => janela.has(k)).length };
  }).sort((a, b) => b.totalMsuConsumed - a.totalMsuConsumed);

  const totalJanela = ranking.reduce((a, r) => a + r.totalMsuConsumed, 0);
  for (const r of ranking) r.pctDoTotal = totalJanela > 0 ? (r.totalMsuConsumed / totalJanela) * 100 : 0;

  return {
    evolucao,
    ultimoPeriodKey: chaves.length ? chaves[chaves.length - 1] : null,
    totalUltimoMes: chaves.length ? totaisMes.get(chaves[chaves.length - 1]) : 0,
    janelaMeses: [...janela].sort(),
    totalJanela,
    ranking,
    top5: ranking.slice(0, 5),
  };
}

/**
 * Parque instalado por geração. O type da máquina é o prefixo do modelo
 * ("3931-7C6" -> "3931"), que é a chave da tabela de ciclo de vida.
 *
 * `hoje` entra por parâmetro (e não Date.now() aqui dentro) para o teste poder
 * fixar a data e não ficar dependendo do dia em que roda.
 */
function agregarParque(machines, lifecycles, { hoje = new Date().toISOString().slice(0, 10) } = {}) {
  const porType = new Map();
  for (const l of lifecycles || []) {
    // Um type pode ter mais de um model (2064 = z900 G1 e G2). Para o parque
    // interessa a geração, então basta o primeiro que casar.
    if (!porType.has(String(l.type))) porType.set(String(l.type), l);
  }

  const grupos = new Map();
  for (const m of machines || []) {
    if (m.status === 'substituida' || m.status === 'desativada') continue;   // fora do parque vivo
    const type = String(m.model || '').trim().split('-')[0].toUpperCase();
    const lc = porType.get(type) || null;
    const chave = lc ? lc.family : (type || 'desconhecido');
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        family: chave,
        type: type || null,
        quantidade: 0,
        dormentes: 0,
        hwWdfm: lc ? lc.hwWdfm : null,
        coslEos: lc ? lc.coslEos : null,
        // Fora de suporte = já passou do fim de serviço anunciado.
        foraDeSuporte: !!(lc && lc.coslEos && lc.coslEos < hoje),
        semCicloDeVida: !lc,
      });
    }
    const g = grupos.get(chave);
    g.quantidade += 1;
    if (m.status === 'dormente') g.dormentes += 1;
  }

  const geracoes = [...grupos.values()].sort((a, b) => b.quantidade - a.quantidade);
  return {
    geracoes,
    totalMaquinas: geracoes.reduce((a, g) => a + g.quantidade, 0),
    maquinasForaDeSuporte: geracoes.filter((g) => g.foraDeSuporte).reduce((a, g) => a + g.quantidade, 0),
  };
}

/** Agregado comercial: quantos clientes têm contrato e a soma dos baselines. */
function agregarContratos(clients) {
  let comContrato = 0;
  let baselineMensalTotal = 0;
  const porCliente = [];
  for (const c of clients) {
    const periodos = c.contractPeriods || [];
    const vigente = periodos.filter((p) => !p.endPeriodKey).pop() || periodos[periodos.length - 1] || null;
    const temMlc = !!(vigente && (vigente.years || []).length);
    if (temMlc) comContrato += 1;
    const baseline = Number(c.monthlyBaselineMsu) || 0;
    baselineMensalTotal += baseline;
    porCliente.push({
      clientId: id(c),
      name: c.name,
      contrato: vigente ? vigente.name : null,
      inicio: vigente ? vigente.startPeriodKey : null,
      fim: vigente ? vigente.endPeriodKey : null,
      anos: vigente ? (vigente.years || []).length : 0,
      baselineMensalMsu: baseline || null,
    });
  }
  return { comContrato, semContrato: clients.length - comContrato, baselineMensalTotal, porCliente };
}

module.exports = { agregarConsumo, agregarParque, agregarContratos, serieDoCliente };
