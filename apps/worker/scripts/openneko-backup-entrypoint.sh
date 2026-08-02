#!/bin/sh
set -eu

: "${PGBACKREST_REPO1_CIPHER_PASS:?PGBACKREST_REPO1_CIPHER_PASS is required}"
case "$PGBACKREST_REPO1_CIPHER_PASS" in
  *'
'*)
    echo "pgBackRest cipher passphrase must not contain a newline" >&2
    exit 1
    ;;
esac

umask 077
mkdir -p /etc/pgbackrest /var/lib/pgbackrest/openneko/sets \
  /var/spool/pgbackrest /var/log/pgbackrest /run/openneko-backup
chown -R postgres:postgres /var/lib/pgbackrest /var/spool/pgbackrest \
  /var/log/pgbackrest /run/openneko-backup

cat > /etc/pgbackrest/pgbackrest.conf <<EOF
[openneko-metadata]
pg1-path=${OPENNEKO_BACKUP_METADATA_PATH:-/var/lib/postgresql/neko}
pg1-socket-path=${OPENNEKO_BACKUP_METADATA_SOCKET:-/sockets/neko}
pg1-user=${NEKO_PG_USER:-neko}

[openneko-records]
pg1-path=${OPENNEKO_BACKUP_RECORDS_PATH:-/var/lib/postgresql/records}
pg1-socket-path=${OPENNEKO_BACKUP_RECORDS_SOCKET:-/sockets/records}
pg1-user=${RECORDS_PG_USER:-records}

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
EOF
chown postgres:postgres /etc/pgbackrest/pgbackrest.conf
chmod 600 /etc/pgbackrest/pgbackrest.conf
chown root:postgres /etc/pgbackrest
chmod 750 /etc/pgbackrest

exec python3 /usr/local/bin/openneko-backup.py "$@"
