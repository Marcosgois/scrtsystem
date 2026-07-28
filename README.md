# IBM Z Control Desk

Sistema de gestão de ambiente **IBM Z / LinuxONE** por cliente. Reúne, num só lugar, o que hoje
costuma viver espalhado em planilhas:

- **consumo** — leitura do SCRT (Tailored Fit Pricing) com dashboard de MSU, LPARs e projeção;
- **software licenciado** — inventário IBM SW Material, com o casamento licença ↔ S&S;
- **parque físico** — sites, máquinas e LPARs, com a referência de capacidade LSPR;
- **contratos** — o elo entre máquinas e PIDs, com os PDFs assinados e o ciclo de MO/MES.

Tudo com **acesso por cliente**: cada usuário só enxerga (e edita) os clientes que lhe foram
liberados. Roda com Node + Express + MongoDB, sem serviço externo.

> O projeto nasceu como *TFPSystem*, focado só no SCRT — daí o nome do pacote e de algumas
> variáveis. O nome atual é **IBM Z Control Desk**.

## Módulos

O sistema tem cinco módulos, acessíveis pelo menu no topo (mais a homepage em `/` e a
administração de usuários em `/admin`):

| Módulo | Rota | O que faz |
|---|---|---|
| **Consumo zOTC (SCRT)** | `/consumo` | Upload do SCRT mensal, dashboard de MSUs, LPARs, grupos e comparativo mês a mês |
| **Consumo MLC** | `/mlc` | Contrato de MLC por cliente, com o consumo sincronizado do SCRT |
| **Inventário** | `/inventario` | Relatório IBM SW Material: produtos/PIDs, licenças e o casamento com S&S |
| **Infraestrutura** | `/infra` | Parque físico (sites, máquinas, LPARs), referência LSPR e MO/MES |
| **Contratos** | `/contratos` | Contratos ligando máquinas e PIDs, com os PDFs assinados e o ciclo de MO/MES |

Todos compartilham a **mesma lista de clientes**: cadastre o cliente uma vez (no módulo de
Consumo zOTC) e ele aparece em todos. O inventário fica salvo no MongoDB (um inventário atual
por cliente; recarregar substitui o anterior).

## Como rodar

```bash
npm install
npm start
```

Abra `http://localhost:3000`. No **primeiro acesso** a tela de login pede a criação do
administrador (nome, e-mail e senha) — depois disso, é o admin quem cadastra os demais usuários
em `/admin`.

Com o admin criado, o caminho comum é:

1. cadastre o cliente (ex.: CAIXA, BRB) no **Consumo zOTC**;
2. arraste o `.csv` do SCRT para a tela (ou use **Subir SCRT**);
3. em **Infraestrutura**, use *Importar do SCRT* para criar as máquinas já ligadas à referência
   LSPR;
4. em **Inventário**, carregue o relatório IBM SW Material do cliente;
5. em **Contratos**, cadastre o contrato e vincule as máquinas e os PIDs.

