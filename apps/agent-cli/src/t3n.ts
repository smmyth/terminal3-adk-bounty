// Auth + client construction for the Confidential Intake Vault agent.
//
// NOTE: This deliberately dogfoods bug report R1 — it ALWAYS calls
// setEnvironment("testnet") before constructing any client, instead of relying
// on the SDK's silent production default.

import {
  T3nClient,
  TenantClient,
  loadWasmComponent,
  createEthAuthInput,
  eth_get_address,
  metamask_sign,
  setEnvironment,
  getEnvironment,
  getNodeUrl,
  type TenantBaseClient,
} from "@terminal3/t3n-sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface Connection {
  client: T3nClient;
  tenant: TenantClient;
  did: string;
  env: string | undefined;
  nodeUrl: string;
}

/**
 * Minimal zero-dependency .env loader. Reads `KEY=VALUE` lines from the first
 * `.env` found (cwd, then the agent-cli package dir) and populates
 * `process.env` for any key not already set. The key never gets hardcoded in
 * source; `.env` is gitignored. Existing env vars always win.
 */
function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(process.cwd(), ".env"), resolve(here, "..", ".env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    break; // first .env found wins
  }
}

export async function connect(): Promise<Connection> {
  loadDotEnv();

  // Pin testnet first — never inherit the SDK's production default.
  setEnvironment("testnet");

  const privateKey = process.env.T3N_DEV_KEY;
  if (!privateKey) {
    throw new Error(
      "Missing T3N_DEV_KEY. Export your testnet dev key as an env var; never hardcode it."
    );
  }

  const address = eth_get_address(privateKey);
  const wasmComponent = await loadWasmComponent();

  const client = new T3nClient({
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, privateKey) },
  });

  await client.handshake();
  // `authenticate` returns a `Did` ({ value: string; toString() }); the string form is `.value`.
  const did = await client.authenticate(createEthAuthInput(address));

  const nodeUrl = getNodeUrl();

  const tenant = new TenantClient({
    // The authenticated session client backs the tenant control-plane calls.
    t3n: client as unknown as TenantBaseClient,
    environment: "testnet",
    baseUrl: nodeUrl, // required by TenantClient for control-plane ops (me/maps/contracts)
    endpoint: nodeUrl,
    tenantDid: did.value,
    // NOTE: intentionally NOT setting `tenantScriptName` here. It drives
    // business-contract version resolution; setting it makes control-plane
    // ops (me / maps / register) try to fetch the contract version up-front,
    // which 404s before the contract is registered. `contracts.execute`
    // takes the tail explicitly, so it does not need this.
  });

  return {
    client,
    tenant,
    did: did.value,
    env: getEnvironment(),
    nodeUrl,
  };
}
