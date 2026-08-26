#!/usr/bin/env bash
set -euo pipefail

recovery_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
recovery_workspace="$(mktemp -d -t openneko-records-recovery.XXXXXX)"
recovery_project="${OPENNEKO_RECOVERY_PROJECT:-openneko-records-recovery-${GITHUB_RUN_ID:-local}-$$}"
recovery_metadata_port="${OPENNEKO_RECOVERY_METADATA_PORT:-55432}"
recovery_records_port="${OPENNEKO_RECOVERY_RECORDS_PORT:-55434}"
recovery_disk_container="${recovery_project}-disk-pressure"
recovery_storage_image="${recovery_project}-neko-backup"

export OPENNEKO_BACKUP_CIPHER_PASS="recovery-test-key-with-more-than-thirty-two-characters"
export OPENNEKO_BACKUP_REPOSITORY="$recovery_workspace/backups"
export OPENNEKO_HOST_CONFIG_DIR="$recovery_workspace/host-config"
export OPENNEKO_DB_PORT="$recovery_metadata_port"
export OPENNEKO_RECORDS_DB_PORT="$recovery_records_port"
# The db/backup entrypoints read the cipher pass from a mounted key file
# (compose.yml defaults it to ./.openneko/development-backup-key, which
# `openneko start` provisions but a bare CI checkout does not have —
# Docker would mount an empty directory and the entrypoints die on cat).
export OPENNEKO_BACKUP_KEY_FILE="$recovery_workspace/backup-key"
printf '%s' "$OPENNEKO_BACKUP_CIPHER_PASS" > "$OPENNEKO_BACKUP_KEY_FILE"
chmod 0600 "$OPENNEKO_BACKUP_KEY_FILE"
mkdir -p "$OPENNEKO_BACKUP_REPOSITORY" "$OPENNEKO_HOST_CONFIG_DIR"

recovery_compose=(
  docker compose
  -p "$recovery_project"
  -f "$recovery_repo_root/compose.yml"
)

cleanup() {
  local recovery_status=$?
  trap - EXIT
  set +e
  docker rm -f "$recovery_disk_container" >/dev/null 2>&1 || true
  "${recovery_compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ -d "$recovery_workspace" && "$(basename "$recovery_workspace")" == openneko-records-recovery.* ]]; then
    if docker image inspect "$recovery_storage_image" >/dev/null 2>&1; then
      docker run --rm --user 0:0 --entrypoint sh \
        -v "$recovery_workspace:/cleanup" \
        "$recovery_storage_image" \
        -c 'find /cleanup -mindepth 1 -delete' >/dev/null 2>&1
    fi
    rm -rf -- "$recovery_workspace"
  fi
  exit "$recovery_status"
}
trap cleanup EXIT

backup_status() {
  "${recovery_compose[@]}" exec -T neko-backup \
    curl -fsS http://127.0.0.1:9470/v1/backups/status
}

echo "Starting isolated records recovery stack ($recovery_project)..."
"${recovery_compose[@]}" up -d --build --wait --wait-timeout 180 \
  neko-backup

# The coordinator reads both read-only PGDATA mounts as postgres. Assert the
# shared numeric owner directly so a future base-image split fails with the
# storage-contract violation, before pgBackRest reports an indirect EACCES.
database_owner="$("${recovery_compose[@]}" exec -T records-db sh -ceu \
  'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"')"
backup_owner="$("${recovery_compose[@]}" exec -T neko-backup sh -ceu \
  'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"')"
if [[ "$database_owner" != "999:999" || "$backup_owner" != "$database_owner" ]]; then
  echo "PostgreSQL storage owner mismatch: database=$database_owner backup=$backup_owner" >&2
  exit 1
fi

backup_ready=0
for _ in $(seq 1 90); do
  recovery_backup_json="$(backup_status)"
  case "$recovery_backup_json" in
    *'"state": "ready"'*)
      backup_ready=1
      break
      ;;
    *'"state": "failed"'*)
      echo "$recovery_backup_json" >&2
      echo "Initial whole-deployment backup failed" >&2
      exit 1
      ;;
  esac
  sleep 2
