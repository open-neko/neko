#!/bin/sh
set -eu

: "${OPENNEKO_PGBACKREST_STANZA:?OPENNEKO_PGBACKREST_STANZA is required}"
: "${PGBACKREST_REPO1_CIPHER_PASS:?PGBACKREST_REPO1_CIPHER_PASS is required}"

case "$OPENNEKO_PGBACKREST_STANZA" in
  *[!A-Za-z0-9_-]*)
    echo "invalid pgBackRest stanza name" >&2
    exit 1
    ;;
esac
case "$PGBACKREST_REPO1_CIPHER_PASS" in
  *'
'*)
    echo "pgBackRest cipher passphrase must not contain a newline" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p /etc/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest
chown -R postgres:postgres /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest

cat > /etc/pgbackrest/pgbackrest.conf <<EOF
[$OPENNEKO_PGBACKREST_STANZA]
pg1-path=${PGDATA:-/var/lib/postgresql/data}
pg1-socket-path=/var/run/postgresql
pg1-user=${POSTGRES_USER:-postgres}

[global]
repo1-path=/var/lib/pgbackrest
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$PGBACKREST_REPO1_CIPHER_PASS
repo1-retention-full=${OPENNEKO_BACKUP_RETENTION_FULL:-7}
repo1-retention-diff=${OPENNEKO_BACKUP_RETENTION_DIFF:-4}
archive-async=n
spool-path=/var/spool/pgbackrest
start-fast=y
process-max=${OPENNEKO_BACKUP_PROCESS_MAX:-2}
log-level-console=info

[global:archive-push]
compress-level=3
EOF
chown postgres:postgres /etc/pgbackrest/pgbackrest.conf
chmod 600 /etc/pgbackrest/pgbackrest.conf
chown root:postgres /etc/pgbackrest
chmod 750 /etc/pgbackrest

exec docker-entrypoint.sh "$@"
