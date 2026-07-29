# Deploy — IBM Z Control Desk

No ar em **<https://zcontroldesk.linuxone.com.br>** (produção) e
**<https://zcontroldesk-dev.linuxone.com.br>** (desenvolvimento), atrás do Cloudflare,
no mesmo LinuxONE que roda o MongoDB. Este documento descreve **o que está instalado de
verdade** e como operar no dia a dia. Não é um plano: é o registro da instalação.

## Dois ambientes e os domínios

São duas instâncias no mesmo servidor, isoladas: código, usuário de serviço, banco e
arquivos separados. Publica-se em **dev** primeiro, testa, e promove-se **o mesmo commit**
para **prod**.

| | Produção | Desenvolvimento |
|---|---|---|
| Domínio | `zcontroldesk.linuxone.com.br` | `zcontroldesk-dev.linuxone.com.br` |
| Código | `/opt/zcontroldesk` | `/opt/zcontroldesk-dev` |
| Serviço | `zcontroldesk` (porta 8008) | `zcontroldesk-dev` (porta 8009) |
| Banco | `tfpsystem` (usuário `zcd_app`) | `tfpsystem_dev` (usuário `zcd_dev`) |
| Dados | `/var/lib/zcontroldesk` (dono `zcd`) | `/var/lib/zcontroldesk-dev` (dono `zcd-dev`) |
| Ambiente | `/etc/zcontroldesk.env` | `/etc/zcontroldesk-dev.env` |
| Acesso | login do app | **basic-auth** (usuário `dev`) + login do app |

Publicar e promover, do Mac:

```bash
./deploy/deploy.sh dev --sim     # publica o HEAD em dev
```

```bash
./deploy/deploy.sh prod --sim    # promove o MESMO commit para prod
```

Sem `--sim` é só ensaio. O script exige árvore git limpa e sobe `git archive HEAD`.

Atualizar o dev com uma cópia fresca de prod (banco + arquivos), de mão única:

```bash
./deploy/refresh-dev.sh --sim
```

## CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` automatiza o mesmo fluxo manual: **push na `main` → testa →
publica em dev → publica em prod (com aprovação manual)**. Pull request só roda os testes;
dá para disparar à mão em **Actions → Run workflow**. O deploy é o próprio `deploy.sh`
(reaproveitado via `ZCD_KEY/ZCD_HOST/ZCD_USER`), então CI e mão fazem exatamente a mesma
coisa — `git archive HEAD` → `npm ci` → restart → healthcheck em `/login`.

Roda **só no github.ibm.com** (`if: github.server_url == 'https://github.ibm.com'`); o
espelho público no github.com pula todos os jobs — sem deploy duplo, sem secrets lá. Os
jobs de **deploy** ainda têm um interruptor: só rodam com a variável **`DEPLOY_ENABLED=true`**.
Enquanto ela não existe, todo push roda **só os testes** — assim dá para ligar o pipeline
por partes sem um deploy prematuro falhando por falta de secret.

Para ligar (uma vez, no repositório `github.ibm.com/marcosgois/zControlDesk`):

1. **Uma chave SSH dedicada ao CI** (não reuse a `zDesk.pem` pessoal):
   ```bash
   ssh-keygen -t ed25519 -f zcd-ci -N "" -C "github-actions-deploy"
   ```
   Ponha a **pública** no servidor, na conta `linux1`:
   ```bash
   ssh -i "…/zDesk.pem" linux1@148.100.74.249 'cat >> ~/.ssh/authorized_keys' < zcd-ci.pub
   ```
   > Como `linux1` tem sudo sem senha, essa chave = acesso total ao servidor. É inerente
   > ao modelo push-por-SSH. Guarde o privado só no secret; apague o arquivo local depois.

2. **Secrets** (Settings → Secrets and variables → Actions):
   - `DEPLOY_SSH_KEY` — o conteúdo do arquivo **privado** `zcd-ci`.
   - `DEPLOY_HOST` — `148.100.74.249`.
   - `DEPLOY_USER` — `linux1`.