done
if [[ "$backup_ready" != "1" ]]; then
  echo "Initial whole-deployment backup did not become ready" >&2
  exit 1
fi

echo "Seeding the representative Salesforce restore fixture..."
"${recovery_compose[@]}" exec -T records-db psql \
  -U records -d records -v ON_ERROR_STOP=1 \
  < "$recovery_repo_root/packages/records/test/fixtures/salesforce-golden-restore.sql"

echo "Creating and verifying a backup set with every recovery volume..."
# No curl -f here: on failure the daemon's JSON body carries the actual
# error (backup_operation_failed + message), which -f would discard.
recovery_manifest="$("${recovery_compose[@]}" exec -T neko-backup \
  curl -sS -X POST http://127.0.0.1:9470/v1/backups/now)"
if [[ "$recovery_manifest" == *'"error"'* || "$recovery_manifest" != *'"set_id"'* ]]; then
  echo "Backup creation failed: $recovery_manifest" >&2
  echo "--- neko-backup logs ---" >&2
  "${recovery_compose[@]}" logs --no-color --tail 100 neko-backup >&2 || true
  exit 1
fi
for required in \
  '"openneko-metadata"' \
  '"openneko-records"' \
  '"config"' \
  '"records-graphjin"' \
  '"host-config"' \
  '"plugins"'; do
  if [[ "$recovery_manifest" != *"$required"* ]]; then
    echo "Backup manifest omitted $required" >&2
    exit 1
  fi
done
recovery_verification="$("${recovery_compose[@]}" exec -T neko-backup \
  curl -sS -X POST http://127.0.0.1:9470/v1/backups/verify)"
if [[ "$recovery_verification" != *'"status": "succeeded"'* ]] || \
   [[ "$recovery_verification" != *'"decrypted_and_checksum_verified"'* ]]; then
  echo "$recovery_verification" >&2
  echo "Throwaway restore verification did not prove the backup set" >&2
  exit 1
fi
python3 -c '
import json, re, sys
report = json.loads(sys.argv[1])
records = next(item for item in report["databases"] if item["stanza"] == "openneko-records")
probe = records["probe"]
golden = probe["golden_fixture"]
assert (golden["rows"], golden["accepted"], golden["rejected"]) == (24, 22, 2)
assert golden["sample"]["rows_sampled"] == 24
assert re.fullmatch(r"[0-9a-f]{64}", golden["sample"]["sha256"])
integrity = probe.get("record_change_sample") or golden["sample"]
assert re.fullmatch(r"[0-9a-f]{64}", integrity["sha256"])
' "$recovery_verification"

echo "Filling a small observed filesystem to ENOSPC and recovering it..."
docker run -d --name "$recovery_disk_container" \
  -e PGBACKREST_REPO1_CIPHER_PASS="$OPENNEKO_BACKUP_CIPHER_PASS" \
  --tmpfs /var/lib/postgresql/neko:rw,size=32m \
  --tmpfs /var/lib/postgresql/records:rw,size=32m \
  --tmpfs /volumes/staging:rw,size=32m \
  "$recovery_storage_image" >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$recovery_disk_container" \
    curl -fsS http://127.0.0.1:9470/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
recovery_storage_before="$(docker exec "$recovery_disk_container" \
  curl -fsS http://127.0.0.1:9470/v1/storage)"
python3 -c 'import json,sys; value=json.loads(sys.argv[1]); assert value["records"]["usedPercent"] < 10' \
  "$recovery_storage_before"
if docker exec "$recovery_disk_container" sh -c \
  'dd if=/dev/zero of=/var/lib/postgresql/records/fill bs=1M count=64 conv=fsync' \
  >"$recovery_workspace/enospc.log" 2>&1; then
  echo "Expected the small records filesystem to reach ENOSPC" >&2
  exit 1
