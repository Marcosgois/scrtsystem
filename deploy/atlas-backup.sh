#!/usr/bin/env bash
# DR do zControl Desk: espelha o banco `tfpsystem` de produção -> MongoDB Atlas.
#
# Instalado no servidor como /usr/local/sbin/zcd-atlas-backup (0700 root) e disparado
# de hora em hora pelo zcd-atlas-backup.timer. Só o BANCO entra aqui; os arquivos
# binários (SCRT/PDF em /var/lib/zcontroldesk) NÃO cabem no Atlas M0 e precisam de
# destino próprio (ver deploy/README.md).
#
# A string do Atlas fica em /etc/zcontroldesk-atlas.conf (0600 root), no formato de
# config dos mongo-tools:  uri: "mongodb+srv://usuario:senha@host/?retryWrites=true&w=majority"
# — SEM banco no path, senão o mongorestore entra em "modo banco único" e ignora o dump.
# Passar por --config mantém a senha fora do `ps`/argv.
set -euo pipefail

# lock: não deixa duas execuções se atropelarem
exec 9>/run/zcd-atlas-backup.lock
flock -n 9 || { echo "já em execução, saindo"; exit 0; }

PROD_URI=$(sed -n 's/^MONGODB_URI=//p' /etc/zcontroldesk.env | head -1)
[ -n "$PROD_URI" ] || { echo "ERRO: sem MONGODB_URI em /etc/zcontroldesk.env"; exit 1; }
[ -r /etc/zcontroldesk-atlas.conf ] || { echo "ERRO: /etc/zcontroldesk-atlas.conf ausente"; exit 1; }

D=$(mktemp -d /var/tmp/zcd-dr.XXXXXX)
trap 'rm -rf "$D"' EXIT

echo "dump tfpsystem (prod)..."
mongodump --uri="$PROD_URI" --out "$D" --gzip --quiet

echo "restore --drop no Atlas..."
mongorestore --config=/etc/zcontroldesk-atlas.conf --gzip --drop "$D" 2>&1 | tail -n 2

echo "espelho concluído."