3. **Aprovação manual do prod** (Settings → Environments → **prod** → *Required reviewers*):
   adicione quem aprova. Sem isso, o job de prod publica direto após o dev. O ambiente
   **dev** não precisa de proteção.

4. **Ligar o pipeline** (Settings → Secrets and variables → Actions → *Variables*):
   crie a variável **`DEPLOY_ENABLED`** com valor `true`. Só depois disso os pushes na
   `main` passam a publicar; antes, rodam só os testes. Para pausar os deploys sem mexer no
   workflow, é só apagar essa variável.

5. **Runner x86.** O workflow usa `ubuntu-latest`. Os testes exigem x86 porque o
   `mongodb-memory-server` baixa um `mongod` sem binário s390x/arm. Se o github.ibm.com
   só tiver runners **self-hosted**, troque `runs-on: ubuntu-latest` pelo label deles
   (ex.: `[self-hosted, linux, x64]`) nos três jobs — e confirme que esse runner
   **consegue SSH até `148.100.74.249:22`**. As faixas de IP do runner precisam alcançar a
   porta 22 (que o firewall deixa aberta).

## Cloudflare e firewall — como o tráfego chega

O Cloudflare está em **modo proxy** (a origem fica escondida) com **SSL/TLS Full (strict)**.
Entre o Cloudflare e o servidor, o TLS usa um **Cloudflare Origin Certificate** wildcard
(`*.linuxone.com.br`, 15 anos) cuja chave privada foi gerada no servidor e nunca saiu de
lá (`/etc/pki/nginx/zcd-origin.{crt,key}`).

O **firewall (`firewalld`) só aceita 80/443 das faixas de IP do Cloudflare** (ipsets
`cloudflare4`/`cloudflare6` + rich rules na zona `public`); a 22 fica aberta para o SSH.
Consequência: **bater direto no IP `148.100.74.249` ou no `nip.io` não responde mais** —
o acesso é só pelos domínios, via Cloudflare. Isso, com o `bindIp 127.0.0.1` do Mongo e o
`rpcbind` desligado, fecha a superfície que estava exposta.

Se as faixas do Cloudflare mudarem (raro), reatualize os ipsets a partir de
`https://www.cloudflare.com/ips-v4` e `.../ips-v6` e dê `firewall-cmd --reload`.

> Ao mexer no firewall pelo SSH, arme antes um "dead-man switch" para não se trancar
> para fora: `sudo systemd-run --on-active=600 --unit=fw-deadman systemctl stop firewalld`
> desliga o firewall em 10 min se algo der errado; cancele com
> `sudo systemctl stop fw-deadman.timer` quando confirmar que o acesso continua.

## Por que no mesmo servidor do banco

O GitHub Pages não roda a aplicação (é estático, não executa Node, e o navegador não
fala o protocolo do MongoDB). Pôr a aplicação ao lado do banco resolveu três coisas de
uma vez:

- o banco passou a ser alcançado por `127.0.0.1`, o que permitiu **tirar a porta 27017
  da internet** — antes ela estava aberta ao mundo, com apenas a senha protegendo;
- front e API no mesmo domínio, sem conteúdo misto e sem cookie *cross-site*;
- os 52 MB de SCRTs e PDFs ficam do lado de quem os serve.

## O servidor

| | |
|---|---|
| Endereço | `148.100.74.249` · hostname `zcontroldesk` |
| Sistema | Red Hat Enterprise Linux 9.8, **s390x** (IBM LinuxONE) |
| Recursos | 4 vCPU · 15 GB RAM · 100 GB (96 GB livres) |
| Acesso | `ssh -i "…/zDesk.pem" linux1@148.100.74.249` — `linux1` tem sudo sem senha |
| Node | v22.23.1 do AppStream (`nodejs:22`), já instalado antes do deploy |
| MongoDB | 8.0.28 Enterprise, `mongod.service`, **`bindIp: 127.0.0.1`** |
| SELinux | **Enforcing** |
| nginx | 1.20.1 do AppStream |

