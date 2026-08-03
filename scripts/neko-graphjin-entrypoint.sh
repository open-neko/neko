#!/bin/sh
# Metadata GraphJin supervisor. It decrypts the setup-managed Postgres
# password, writes the generated config atomically, and refreshes it whenever
# the shared local config changes. GraphJin's reload_on_config_change then
# reconnects without an operator-only container restart.
set -eu

config_json=/openneko-config/config.json
secret_key=/openneko-config/secret-key
seed=/seed/neko.yml
generated=/config/dev.yml

template_config() {
  node - "$config_json" "$secret_key" "$seed" "$generated" <<'JS'
const crypto = require("crypto");
const fs = require("fs");

const [configPath, keyPath, seedPath, generatedPath] = process.argv.slice(2);
let password = process.env.NEKO_PG_PASSWORD || "secret";
let source = "NEKO_PG_PASSWORD env";

function decrypt(value) {
  if (!value.startsWith("enc:v1:")) return value;
  const secret = fs.readFileSync(keyPath, "utf8").trim();
  if (!secret) throw new Error("secret-key is empty");
  const key = crypto.createHash("sha256").update(secret).digest();
  const raw = Buffer.from(value.slice("enc:v1:".length), "base64");
  if (raw.length < 28) throw new Error("enc:v1 value is too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (cfg && cfg.pg && typeof cfg.pg.password === "string" && cfg.pg.password.length > 0) {
    password = decrypt(cfg.pg.password);
    source = "config.json";
  }
} catch (error) {
  if (fs.existsSync(configPath)) throw error;
  console.warn(`[neko-graphjin] config.json missing; using ${source}`);
}

const seedYaml = fs.readFileSync(seedPath, "utf8");
const templated = seedYaml.replace(
  /^(\s*)password:.*$/m,
  `$1password: ${JSON.stringify(password)}`,
);
fs.mkdirSync(require("path").dirname(generatedPath), { recursive: true });
const temporary = `${generatedPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, templated, { mode: 0o600, flag: "wx" });
fs.renameSync(temporary, generatedPath);
fs.chmodSync(generatedPath, 0o600);
console.log(`[neko-graphjin] templated ${generatedPath} from ${source}`);
JS
}

source_generation() {
  cksum "$config_json" "$secret_key" "$seed" 2>/dev/null || cksum "$seed"
}

mkdir -p /config
template_config

watch_config() {
  generation=$(source_generation)
  while :; do
    next_generation=$(source_generation)
    if [ "$generation" != "$next_generation" ]; then
      if template_config; then
        generation=$next_generation
      else
        echo "[neko-graphjin] refusing invalid credential refresh; retaining the last valid config" >&2
      fi
    fi
    sleep 1
  done
}

watch_config &
watch_pid=$!

shutdown() {
  kill -TERM "$watch_pid" 2>/dev/null || true
  if [ -n "${graphjin_pid:-}" ]; then
    kill -TERM "$graphjin_pid" 2>/dev/null || true
  fi
}
trap shutdown INT TERM

graphjin "$@" &
graphjin_pid=$!
set +e
wait "$graphjin_pid"
status=$?
set -e
kill -TERM "$watch_pid" 2>/dev/null || true
wait "$watch_pid" 2>/dev/null || true
exit "$status"
