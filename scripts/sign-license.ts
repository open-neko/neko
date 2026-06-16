// Mint or verify-key offline OpenNeko license tokens.
//   node --experimental-strip-types scripts/sign-license.ts genkey
//     → PRIVATE key to stdout, PUBLIC key to stderr (embed the public key)
//   node --experimental-strip-types scripts/sign-license.ts \
//     --key private.pem --customer Acme --features sso,audit_chain --days 365
//     → signed token to stdout (set as OPENNEKO_LICENSE on the deployment)
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { signLicense } from "../packages/db/src/license.ts";

const argv = process.argv.slice(2);

if (argv[0] === "genkey") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  console.log(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  console.error(publicKey.export({ type: "spki", format: "pem" }).toString());
  process.exit(0);
}

const args = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) {
  args.set(argv[i]?.replace(/^--/, ""), argv[i + 1]);
}
const key = args.get("key");
const customer = args.get("customer");
const features = (args.get("features") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const days = Number(args.get("days") ?? "365");

if (!key || !customer || features.length === 0) {
  console.error(
    "usage: --key <private.pem> --customer <name> --features a,b,c [--days 365]\n   or: genkey",
  );
  process.exit(1);
}

const exp = Math.floor(Date.now() / 1000) + days * 86400;
console.log(signLicense({ customer, features, exp }, readFileSync(key, "utf8")));
