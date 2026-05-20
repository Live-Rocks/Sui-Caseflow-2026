#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 5173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function isSuiAddress(address) {
  return /^0x[a-fA-F0-9]{64}$/.test(address);
}

function runTrace({ address, limit, network }) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["scripts/query-sui-address.mjs", address, "--limit", String(limit), "--network", network],
      {
        cwd: root,
        maxBuffer: 12 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`Trace output was not valid JSON: ${parseError.message}`));
        }
      },
    );
  });
}

async function handleApiTrace(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const address = url.searchParams.get("address")?.trim();
  const network = url.searchParams.get("network") || "mainnet";
  const limit = Number(url.searchParams.get("limit") || 10);

  if (!address || !isSuiAddress(address)) {
    sendJson(res, 400, { error: "Enter a valid 32-byte Sui address starting with 0x." });
    return;
  }

  if (!["mainnet", "testnet", "devnet"].includes(network)) {
    sendJson(res, 400, { error: "Network must be mainnet, testnet, or devnet." });
    return;
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    sendJson(res, 400, { error: "Limit must be an integer from 1 to 100." });
    return;
  }

  try {
    const trace = await runTrace({ address, limit, network });
    sendJson(res, 200, trace);
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, normalized);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/trace")) {
    await handleApiTrace(req, res);
    return;
  }

  await serveStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Sui CaseFlow running at http://127.0.0.1:${port}`);
});
