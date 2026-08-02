import { statfs } from "node:fs/promises";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "9465");
const volumes = {
  metadata: process.env.OPENNEKO_METADATA_VOLUME_PATH ?? "/volumes/metadata",
  records: process.env.OPENNEKO_RECORDS_VOLUME_PATH ?? "/volumes/records",
  staging: process.env.OPENNEKO_STAGING_VOLUME_PATH ?? "/volumes/staging",
};

function safeNumber(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} exceeds the supported capacity range`);
  }
  return result;
}

async function capacity(path) {
  const value = await statfs(path, { bigint: true });
  const totalBytes = safeNumber(value.blocks * value.bsize, `${path} total bytes`);
  const freeBytes = safeNumber(value.bavail * value.bsize, `${path} free bytes`);
  if (totalBytes === 0 || freeBytes > totalBytes) {
    throw new Error(`${path} returned an invalid capacity sample`);
  }
  return {
    totalBytes,
    freeBytes,
    usedPercent: ((totalBytes - freeBytes) / totalBytes) * 100,
  };
}

async function sample() {
  const [metadata, records, staging] = await Promise.all([
    capacity(volumes.metadata),
    capacity(volumes.records),
    capacity(volumes.staging),
  ]);
  return {
    sampledAt: new Date().toISOString(),
    metadata,
    records,
    staging,
  };
}

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    send(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    if (request.url === "/health") {
      await sample();
      send(response, 200, { status: "ok" });
      return;
    }
    if (request.url === "/v1/storage") {
      send(response, 200, await sample());
      return;
    }
    send(response, 404, { error: "not_found" });
  } catch (error) {
    send(response, 503, {
      error: "storage_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[records-storage-ops] listening on ${port}`);
});

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