## O que foi instalado

```
/opt/zcontroldesk/            código (git archive do HEAD) + node_modules
/var/lib/zcontroldesk/        dados que sobrevivem a redeploy — dono zcd
    scrt-files/               SCRTs originais
    contract-files/           PDFs de contrato
    logs/                     app-AAAA-MM-DD.log
/etc/zcontroldesk.env         ambiente, 0600 root:root
/etc/systemd/system/zcontroldesk.service
/etc/nginx/conf.d/zcontroldesk.conf
```

Código e dados ficam **em árvores separadas** de propósito: assim um redeploy pode
substituir `/opt/zcontroldesk` inteiro sem nunca encostar em arquivo de cliente.

**Usuário de serviço `zcd`** (system, `/sbin/nologin`), sem sudo. O código é do `linux1`
e apenas legível pelo `zcd` — o serviço não consegue reescrever o próprio código.

**Usuário de banco `zcd_app`**, com `readWrite` só em `tfpsystem`. A credencial `admin`
não é usada pela aplicação; ela só aparece no túnel de sincronização.

## Duas decisões que custaram depuração

**A porta é 8008, não 3000.** Com SELinux Enforcing o nginx roda em `httpd_t` e o
controle é pelo **tipo da porta de destino** — loopback não é isento. Neste RHEL o
`http_port_t` cobre `80, 81, 443, 488, 8008, 8009, 8443, 9000`; a 3000 é `ntop_port_t`
e a **8080 não está na lista**, ao contrário do que a intuição sugere.

E o rótulo sozinho não basta: o `httpd_t` só conecta em `http_port_t` com o boolean
`httpd_can_network_relay` ligado — que é o que está ligado aqui:

```bash
sudo setsebool -P httpd_can_network_relay 1
```

Use esse, e **não** o `httpd_can_network_connect` que aparece em todo tutorial: o
`_relay` permite portas de HTTP/proxy e nada mais, enquanto o `_connect` libera o nginx
para conectar em qualquer lugar da rede. Aqui o `_connect` está desligado.

O errno no `/var/log/nginx/zcontroldesk.error.log` diz qual é o problema:
`13 Permission denied` é SELinux; `111 Connection refused` é a aplicação caída ou
noutra porta.

**O TLS não é opcional.** Com `NODE_ENV=production` o cookie de sessão sai com `Secure`
(`src/auth.js`), e o navegador **descarta** um cookie `Secure` recebido por HTTP — o
login falharia sem mensagem nenhuma. Sem `NODE_ENV=production`, a sessão trafegaria em
texto claro. Não há meio-termo.

Como só existe o IP e nenhum DNS, o certificado é do Let's Encrypt para
`148.100.74.249.nip.io` — o nip.io resolve qualquer `<ip>.nip.io` para o próprio IP.
Certificado válido, sem aviso no navegador, renovação automática pelo timer do certbot.
No dia em que houver um CNAME da IBM, basta reemitir para o nome novo.

## Dia a dia

**Ver o que está acontecendo**

```bash
ssh -i "$HOME/Documents/Projetos/zControlDesk BackendMarista/zDesk.pem" linux1@148.100.74.249
```

```bash
sudo journalctl -u zcontroldesk -f
```

**Publicar uma versão nova** — do Mac, a partir do commit atual:

```bash
git archive --format=tar HEAD -- . ':!docs' ':!test' | ssh -i "$HOME/Documents/Projetos/zControlDesk BackendMarista/zDesk.pem" linux1@148.100.74.249 'tar -x -C /opt/zcontroldesk'
```