O servidor imprime no terminal o log de acesso (quem entrou, quem logou) — ver
[Log de acesso](#log-de-acesso).

### Onde ficam os dados

Por padrão o `npm start` sobe um **MongoDB local persistente junto com a aplicação**, com os
dados gravados em **`./data/mongodb`** (dentro da própria pasta do app). Nada é instalado no
sistema — o binário `mongod` é gerenciado pelo próprio projeto. O banco atende em
`mongodb://127.0.0.1:27017/tfpsystem` (dá para inspecionar com `mongosh` ou Compass), a porta
é configurável via `LOCAL_DB_PORT` no `.env`, e fazer **backup = copiar a pasta `data/`**.

Para usar outro banco (MongoDB Atlas ou um servidor seu), copie `.env.example` para `.env` e
defina `MONGODB_URI` — com a URI definida, o banco local embutido não é iniciado.

### Modo demo (dados descartáveis)

```bash
npm run demo
```

Sobe com um MongoDB **em memória** — bom para testar à vontade, **os dados são perdidos ao encerrar**.

## Acesso e permissões

O acesso é por login, e **não existe cadastro público**: no primeiro acesso o sistema pede a
criação do **administrador**; daí em diante é o admin quem cria os usuários, em `/admin`.

Para cada usuário o admin associa **quais clientes** ele acessa e em que nível:

| Nível | Pode |
|---|---|
| **Ver** | ler tudo do cliente (dashboards, inventário, infraestrutura, contratos) |
| **Ver e editar** | além de ler, subir SCRT, editar máquinas, contratos, MO/MES… |
| **Administrador** | todos os clientes, mais criar/excluir clientes e gerenciar usuários |

A verificação real é no **servidor**: toda rota sob `/api/clients/:id/...` passa por um guard que
exige `view` para leitura e `edit` para escrita (`src/authRoutes.js`). A interface apenas esconde
o que a pessoa não pode fazer — quem tem acesso `view` vê o selo **Somente leitura** e não recebe
os botões de edição.

A sessão é um cookie assinado com HMAC (`httpOnly`, `SameSite=Lax`), a senha é guardada com
`scrypt`, e o segredo fica em `data/auth-secret`. Sem dependência externa de autenticação.


## Consumo zOTC — regra de interpretação do SCRT

> **Consumo mensal = soma da linha `Machine MSU Consumed` de todas as máquinas do Multiplex** (seção `==B5` do SCRT).

O total dos containers (`TOTAL MSU Consumption`) também é lido e usado como conferência — se divergir
da soma das máquinas, o sistema mostra um aviso, mas o valor oficial é sempre a soma das máquinas.

Também são extraídos e salvos por relatório: período (ex.: Jun/2026), nome do cliente no SCRT,
release da ferramenta, máquinas (serial, tipo-modelo, capacidade nominal, pico de utilização,
MSU consumido, flags de dados faltantes), containers, responsável pelo envio e as **LPARs**:

- **Seção `==N7` (DETAIL LPAR USAGE DATA)** — Total MSU Consumed, pico horário e OS por LPAR.
  A soma das LPARs de cada máquina é conferida contra o "Machine MSU Consumed" da máquina
  (e contra a linha CPC da própria seção); divergência gera aviso.
- **Seção `==N5` (DETAIL LPAR DATA)** — maior e 2ª maior 4HRA por LPAR, com data/hora.

Os pares N5/N7 aparecem uma vez por máquina, na ordem das máquinas da seção B5 — o parser
usa essa ordem e valida a associação pelo total CPC.

### Formatos de SCRT aceitos

O parser lida com as variações que aparecem na prática (todas validadas contra arquivos reais
em `SCRT/`):

| Variação | Exemplo | Como é tratada |
|---|---|---|
| **Enterprise TFP · multiplex** | CAIXA (6 máquinas), BB (9 máquinas) | Matriz com uma coluna por máquina; consumo = soma do `Machine MSU Consumed` |
| **Sub-Capacity / MVM · máquina única** | BRB | Campos planos `chave,valor` na B5; `Reporting Period` e `Tool Release` vêm da seção `==C5` |
| **CSV duplo-codificado** | BB | Cada linha vem empacotada como um único campo (`"Customer Name,""BANCO DO BRASIL"""`); o parser detecta e re-interpreta |
| **Separador `;` + aspas simples** | ITAÚ | Delimitado por ponto e vírgula, valores entre aspas simples (`Customer Name;'BANCO ITAU SA'`), UTF-8 com BOM; o separador é detectado automaticamente |
| **Planilha `.xlsx` (aba = máquina)** | ITAÚ | Uma aba por máquina; o sistema lê todas as abas e as combina num único multiplex (soma o consumo, une máquinas/LPARs) |
| **Linha extra antes do banner** | Excel (`sep=,`) | O banner `==B5` é localizado em qualquer posição |

### Comportamentos importantes

- **Vários SCRTs no mesmo mês são somados**: quando o cliente tem sites/máquinas separados
  (ex.: BRB com SCN e SIG), suba os dois arquivos e o mês passa a ser a soma deles. O sistema
  identifica cada origem pelas **máquinas que ela reporta** (número de série), então:
  - arquivo com máquinas novas → **soma** ao mês (aparece o selo "N SCRTs" no histórico);
  - reenvio do mesmo conjunto de máquinas → **substitui** aquela origem (não duplica);
  - máquina repetida em duas origens do mesmo mês → **conflito**, sinalizado em vermelho no
    histórico e no detalhe do mês, porque o consumo estaria contado em dobro.

  No card de máquinas há a lista "N SCRTs somados neste mês", com o arquivo, as máquinas e o
  consumo de cada origem — e um botão para remover uma origem específica sem apagar o mês inteiro.
- **Cliente errado**: se o `Customer Name` do SCRT não bater com o cliente selecionado
  (ex.: subir SCRT da CAIXA no BRB), o upload funciona mas mostra um aviso.
- **Baseline mensal** (opcional, por cliente): defina o teto contratual em "Definir baseline" para
  habilitar a linha de baseline no gráfico, o KPI de folga/excedente e as tags Acima/Abaixo baseline.
- **Encoding**: aceita SCRT em ISO-8859-1 (padrão da ferramenta IBM) e UTF-8, com linhas CRLF/CR/LF.

### Dashboard

- KPIs: consumo do mês (com MoM), crescimento ano-a-ano (YTY), média e acumulado de 12 meses,
  baseline com folga/excedente.
- Gráfico com três modos: **Mensal** (barras + tendência por regressão linear + baseline mensal),
  **Por grupo** (barras empilhadas com o consumo de cada grupo de LPARs em cor própria; meses sem
  seções N7 aparecem como "Sem detalhe por LPAR") e **Acumulado 12M** (soma móvel de 12 meses de
  calendário + baseline anual = 12 × mensal).
- **Clique em um mês no gráfico** (qualquer modo) para focar o dashboard inteiro nele: KPIs,
  histórico, máquinas e LPARs passam a refletir o mês clicado, e a barra dele fica destacada.
- Histórico mensal com MoM, YTY e coluna **Acum. 12M** — clique em um mês para ver o detalhe.
- **Todas as tabelas são ordenáveis**: clique no cabeçalho da coluna para ordenar (MSU consumido,
  % do total, capacidade, pico, variação, contribuição, nome, mês…). O primeiro clique ordena do
  maior para o menor, o segundo inverte, e o terceiro volta à ordem padrão da tabela. A coluna
  ativa fica destacada com ▼/▲.
- Detalhe por máquina: tipo-modelo, capacidade nominal, pico, MSU consumido e % do total.
  **Clique em uma máquina para filtrar o card de LPARs por ela** (o % passa a ser relativo à
  máquina; um chip "Máquina X ✕" mostra o filtro ativo — clique nele ou na máquina de novo
  para limpar). O filtro vale nas duas visões (explodida/agrupada) e abas (N7/N5), e é mantido
  ao navegar entre meses do mesmo cliente.
- **Capacity planning** — projeta o consumo de 1 a 5 anos à frente, por dois métodos escolhidos
  na hora: **regressão linear** (tendência) e **SARIMA** (tendência + sazonalidade). Mostra o
  gráfico de histórico + projeção com intervalo de 95% e a tabela consolidada por ano, com
  crescimento e % do baseline anual — o material para a conversa de capacidade com o cliente.

  > **Quanto histórico é preciso:** a sazonalidade de 12 meses só é estimada com **24 meses ou
  > mais** (dois ciclos). Com menos, o SARIMA roda sem a parte sazonal (vira ARIMA) e o sistema
  > avisa na tela; com menos de 6 meses cai para a regressão linear; com menos de 3 meses recusa.
  > Como esses gráficos vão para o cliente, a limitação é sempre declarada em vez de mascarada.

- **Comparativo mês a mês** — responde "quem puxou o consumo pra cima?" em duas etapas:
  primeiro a variação por **máquina** (ordenada do maior aumento para a maior queda, com a
  contribuição de cada uma na variação total), depois **clique na máquina** para ver a variação
  das **LPARs dentro dela**. A soma das variações fecha sempre com a variação total do mês.
  O mês base é o anterior por padrão, e pode ser trocado no seletor "comparar com" para comparar
  com qualquer outro mês (ex.: mesmo mês do ano passado). Máquinas/LPARs que aparecem ou somem
  entre os meses são marcadas como **nova** / **removida**.
- **Consumo por LPAR** do mês selecionado, em duas abas: **Uso (N7)** — MSU consumido, % do
  total, pico horário — e **Picos 4HRA (N5)** — maior e 2ª maior 4HRA com data/hora.
- **Grupos de LPARs** (por cliente, salvos no MongoDB): em **⚙ Grupos** você cria grupos como
  "Produção" = P0, P4, PC…; cada LPAR pertence a no máximo um grupo. A visão **Agrupada** soma
  o consumo (N7) por grupo — nos picos (N5), mostra os dois maiores picos individuais do grupo,
  já que 4HRA não é somável — e LPARs sem grupo continuam aparecendo individualmente.
  A visão **Explodida** mostra LPAR a LPAR, como sempre. Na agrupada, **clique na linha do
  grupo (chevron ▸)** para expandir e ver as LPARs que o compõem.

## Inventário de software

`public/inventario.html` é um arquivo **versionado e autocontido** — edite direto nele, como
qualquer outra página. Ele reúne, no mesmo arquivo: o painel original (parser, filtros, tabelas,
modais e exportações), o sistema visual do IBM Z Control Desk, a barra de módulos e a ponte de
persistência que grava no MongoDB via API (em vez de localStorage).

Historicamente essa página era gerada por um build a partir de um painel externo; isso foi
removido — hoje ela é fonte de primeira classe, mantida no repositório.

**Termos aditivos.** Um contrato pode ter termos aditivos: cada um é um registro próprio
(número, assinatura, vigência, valor e arquivos), vinculado ao contrato de origem. O valor do
aditivo **soma** ao do contrato na visão consolidada — a lista mostra
`R$ total (R$ contrato + R$ aditivos)`. Um aditivo não tem aditivo, e excluir o contrato de
origem exige remover os aditivos antes.

**Vincular ao contrato, com sugestão.** No inventário, cada PID tem um botão *+ contrato* que
sugere qual contrato cobre aquele software: vale o contrato (ou aditivo) **assinado mais
recente que seja anterior à Eff. Date** do registro — o que estava vigente quando ele entrou.
Na infraestrutura, cada máquina tem o mesmo botão, e clicar na máquina abre os **detalhes**:
contrato, total de MIPS pelo capacity marker (LSPR), configuração e as **LPARs que o SCRT
reporta** para ela — sem precisar cadastrá-las à mão.

**Demo/PoC.** Cada registro de software pode ser marcado como **Demo/PoC** (botão na linha).
A marcação é por PID + serial e, como os ajustes de par e os vínculos de contrato, fica fora do
PUT do inventário — ou seja, **sobrevive à recarga do relatório**. Um botão ao lado de
"Ocultar MSU registration" esconde/mostra os marcados, e o filtro vale também nas exportações.

**Atalho por cliente.** Quem está logado vê, na página inicial, uma caixinha por cliente a que
tem acesso (a API já devolve só os permitidos). Clicar abre o **Consumo zOTC** com aquele
cliente selecionado.

### Link para o IBM ProductPages (w3)

No modal de cada produto há o link **"Ver &lt;PID&gt; no IBM ProductPages"**, que abre
`https://w3.ibm.com/systems/productpages/index.html?pid=<PID>` — onde ficam equipe (manager,
desenvolvedor), carta de anúncio, EOS e GA.

Por que só o link, e não os dados trazidos para cá: o portal é uma SPA cuja API
(`/systems/productpages/pp/product/*`) exige sessão autenticada do w3 (IBM SSO) — sem ela, os
endpoints respondem vazio — e não envia cabeçalhos CORS, o que também impede o navegador do
usuário de consultá-la a partir do TFPSystem. Um crawler exigiria credenciais de SSO, então o
link (que abre a página onde o usuário já está autenticado) é a alternativa viável.

## Infraestrutura: LSPR e importação do SCRT

O módulo de **Infraestrutura** (`/infra`) traz duas facilidades ligadas ao SCRT:

- **Importar do SCRT** (aba Máquinas): cria uma máquina de infraestrutura para cada serial do
  último SCRT do cliente e atualiza as já cadastradas (casadas pelo serial). Cada máquina é
  ligada automaticamente à sua linha **LSPR** pelo *type-model* (ex.: `3931-705`).
- **Referência LSPR** (capacidade por modelo IBM Z): MIPS, MSU, #CPs e #IFLs máximos por modelo,
  vindos do zPCR *Configuration Summary*. São dados públicos da IBM, versionados em
  [src/data/lspr.json](src/data/lspr.json) (~3.000 modelos) e carregados no banco no primeiro
  start (idempotente). No cadastro da máquina há um seletor para conferir/ajustar o vínculo à mão.

Consulta via API: `GET /api/lspr?q=<texto>&type=<9175>&generation=<z16>`, `GET /api/lspr/:model`,
`GET /api/lspr/meta`. Para reimportar após uma versão nova do arquivo: `npm run import:lspr`.

## Contratos, MO/MES e histórico da máquina

O módulo **Contratos** (`/contratos`) é o elo entre o parque físico e o software licenciado:
um contrato reúne as **máquinas** que ele cobre, os **PIDs** (licença e S&S), os **PDFs**
assinados (contrato, aditivos) e os eventos de atualização tecnológica.

**MO e MES.** Uma atualização nasce como **proposta** na plataforma, com a comparação
*antes → depois* (CP, zIIP, IFL, CF, memória e MSU/MIPS do LSPR) e o delta de capacidade:

- **MO** (*Migration Offering*) — troca de máquina: sai a velha, entra uma nova.
- **MES** — mantém a máquina e faz upgrade lógico (mais memória, mais capacidade).

O ciclo é `proposta → contratado → executado` (e `cancelada`). Marcar como *contratado* exige
o contrato vinculado. **Executar é o único passo que altera o parque**: o MES aplica a
configuração na própria máquina; o MO cria a nova (serial em maiúsculas, para o
`import-scrt` continuar casando) e marca a antiga como **substituída** — ela **não é
apagada**, para preservar o consumo SCRT histórico e as LPARs. Dá para **desfazer**: o
sistema guarda a configuração real do momento da execução (que pode ter mudado desde a
proposta) e recusa desfazer se a máquina nova já ganhou LPARs próprias.

Cada máquina tem uma **linha do tempo** (botão *Histórico* na Infraestrutura) com o
cadastro, os MO/MES com contrato e valores, a cadeia de gerações e o consumo SCRT mês a mês
— inclusive depois de ela sair do parque.

**Vínculo de software.** Fica guardado no contrato, com um snapshot da descrição do produto.
Isso é proposital: `Inventory.products` é substituído por inteiro a cada recarga do
inventário, então guardar o vínculo do outro lado o faria desaparecer. Um mesmo registro
(PID + serial) só pode estar em um contrato por cliente — ao tentar repetir, a API responde
`409` e a tela oferece *mover*. No inventário, cada PID vinculado mostra um selo com o
número do contrato, que leva direto para ele.

## Log de acesso

O servidor mostra, no terminal e num arquivo por dia em `data/logs/app-AAAA-MM-DD.log`,
**quem acessou o quê**:

```
[27/07 16:59:48] AUTH  1º admin    hulk@ibm.com  local
[27/07 16:59:48] AUTH  login FALHA  hulk@ibm.com  local  (senha incorreta)
[27/07 16:59:48] AUTH  login OK     vera@x.com  local
[27/07 16:59:48]   200 GET    /infra                    1ms  vera@x.com  local
[27/07 16:59:48] AUTH  negado      vera@x.com  POST /api/clients  (criar cliente exige administrador)
[27/07 16:59:48]  !403 POST   /api/clients              2ms  vera@x.com  local
[27/07 16:59:48] AUTH  logout      vera@x.com  local
```

Uma linha por requisição (status, método, rota, tempo, **usuário** e IP; `!` marca 4xx e `!!`
marca 5xx), mais os eventos de autenticação: login OK/falha **com o motivo**, logout, criação do
1º admin e cada tentativa barrada por falta de permissão.

Arquivos estáticos (css/js/imagens) ficam de fora por padrão, senão cada página vira dez linhas.
No arquivo o carimbo é ISO, o que facilita `grep`. **Nada de corpo de requisição, senha, token ou
cookie entra no log.** Como fica em `data/`, não vai para o repositório.

Ajustes no `.env`: `LOG_REQUESTS=all|api|off`, `LOG_AUTH=0` (silencia os eventos de auth),
`LOG_STATIC=1` (inclui estáticos), `LOG_FILE=0` (só terminal) e `LOG_DIR`.

## Celular e tablet

Todas as telas funcionam no celular. As regras vivem em `public/styles.css` (e, espelhadas,
no `<style>` do `public/inventario.html`, que tem CSS próprio):

- **≤900px** — a barra do topo empilha: marca e navegação numa linha (a navegação rola na
  horizontal), ações na linha de baixo, podendo quebrar entre si. Ela também deixa de ser
  *sticky*: empilhada ficaria alta demais e comeria meia tela ao rolar.
- **≤720px** — KPIs em duas colunas, formulários e barras de filtro em coluna única, abas
  roláveis, modais quase em tela cheia com rolagem interna, e o cabeçalho dos modais grandes
  com o título em cima e as ações embaixo.
- **≤420px** — KPIs em uma coluna (os valores de MSU são longos) e botões da barra em dupla.

Tabela larga **rola dentro do próprio card**, nunca a página. Para isso valem duas regras que
é fácil errar: contêineres de flex/grid precisam de `min-width: 0`, e o grid de duas colunas
usa `minmax(0, 1fr)` — com `1fr` puro o piso implícito de `min-content` faz a tabela esticar a
coluna e a página inteira passa a rolar na horizontal.

## Banco no servidor e cópia local

O MongoDB de produção fica no servidor (`zcontroldesk`), que é a **fonte da verdade**. Esta
máquina mantém uma **cópia** para trabalho offline e segurança.

### Por que cópia e não um replica set

Um membro secundário de replica set precisa ser alcançável **pelo primário**. Um notebook atrás
de NAT, desligado a maior parte do tempo, não é — e um secundário inalcançável só atrapalha o
primário (eleições, oplog retido). Cópia periódica por *pull* entrega o que se quer aqui — ter
sempre uma cópia — sem fragilizar o servidor.

### Comandos

```bash
npm run db:status   # compara os dois lados; não escreve nada
npm run db:pull     # servidor → local   (atualiza a cópia)
npm run db:push     # local → servidor   (carga inicial / subir trabalho local)
```

Os dois últimos **mostram o plano e não fazem nada** sem `--yes`:

```bash
node scripts/sync-db.js --pull --yes
```

Travas embutidas: recusa se origem e destino forem o mesmo servidor, e recusa apagar um destino
com dados a partir de uma origem vazia (só com `--force`). A cópia substitui coleção por coleção
— nunca escreve na origem. Os índices são recriados pela aplicação no próximo start.

A URI do servidor vive em `SYNC_REMOTE_URI` no `.env`, que **não é versionado**. Nenhuma
credencial entra no repositório.

### Os arquivos não estão no banco

Os PDFs de contrato e os SCRTs originais ficam no **disco**, não no MongoDB (o limite de 16 MB
por documento não comporta uma planilha de 30 MB). Sincronizar só o banco deixa a aplicação sem
eles — "Ver arquivos SCRT" e a prévia do contrato passam a dar 404. As duas pastas:

```
data/scrt-files/       # SCRTs originais enviados
data/contract-files/   # PDFs de contrato e termos aditivos
```

Com acesso SSH ao servidor, o par do `db:pull` é:

```bash
rsync -avz --delete usuario@148.100.74.249:/caminho/do/app/data/scrt-files/     data/scrt-files/
rsync -avz --delete usuario@148.100.74.249:/caminho/do/app/data/contract-files/ data/contract-files/
```

### Automatizar a cópia

Para uma cópia diária às 20h, `crontab -e`:

```cron
0 20 * * * /usr/local/bin/node scripts/sync-db.js --pull --yes >> data/logs/sync.log 2>&1
```

O banco local precisa estar no ar na hora (o `npm start` o mantém). Confira o caminho do node com
`which node`.

## Publicar a aplicação

**GitHub Pages não roda esta aplicação.** Ele publica apenas arquivos estáticos: não executa
Node/Express, não assina o cookie de sessão, não recebe upload, e o navegador não fala o
protocolo do MongoDB. Pôr a string de conexão no código do front entregaria usuário e senha do
banco para qualquer visitante.

### O que o Pages publica: o portal

A pasta [`docs/`](docs/) tem uma página estática que serve de **porta de entrada** — o que o
sistema faz, os cinco módulos, como rodar, e o botão para a aplicação onde ela estiver no ar.
É autocontida (nenhum recurso externo) e não contém dado de cliente nem endereço de servidor.

Para ligar, em **Settings → Pages** do repositório: *Source* = `Deploy from a branch`,
*Branch* = `main`, pasta = `/docs`. Em poucos minutos sai em
`https://pages.github.ibm.com/marcosgois/zControlDesk/`.

Enquanto a aplicação não estiver publicada, a página diz isso com todas as letras. Quando
estiver, edite a constante `APP_URL` no topo do `<script>` em `docs/index.html` que o botão
**Acessar o painel** aparece:

```js
const APP_URL = 'https://zcontroldesk.seu-dominio.ibm.com';
```

> Um detalhe que costuma morder: servir o **front** pelo Pages e chamar a **API** no servidor
> não funciona bem. A página do Pages é HTTPS, então `fetch` para um servidor `http://` é
> bloqueado como conteúdo misto; e mesmo com HTTPS o cookie de sessão passa a ser *cross-site*,
> exigindo `SameSite=None` e CORS com credenciais — que o Safari bloqueia de qualquer forma.
> Front e API no mesmo domínio (a aplicação servindo os dois) evita tudo isso.

### Onde a aplicação roda

O caminho natural é **no mesmo servidor onde já está o MongoDB**:

```bash
# no servidor
git clone git@github.ibm.com:marcosgois/zControlDesk.git && cd zControlDesk
npm install
echo 'MONGODB_URI=mongodb://admin:SENHA@127.0.0.1:27017/tfpsystem?authSource=admin' > .env
npm start            # sob pm2/systemd para subir junto com a máquina
```

Repare no `127.0.0.1`: com a aplicação no mesmo host, o banco não precisa mais aceitar conexões
de fora — o que permite **fechar a porta 27017 para a internet** (ver abaixo). Um nginx na frente
resolve domínio e HTTPS.

## API (resumo)

Todas as rotas ficam sob `/api`. Exceto `/api/auth/*`, todas exigem login; as que estão sob
`/api/clients/:id/...` ainda passam pelo controle de acesso por cliente.

**Autenticação e usuários**

| Método | Rota | Descrição |
|---|---|---|
| GET | `/auth/status` | Se precisa criar o 1º admin e quem está logado |
| POST | `/auth/setup` | Cria o 1º admin (só funciona com o banco sem usuários) |
| POST | `/auth/login` · `/auth/logout` | Sessão |
| GET | `/auth/me` | Usuário atual |
| GET POST PUT DELETE | `/admin/users[/:id]` | Gestão de usuários e acessos (admin) |

**Clientes e consumo (SCRT)**

| Método | Rota | Descrição |
|---|---|---|
| GET POST | `/clients` | Lista (com `accessLevel`) · cria (admin) |
| PATCH DELETE | `/clients/:id` | Atualiza · exclui com os relatórios (admin) |
| POST GET | `/clients/:id/reports` | Upload do SCRT (multipart `file`) · lista |
| GET DELETE | `/clients/:id/months/:periodKey` | Mês fundido (soma das origens) · exclui |
| GET | `/clients/:id/dashboard` | Série mensal com MoM/YTY |
| GET | `/clients/:id/compare?target=&base=` | Variação entre dois meses |
| GET | `/clients/:id/forecast?method=&years=` | Projeção (`linear`\|`sarima`) |
| PUT | `/clients/:id/machine-tags` | Tags de máquina (Produção/DW/Dev-Test) |
| GET DELETE | `/reports/:id` | Relatório completo · exclui |
| GET | `/reports/:id/file[?download=1]` | SCRT original guardado |
| GET PUT DELETE | `/clients/:id/mlc` | Contrato de MLC |

**Inventário de software**

| Método | Rota | Descrição |
|---|---|---|
| GET | `/inventories` | Resumo por cliente |
| GET PUT DELETE | `/clients/:id/inventory` | Inventário completo |
| PUT | `/clients/:id/inventory/pairs` | Ajustes manuais do par licença ↔ S&S |
| PUT | `/clients/:id/inventory/flags` | Marcações por registro (Demo/PoC) |
| GET | `/clients/:id/inventory/records?q=` | Busca enxuta (autocomplete) |

**Infraestrutura e LSPR**

| Método | Rota | Descrição |
|---|---|---|
| GET POST PUT DELETE | `/clients/:id/infra/sites[/:siteId]` | Sites |
| GET POST PUT DELETE | `/clients/:id/infra/machines[/:machineId]` | Máquinas (com `scrt`, `lspr`, `contractRef`) |
| POST | `/clients/:id/infra/machines/import-scrt` | Cria/atualiza máquinas a partir do SCRT |
| GET | `/clients/:id/infra/machines/:id/detalhes` | Contrato, MIPS e LPARs vindas do SCRT |
| GET | `/clients/:id/infra/machines/:id/historico` | Linha do tempo + cadeia de substituição |
| GET POST PUT DELETE | `/clients/:id/infra/lpars[/:lparId]` | LPARs |
| GET | `/lspr` · `/lspr/:model` · `/lspr/meta` | Referência de capacidade IBM Z |

**Contratos e MO/MES**

| Método | Rota | Descrição |
|---|---|---|
| GET POST | `/clients/:id/contracts` | Lista (com aditivos e totais) · cria |
| GET PUT DELETE | `/clients/:id/contracts/:cid` | Detalhe · edita · exclui |
| POST DELETE | `/clients/:id/contracts/:cid/machines[/:mid]` | Vínculo com máquinas |
| POST | `/clients/:id/contracts/:cid/software[/unlink]` | Vínculo com PIDs |
| GET | `/clients/:id/contracts/software-map` | Mapa PID\|serial → contrato |
| POST GET DELETE | `/clients/:id/contracts/:cid/files[/:fid]` | PDFs assinados |
| GET POST PUT DELETE | `/clients/:id/migrations[/:eid]` | Eventos de MO/MES |
| POST | `/clients/:id/migrations/:eid/status` | proposta → contratado → cancelada |
| POST | `/clients/:id/migrations/:eid/executar` · `/desfazer` | Aplica no parque · reverte |


## Estrutura

```
server.js                 # Express: log, auth, rotas de página e API, estáticos
src/
  models.js               # Mongoose: Client, ScrtReport, Inventory, User, LsprModel,
                          #   InfraSite/Machine/Lpar, Contract, MigrationEvent
  routes.js               # API dos módulos (consumo, inventário, infra, contratos, MO/MES)
  auth.js                 # scrypt + cookie de sessão assinado (sem dependência externa)
  authRoutes.js           # login/setup/logout, gestão de usuários e o guard por cliente
  logger.js               # log de acesso (terminal + arquivo por dia)
  db.js                   # conexão + migrações automáticas do banco
  localDb.js              # MongoDB local persistente em ./data/mongodb
  scrtParser.js           # parser do CSV SCRT (latin-1/UTF-8, seções ==B5/==N5/==N7)
  xlsx.js                 # leitura de SCRT em planilha (uma aba por máquina)
  forecast.js             # projeção linear e SARIMA
  mlc.js                  # cálculo do contrato de MLC
  lsprSeed.js             # carga da referência LSPR no banco
  data/lspr.json          # ~3.000 modelos IBM Z (MIPS/MSU/CPs) — dados públicos IBM
public/
  home.html/.js           # landing animada (Three.js + GSAP) e atalho por cliente
  login.html              # login e criação do 1º admin
  index.html/app.js       # Consumo zOTC (SCRT)
  mlc.html/.js            # Consumo MLC
  inventario.html         # Inventário — página autocontida (CSS e ponte inline)
  infra.html/.js          # Infraestrutura
  contratos.html/.js      # Contratos
  admin.html/.js          # Usuários e acessos
  auth-client.js          # menu do usuário, botão Home, 401 global, modo somente-leitura
  migration-modal.js      # modais de MO/MES, detalhes e histórico (infra + contratos)
  scrt-files.js           # modal dos arquivos SCRT do mês
  styles.css              # sistema visual (IBM Carbon) + regras de celular
  vendor/                 # chart.umd.js, three.min.js, gsap.min.js
scripts/                  # demo, import da referência LSPR, import do MLC da CAIXA
test/                     # 8 suítes (ver abaixo)
data/                     # NÃO versionado: banco, PDFs, logs, segredo de sessão
SCRT/<CLIENTE>/           # NÃO versionado: arquivos SCRT reais
```


## Testes

```bash
npm test                  # roda tudo (8 suítes)

npm run test:parser       # parser contra os SCRTs reais + casos sintéticos
npm run test:forecast     # projeção linear/SARIMA e os limites de histórico
npm run test:mlc          # cálculo do contrato de MLC
npm run test:migration    # migração de bancos criados por versões anteriores
npm run test:auth         # login e a matriz de acesso (view/edit/admin)
npm run test:infra-lspr   # referência LSPR e importação de máquinas do SCRT
npm run test:contratos    # contratos, aditivos, vínculos, MO/MES e Demo/PoC
npm run test:e2e          # API completa com MongoDB em memória
```

As suítes sobem um MongoDB em memória e exercitam a API de verdade (inclusive login), sem mexer
no banco local. Não há framework: cada arquivo é um script Node com um `check(nome, condição)`.


### Migração automática do banco

Bancos criados por versões anteriores são migrados na inicialização
([src/db.js](src/db.js)): índices obsoletos são removidos e campos novos são preenchidos.
Isso é necessário porque o Mongoose cria índices novos mas **não remove os antigos** — e um
índice obsoleto continua sendo aplicado. Exemplo: o índice `{client, periodKey}` da época em que
só existia um SCRT por mês impedia subir o segundo site do mesmo mês (erro `E11000`).

## Repositórios

O mesmo código vive em dois repositórios, mantidos em sincronia:

| Remote | Endereço |
|---|---|
| `origin` (fetch) | `git@github.com:Marcosgois/scrtsystem.git` |
| `origin` (push) | os **dois** endereços abaixo |
| `ibm` | `git@github.ibm.com:marcosgois/zControlDesk.git` |

O `origin` está configurado com duas URLs de push, então **um `git push` atualiza os dois**:

```bash
git push
```

Para mirar só um deles: `git push ibm main`. O `fetch` vem do `github.com` — como o push sempre
vai para os dois, eles não divergem.

Vai para o repositório **só código-fonte**. Ficam de fora, pelo `.gitignore`: `.env`, a pasta
`data/` (banco, PDFs de contrato, logs de acesso) e os SCRTs, inventários e planilhas reais dos
clientes.

