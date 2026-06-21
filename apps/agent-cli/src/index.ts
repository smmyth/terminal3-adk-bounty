#!/usr/bin/env -S npx tsx
// Confidential Intake Vault — agent CLI.
//
// Drives the intake-vault TEE contract end to end over @terminal3/t3n-sdk:
//   auth -> me -> init-maps -> register -> submit -> score -> summary -> logs -> usage
//
// Every command pins testnet (see ./t3n.ts) and reads the dev key from
// T3N_DEV_KEY. Raw submissions go to the private `reports` map inside the
// enclave; only redacted summaries + scores ever come back.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { connect, type Connection } from "./t3n";
import { mintGrant } from "./grant";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = resolve(
  HERE,
  "../../../contracts/intake-vault/target/wasm32-wasip2/release/intake_vault.wasm"
);
const CONTRACT_TAIL = "intake-vault";
const CONTRACT_VERSION = "0.1.0";

function out(label: string, value: unknown): void {
  console.log(`\n${label}:`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function run(fn: (c: Connection) => Promise<void>): Promise<void> {
  const c = await connect();
  out("connected", { did: c.did, env: c.env, nodeUrl: c.nodeUrl });
  await fn(c);
}

function parseJsonArg(arg: string | undefined, what: string): Record<string, unknown> {
  if (!arg) throw new Error(`Expected a JSON ${what} argument (inline JSON or @path/to/file.json).`);
  return JSON.parse(arg) as Record<string, unknown>;
}

// Read a JSON payload from either inline JSON or, when the arg starts with '@',
// a file path. The '@file' form avoids shell-quoting issues with inline JSON.
async function readJsonArg(arg: string | undefined, what: string): Promise<Record<string, unknown>> {
  if (arg && arg.startsWith("@")) {
    const text = await readFile(resolve(arg.slice(1)), "utf8");
    return JSON.parse(text) as Record<string, unknown>;
  }
  return parseJsonArg(arg, what);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "auth":
      await run(async () => {});
      break;

    case "me":
      await run(async ({ tenant }) => out("tenant.me", await tenant.tenant.me()));
      break;

    case "init-maps":
      // Lock map ACLs to the registered contract id so ONLY the intake-vault
      // contract can touch them. The tenant runtime enforces map writers/readers
      // against the contract's identity (`TenantContract(<tenant>/<id>)`), so the
      // id must be known first — run `register` and pass the printed contract_id:
      //   intake init-maps <contractId>
      // Without an id the maps are created locked to nobody (safe but the
      // contract cannot use them until you re-run with the id).
      await run(async ({ tenant }) => {
        const contractId = args[0] ? Number(args[0]) : undefined;
        if (args[0] && !Number.isInteger(contractId)) {
          throw new Error("init-maps: contractId must be an integer (see `register` output)");
        }
        const onlyContract = contractId !== undefined ? { only: [contractId] } : { only: [] };

        // Create the map, or update it in place if it already exists.
        const createOrUpdate = async (
          tail: string,
          spec: { visibility: string; writers: { only: number[] }; readers: { only: number[] } | "all" }
        ) => {
          try {
            return await tenant.maps.create({ tail, ...spec });
          } catch {
            return await tenant.maps.update(tail, { writers: spec.writers, readers: spec.readers });
          }
        };

        // Private map: raw submissions (may carry PII). Contract-only — only the
        // intake-vault contract id may read OR write it. Locking writers (not
        // just readers) prevents report-poisoning of the "private" map.
        out("maps reports", await createOrUpdate("reports", {
          visibility: "private",
          writers: onlyContract,
          readers: onlyContract,
        }));

        // Public map: redacted summaries + scores — public to read, but only the
        // contract publishes to it.
        out("maps summaries", await createOrUpdate("summaries", {
          visibility: "public",
          writers: onlyContract,
          readers: "all",
        }));
      });
      break;

    case "register":
      await run(async ({ tenant }) => {
        const wasm = new Uint8Array(await readFile(WASM_PATH));
        out("register", await tenant.contracts.register({
          tail: CONTRACT_TAIL,
          version: CONTRACT_VERSION,
          wasm,
        }));
      });
      break;

    case "submit":
      // intake submit '{"id":"r1",...}'   OR   intake submit @report.json
      await run(async ({ tenant }) => {
        const input = await readJsonArg(args[0], "submission");
        out("submit-report", await tenant.contracts.execute(CONTRACT_TAIL, {
          version: CONTRACT_VERSION,
          functionName: "submit-report",
          input,
        }));
      });
      break;

    case "score":
      // intake score r1
      await run(async ({ tenant }) => {
        out("score-report", await tenant.contracts.execute(CONTRACT_TAIL, {
          version: CONTRACT_VERSION,
          functionName: "score-report",
          input: { id: args[0] },
        }));
      });
      break;

    case "summary":
      // intake summary r1
      await run(async ({ tenant }) => {
        out("get-summary", await tenant.contracts.execute(CONTRACT_TAIL, {
          version: CONTRACT_VERSION,
          functionName: "get-summary",
          input: { id: args[0] },
        }));
      });
      break;

    case "logs":
      await run(async ({ tenant }) =>
        out("contract logs", await tenant.contracts.logs(CONTRACT_TAIL, { limit: 50 }))
      );
      break;

    case "usage":
      await run(async ({ tenant }) => out("token.getUsage", await tenant.token.getUsage()));
      break;

    case "grant":
      // Mint a verifiable user→agent delegation credential authorising an agent
      // key to call ONLY intake-vault's functions for a bounded window.
      //   intake grant            (ephemeral agent key, 1h)
      //   intake grant 7200       (ephemeral agent key, 2h)
      // Optionally bind a specific agent key via T3N_AGENT_KEY.
      await run(async ({ did }) => {
        const ttlSecs = args[0] ? Number(args[0]) : undefined;
        if (ttlSecs !== undefined && (!Number.isFinite(ttlSecs) || ttlSecs <= 0)) {
          throw new Error("grant: ttl must be a positive number of seconds");
        }
        const result = mintGrant({
          userDid: did,
          tenantDid: did, // self-tenant: the operator's DID is the tenant DID
          userKeyHex: process.env.T3N_DEV_KEY as string,
          ttlSecs,
          agentKeyHex: process.env.T3N_AGENT_KEY,
        });
        out("agent-auth grant (user-signed delegation credential)", result);
        if (result.agent_secret_hex) {
          out(
            "note",
            "Ephemeral agent key generated for this demo. The agent uses ONLY its " +
              "private key per call; the credential proves the user authorised it. " +
              "Do not reuse this key in production."
          );
        }
      });
      break;

    default:
      console.log(`Confidential Intake Vault — agent CLI

Usage: intake <command> [args]   (requires T3N_DEV_KEY env var)

  auth                 Handshake + authenticate; print DID / env / node URL
  me                   Show tenant status + quotas
  init-maps [id]       Create/lock 'reports' (private) + 'summaries' (public) to the contract id
  register             Publish the built intake_vault.wasm as the 'intake-vault' contract
  submit '<json>'      Submit a report { id, title, body, severity, contact } (or: submit @file.json)
  score <id>           Recompute completeness score for a stored report
  summary <id>         Fetch the redacted public summary for a report
  logs                 Read the contract's in-enclave debug logs
  usage                Show token usage / balance
  grant [ttlSecs]      Mint a user-signed agent delegation credential for intake-vault
`);
  }
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