```bash
ssh -i "$HOME/Documents/Projetos/zControlDesk BackendMarista/zDesk.pem" linux1@148.100.74.249 'cd /opt/zcontroldesk && MONGOMS_DISABLE_POSTINSTALL=1 npm ci --omit=dev && sudo systemctl restart zcontroldesk && sleep 5 && systemctl is-active zcontroldesk'
```

O `MONGOMS_DISABLE_POSTINSTALL=1` **não é opcional**: o `mongodb-memory-server` está em
`dependencies` e seu postinstall tenta baixar um binário do `mongod` que **não existe
para s390x** (a MongoDB só publica s390x no Enterprise). Em produção o pacote nunca é
carregado — o `require` é lazy dentro de `startLocalMongo`, e com `MONGODB_URI` definido
essa função não roda.

Use `git archive`, não `rsync` da árvore de trabalho: o rsync **não lê o `.gitignore`** e
levaria junto as planilhas de cliente e a pasta `SCRT/` que existem localmente.

**Sincronizar a cópia local do banco.** Como o mongod só escuta em `127.0.0.1`, o
`db:pull` precisa do túnel:

```bash
./scripts/tunel-db.sh
```

E, noutro terminal:

```bash
npm run db:pull -- --yes
```

⚠️ **Nunca rode `db:push` depois deste deploy.** O sentido normal inverteu: o servidor é
quem recebe os uploads agora, e o `db:push` substituiria os dados dele pela cópia do Mac,
que estará velha.

**Backup.** O primeiro, feito antes do deploy, está em
`/home/linux1/backups/20260728-140957` (5,2 MB, 3208 documentos). Para um novo, use
`mongodump` com `--config` (um arquivo 0600 contendo `password:`) em vez de `-p` na linha
de comando, que ficaria visível no `ps`.

## Réplica do banco no Atlas (DR)

Para não perder os dados se a máquina morrer, o banco `tfpsystem` é **espelhado de hora em
hora** para um cluster **MongoDB Atlas** (destino off-site, fora do LinuxONE). Não é um
secundário ao vivo — o Atlas gerenciado não entra num replica set on-prem —, é uma **cópia
agendada**: `mongodump` da produção → `mongorestore --drop` no Atlas. RPO de ~1 hora.

| | |
|---|---|
| Timer | `zcd-atlas-backup.timer` — `OnCalendar=hourly`, `Persistent=true` |
| Serviço | `zcd-atlas-backup.service` (oneshot) → `/usr/local/sbin/zcd-atlas-backup` |
| Credencial | `/etc/zcontroldesk-atlas.conf` (0600 root) — `uri: "..."` do Atlas, **sem senha em argv** |
| Alcance | **só o banco** (~5 MB). Os arquivos binários **não** entram (ver abaixo) |

Duas armadilhas que custaram depuração:

- **A URI do Atlas no `.conf` não pode ter banco no path** (`.../mongodb.net/?...`, não
  `.../mongodb.net/tfpsystem?...`). Com um banco default o `mongorestore` interpreta como
  `--db`, entra em "modo banco único" e ignora o subdiretório `tfpsystem/` do dump —
  restaura **0 documentos** sem erro óbvio. Sem banco no path, o mapeamento vem do nome da
  pasta do dump.
- **O IP do servidor tem de estar na _IP Access List_ do Atlas** (`148.100.74.249/32`).
  Sem isso o handshake TLS é cortado com `tlsv1 alert internal error` — parece erro de
  TLS, é bloqueio de rede.

Operar:

```bash
sudo systemctl start zcd-atlas-backup.service   # roda o espelho agora
```

```bash
sudo journalctl -u zcd-atlas-backup.service -n 20 --output=cat   # ver o último resultado
```

```bash
sudo systemctl list-timers zcd-atlas-backup.timer   # quando roda de novo
```

> ⚠️ **Falta o destino dos arquivos.** O Atlas guarda só o banco; os ~50 MB de SCRTs e
> PDFs em `/var/lib/zcontroldesk` continuam só no servidor. Um `restore` a partir do Atlas
> traria os metadados (quais relatórios, quais contratos) mas os arquivos apareceriam como
> 404. Falta escolher um destino off-site para eles (IBM COS / S3 / outra máquina) e um
> `rsync`/`rclone` no mesmo timer.