fi
recovery_storage_full="$(docker exec "$recovery_disk_container" \
  curl -fsS http://127.0.0.1:9470/v1/storage)"
python3 -c 'import json,sys; value=json.loads(sys.argv[1]); assert value["records"]["usedPercent"] >= 99' \
  "$recovery_storage_full"
if docker exec "$recovery_disk_container" sh -c \
  'printf blocked > /var/lib/postgresql/records/blocked'; then
  echo "A records write unexpectedly succeeded at ENOSPC" >&2
  exit 1
fi
docker exec "$recovery_disk_container" rm -f \
  /var/lib/postgresql/records/fill /var/lib/postgresql/records/blocked
docker exec "$recovery_disk_container" sh -c \
  'printf recovered > /var/lib/postgresql/records/recovered'
recovery_storage_recovered="$(docker exec "$recovery_disk_container" \
  curl -fsS http://127.0.0.1:9470/v1/storage)"
python3 -c 'import json,sys; value=json.loads(sys.argv[1]); assert value["records"]["usedPercent"] < 10' \
  "$recovery_storage_recovered"
docker rm -f "$recovery_disk_container" >/dev/null

echo "Killing records-db inside an open transaction..."
"${recovery_compose[@]}" exec -T records-db psql \
  -U records -d records -v ON_ERROR_STOP=1 \
  -c 'drop table if exists public.openneko_crash_probe; create table public.openneko_crash_probe (id text primary key)'
"${recovery_compose[@]}" exec -T -e PGAPPNAME=openneko-recovery-crash-probe \
  records-db psql -U records -d records -v ON_ERROR_STOP=1 \
  -c "begin; insert into public.openneko_crash_probe values ('uncommitted'); select pg_sleep(60); commit" \
  >"$recovery_workspace/crash-client.log" 2>&1 &
recovery_client_pid=$!

transaction_seen=0
for _ in $(seq 1 40); do
  recovery_active="$("${recovery_compose[@]}" exec -T records-db psql \
    -U records -d records -Atq \
    -c "select count(*) from pg_stat_activity where application_name = 'openneko-recovery-crash-probe' and state = 'active'")"
  if [[ "$recovery_active" == "1" ]]; then
    transaction_seen=1
    break
  fi
  sleep 0.25
done
if [[ "$transaction_seen" != "1" ]]; then
  echo "Crash probe never entered its open transaction" >&2
  exit 1
fi

"${recovery_compose[@]}" kill -s SIGKILL records-db
wait "$recovery_client_pid" || true
"${recovery_compose[@]}" up -d --wait --wait-timeout 90 records-db

recovery_rolled_back="$("${recovery_compose[@]}" exec -T records-db psql \
  -U records -d records -Atq \
  -c 'select count(*) from public.openneko_crash_probe')"
if [[ "$recovery_rolled_back" != "0" ]]; then
  echo "Uncommitted record survived database crash" >&2
  exit 1
fi
"${recovery_compose[@]}" exec -T records-db psql \
  -U records -d records -v ON_ERROR_STOP=1 \
  -c "insert into public.openneko_crash_probe values ('committed')"
recovery_committed="$("${recovery_compose[@]}" exec -T records-db psql \
  -U records -d records -Atq \
  -c 'select count(*) from public.openneko_crash_probe')"
if [[ "$recovery_committed" != "1" ]]; then
  echo "Post-recovery records write did not commit" >&2
  exit 1
fi
"${recovery_compose[@]}" exec -T records-db psql \
  -U records -d records -v ON_ERROR_STOP=1 \
  -c 'drop table public.openneko_crash_probe'
"${recovery_compose[@]}" exec -T neko-backup sh -ec '
  unset PGBACKREST_REPO1_CIPHER_PASS_FILE
  if command -v gosu >/dev/null 2>&1; then
    exec gosu postgres "$@"
  fi
  exec su-exec postgres "$@"
' openneko-run-as-postgres pgbackrest \
  --log-level-console=warn --stanza=openneko-records check

echo "Records backup verification and database crash recovery passed."
