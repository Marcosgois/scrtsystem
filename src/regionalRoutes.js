'use strict';

/*
 * Rotas do painel gerencial. Montadas em /api/regional atrás do requireManager,
 * então gerente e admin entram e usuário comum toma 403.
 *
 * O recorte vem por região (com as descendentes) OU por uma lista de clientes.
 * O cálculo em si mora em src/regional.js, que é puro e testado.
 */

const express = require('express');
const mongoose = require('mongoose');
const { Client, ScrtReport, InfraMachine, Region, MachineLifecycle, LsprModel } = require('./models');
const regioes = require('./regions');
const { agregarConsumo, agregarParque, agregarContratos, agregarCapacidade, anexarCapacidade } = require('./regional');
const { mergeByMonth, tagContextOf } = require('./routes');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/** Árvore de regiões com a contagem de clientes de cada nível. */
router.get('/regions', asyncHandler(async (req, res) => {
  const [regions, clients] = await Promise.all([
    Region.find().sort({ name: 1 }).lean(),
    Client.find().select('name region').sort({ name: 1 }).lean(),
  ]);
  res.json({
    arvore: regioes.montarArvore(regions, clients),
    regions,
    clients,
    semRegiao: clients.filter((c) => !c.region).length,
  });
}));

/**
 * O painel. Recorte por ?region=<id> (traz as descendentes) ou ?clients=a,b,c.
 * Sem nenhum dos dois, agrega TODOS os clientes.
 */
router.get('/overview', asyncHandler(async (req, res) => {
  const [regions, todos] = await Promise.all([
    Region.find().lean(),
    Client.find().sort({ name: 1 }).lean(),
  ]);

  let clients = todos;
  let recorte = { tipo: 'todos', nome: 'Todos os clientes', caminho: [] };

  if (req.query.region && isValidId(req.query.region)) {
    const alvo = regions.find((r) => String(r._id) === String(req.query.region));
    if (!alvo) return res.status(404).json({ error: 'Região não encontrada.' });
    clients = regioes.clientesDaRegiao(regions, todos, req.query.region);
    recorte = { tipo: 'regiao', regionId: String(alvo._id), nome: alvo.name, caminho: regioes.caminho(regions, alvo._id) };
  } else if (req.query.clients) {
    const ids = new Set(String(req.query.clients).split(',').map((s) => s.trim()).filter(isValidId));
    clients = todos.filter((c) => ids.has(String(c._id)));
    recorte = { tipo: 'selecao', nome: `${clients.length} cliente(s) selecionado(s)`, caminho: [] };
  }

  if (!clients.length) {
    return res.json({
      recorte, clients: [],
      consumo: { evolucao: [], ranking: [], top5: [], totalJanela: 0, totalUltimoMes: 0, ultimoPeriodKey: null },
      parque: { geracoes: [], totalMaquinas: 0, maquinasForaDeSuporte: 0 },
      contratos: { comContrato: 0, semContrato: 0, baselineMensalTotal: 0, porCliente: [] },
    });
  }

  const ids = clients.map((c) => c._id);
  const [reports, machines, lifecycles] = await Promise.all([
    // Só os campos que a fusão mensal usa: o documento inteiro traz o SCRT bruto
    // e um recorte grande de clientes viraria dezenas de MB à toa.
    ScrtReport.find({ client: { $in: ids } })
      .select('client periodKey periodLabel totalMsuConsumed containersTotalMsu processorsInMultiplex machines lpars containers')
      .lean(),
    // lsprModel entra porque é dele que sai o type ("3931-7C9" -> 3931) quando o
    // cliente gravou o modelo em texto livre ("IBM Z z16/700").
    // Os campos de processador entram porque a capacidade instalada por cliente
    // (MIPS/IFLs no ranking) sai daqui — IFLs do cadastro, MIPS do LSPR.
    InfraMachine.find({ client: { $in: ids } })
      .select('client model lsprModel status cps ziips iflsActive').lean(),
    MachineLifecycle.find().lean(),
  ]);

  // Só as linhas LSPR dos modelos que aparecem no recorte — a tabela inteira são
  // 3.190 documentos e o painel precisa de algumas dezenas.
  const modelos = [...new Set(machines.map((m) => m.lsprModel).filter(Boolean))];
  const lsprs = modelos.length ? await LsprModel.find({ model: { $in: modelos } }).select('model mips').lean() : [];

  const reportsByClient = new Map();
  for (const r of reports) {
    const k = String(r.client);
    if (!reportsByClient.has(k)) reportsByClient.set(k, []);
    reportsByClient.get(k).push(r);
  }

  // O ranking sai do consumo e ganha a capacidade instalada de cada cliente —
  // são grandezas de origens diferentes (SCRT x cadastro/LSPR) na mesma linha,
  // por isso a tela precisa rotular qual é qual.
  const consumo = agregarConsumo(clients, reportsByClient, { mergeByMonth, tagContextOf });
  const capacidade = agregarCapacidade(machines, lsprs);
  consumo.ranking = anexarCapacidade(consumo.ranking, capacidade);
  consumo.top5 = consumo.ranking.slice(0, 5);

  res.json({
    recorte,
    clients: clients.map((c) => ({ _id: c._id, name: c.name, region: c.region })),
    consumo,
    parque: agregarParque(machines, lifecycles),
    contratos: agregarContratos(clients),
  });
}));

module.exports = router;