## O que dá errado

| Sintoma | Causa | Correção |
|---|---|---|
| 502 em tudo, log com `(13: Permission denied)` | boolean do SELinux desligado | `sudo setsebool -P httpd_can_network_relay 1` |
| 502 com `(111: Connection refused)` | aplicação caída ou noutra porta | `systemctl status zcontroldesk` e conferir `PORT` no `/etc/zcontroldesk.env` |
| Login não entra, sem erro na tela | acesso por HTTP em vez de HTTPS | usar `https://zcontroldesk.linuxone.com.br` — o cookie `Secure` é descartado em HTTP |
| Site inteiro fora do ar (`error 1016`/`521` no Cloudflare) | firewall barrando o Cloudflare (faixas mudaram?) ou app/nginx caídos | conferir `systemctl status nginx zcontroldesk`; reatualizar os ipsets `cloudflare4/6` |
| `npm ci` falha baixando `mongod` | s390x sem binário community | `MONGOMS_DISABLE_POSTINSTALL=1` |
| Download de SCRT/PDF dá 404 | arquivo não veio junto | os binários vivem em `/var/lib/zcontroldesk`, fora do deploy do código |
| `db:pull` não conecta | túnel fechado | `./scripts/tunel-db.sh` noutro terminal |
| Todo mundo deslogado após restart | `AUTH_SECRET` ausente no ambiente | conferir `/etc/zcontroldesk.env` — sem ele o segredo vira efêmero |
| Dev pede senha do navegador | é o basic-auth do dev (esperado) | usuário `dev`; a senha está no gerenciador |

## Pendências conhecidas

- **Certificado nip.io órfão.** O `148.100.74.249.nip.io` do Let's Encrypt não é mais
  alcançável (o firewall bloqueia o acesso direto), então o `certbot-renew` vai falhar
  para ele a cada tentativa — ruído, não risco. Limpeza opcional:
  `sudo certbot delete --cert-name 148.100.74.249.nip.io` e remover o server block antigo
  em `/etc/nginx/conf.d/zcontroldesk.conf` (deixando os domínios em `zcontroldesk-domains.conf`).
- **`cockpit` liberado no firewall** por padrão do RHEL, mas o serviço não está rodando —
  inofensivo; `firewall-cmd --permanent --zone=public --remove-service=cockpit` limpa.

## Arquivos deste diretório

- `zcontroldesk.service` — o unit instalado. Vale ler os comentários antes de mexer:
  explicam por que `ReadWritePaths` é obrigatório e por que `MemoryDenyWriteExecution`
  mataria o JIT do V8.
- `nginx-domains.conf` — os server blocks de prod e dev atrás do Cloudflare (instalado em
  `/etc/nginx/conf.d/zcontroldesk-domains.conf`). Cabeçalhos de segurança, basic-auth no
  dev, IP real via `CF-Connecting-IP`.
- `nginx-zcontroldesk.conf` — a conf antiga do nip.io (histórica; ver pendência acima).
- `env.exemplo` — modelo do `/etc/zcontroldesk.env`, com placeholders no lugar dos
  segredos.
- `deploy.sh` — publicação `git archive` por ambiente (`dev`/`prod`).
- `refresh-dev.sh` — copia banco + arquivos de prod para dev, de mão única.
- `atlas-backup.sh` — o espelho DR do banco para o Atlas (instalado em
  `/usr/local/sbin/zcd-atlas-backup`). Não contém segredo: a URI do Atlas fica em
  `/etc/zcontroldesk-atlas.conf`, fora do repositório.
- `zcd-atlas-backup.service` / `zcd-atlas-backup.timer` — o oneshot e o gatilho de hora
  em hora do espelho DR.
