#!/bin/sh
# Fail-closed bootstrap for the generated-app GraphJin data plane. The records
# worker owns the complete config and writes it atomically before starting this
# service; serving a partial/default config would create a new-table exposure
# window because explicit role-table rules are permissive when omitted.
set -eu

config_dir=${OPENNEKO_RECORDS_GRAPHJIN_CONFIG_DIR:-/config}
config_file="$config_dir/dev.yml"

if [ ! -s "$config_file" ]; then
  echo "[records-graphjin] refusing to start: generated config missing at $config_file" >&2
  exit 78
fi

exec graphjin "$@"
