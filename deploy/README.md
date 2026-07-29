# Deploy — IBM Z Control Desk

A aplicação está no ar em **<https://148.100.74.249.nip.io>**, no mesmo LinuxONE que
roda o MongoDB. Este documento descreve **o que está instalado de verdade** e como
operar no dia a dia. Não é um plano: é o registro da instalação.

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

## O que dá errado

| Sintoma | Causa | Correção |
|---|---|---|
| 502 em tudo, log com `(13: Permission denied)` | boolean do SELinux desligado | `sudo setsebool -P httpd_can_network_relay 1` |
| 502 com `(111: Connection refused)` | aplicação caída ou noutra porta | `systemctl status zcontroldesk` e conferir `PORT` no `/etc/zcontroldesk.env` |
| Login não entra, sem erro na tela | acesso por HTTP em vez de HTTPS | usar `https://148.100.74.249.nip.io` — o cookie `Secure` é descartado em HTTP |
| `npm ci` falha baixando `mongod` | s390x sem binário community | `MONGOMS_DISABLE_POSTINSTALL=1` |
| Download de SCRT/PDF dá 404 | arquivo não veio junto | os binários vivem em `/var/lib/zcontroldesk`, fora do deploy do código |
| `db:pull` não conecta | túnel fechado | `./scripts/tunel-db.sh` noutro terminal |
| Todo mundo deslogado após restart | `AUTH_SECRET` ausente no ambiente | conferir `/etc/zcontroldesk.env` — sem ele o segredo vira efêmero |
| Certificado expirado | timer do certbot parado | `systemctl status certbot-renew.timer` |

## Pendências conhecidas

- **Sem firewall.** `firewalld` não está instalado e o `iptables` tem política `ACCEPT`
  sem regras. Hoje só 22, 80 e 443 escutam em interface pública, então a superfície é
  pequena — mas nada impede que um serviço futuro suba em `0.0.0.0` sem ninguém notar.

## Arquivos deste diretório

- `zcontroldesk.service` — o unit instalado. Vale ler os comentários antes de mexer:
  explicam por que `ReadWritePaths` é obrigatório e por que `MemoryDenyWriteExecution`
  mataria o JIT do V8.
- `nginx-zcontroldesk.conf` — a conf do proxy **antes** do certbot. O bloco 443 no
  servidor foi escrito pelo `certbot --nginx`.
- `env.exemplo` — modelo do `/etc/zcontroldesk.env`, com placeholders no lugar dos
  segredos.
- `deploy.sh` — publicação por rsync, alternativa ao `git archive` acima.
