#!/bin/sh
# Fail-closed supervisor for the generated-app GraphJin data plane. The worker
# owns the complete config plus a shared-volume serving state. A stopped state
# terminates GraphJin before schema work; ready starts it only from the current
# exhaustive config. This avoids a new-table exposure window during reloads.
set -eu

config_dir=${OPENNEKO_RECORDS_GRAPHJIN_CONFIG_DIR:-/config}
config_file="$config_dir/dev.yml"
control_file="$config_dir/.records-graphjin-control"
reload_file="$config_dir/.records-graphjin-reload"
child_pid=""
generation=""

requested_state() {
  if [ ! -s "$control_file" ]; then
    echo stopped
    return
  fi
  sed -n '1p' "$control_file"
}

current_generation() {
  if [ ! -s "$config_file" ]; then
    echo missing
    return
  fi
  cksum "$config_file" "$reload_file" 2>/dev/null || cksum "$config_file"
}

start_graphjin() {
  if [ ! -s "$config_file" ]; then
    return
  fi
  echo "[records-graphjin] starting from generated exhaustive config"
  graphjin "$@" &
  child_pid=$!
  generation=$(current_generation)
}

stop_graphjin() {
  if [ -z "$child_pid" ]; then
    return
  fi
  if kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  child_pid=""
}

shutdown() {
  stop_graphjin
  exit 0
}

trap shutdown INT TERM

while :; do
  state=$(requested_state)
  if [ "$state" != ready ]; then
    stop_graphjin
    sleep 1
    continue
  fi

  next_generation=$(current_generation)
  if [ "$next_generation" = missing ]; then
    stop_graphjin
    sleep 1
    continue
  fi

  if [ -z "$child_pid" ]; then
    start_graphjin "$@"
  elif ! kill -0 "$child_pid" 2>/dev/null; then
    wait "$child_pid" 2>/dev/null || true
    child_pid=""
    echo "[records-graphjin] child exited; supervisor will restart it" >&2
  elif [ "$generation" != "$next_generation" ]; then
    echo "[records-graphjin] generated config changed; restarting"
    stop_graphjin
    start_graphjin "$@"
  fi

  sleep 1
done
