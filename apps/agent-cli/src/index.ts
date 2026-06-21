#!/usr/bin/env -S npx tsx
// Confidential Intake Vault — agent CLI.
//
// Drives the intake-vault TEE contract end to end over @terminal3/t3n-sdk:
//   auth -> me -> init-maps -> register -> submit -> score -> summary -> logs -> usage
//
// Every command pins testnet (see ./t3n.ts) and reads the dev key from
// T3N_DEV_KEY. Raw submissions go to the private `reports` map inside the
// enclave; only redacted summaries + scores ever come back.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { connect, type Connection } from "./t3n";
import { grantAgentAuth } from "./grant";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = resolve(
  HERE,
  "../../../contracts/intake-vault/target/wasm32-wasip2/release/intake_vault.wasm"
);
const CONTRACT_TAIL = "intake-vault";
const CONTRACT_VERSION = "0.2.1";
// Where `register` persists the allocated contract id so later steps (init-maps)
// and re-runs can find it without re-registering. Gitignored, tenant-specific.
const CONTRACT_ID_FILE = resolve(HERE, "..", ".contract-id");

async function readSavedContractId(): Promise<number | undefined> {
  try {
    const n = Number((await readFile(CONTRACT_ID_FILE, "utf8")).trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

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
        const contractId =
          args[0] !== undefined ? Number(args[0]) : await readSavedContractId();
        if (contractId === undefined || !Number.isInteger(contractId)) {
          throw new Error(
            "init-maps: no contract id. Run `register` first (it saves the id), or pass it explicitly: init-maps <contractId>."
          );
        }
        const onlyContract = { only: [contractId] };

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

        // Public map: redacted summaries + scores, world-readable. NOTE: the
        // T3N docs say public-map tails should begin with `public:`, but the
        // SDK's maps.create rejects `:` in a tail, so we use a plain `summaries`
        // tail with public visibility (see bug-report notes). Only the contract
        // writes it; the world may read it.
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
        const reg = await tenant.contracts.register({
          tail: CONTRACT_TAIL,
          version: CONTRACT_VERSION,
          wasm,
        });
        out("register", reg);
        const id = (reg as { contract_id?: number }).contract_id;
        if (typeof id === "number") {
          await writeFile(CONTRACT_ID_FILE, String(id), "utf8");
          out("saved", `contract_id ${id} -> ${CONTRACT_ID_FILE}`);
        }
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
      // Issue the documented agent-auth grant: the user signs a
      // `tee:user/contracts::agent-auth-update` scoping an agent to ONLY this
      // contract's functions. Defaults to a self-grant (agentDid = your DID);
      // set T3N_AGENT_DID to authorise a separate agent identity.
      // Requires the contract to be registered first (so its version resolves).
      await run(async ({ client, did, nodeUrl }) => {
        const result = await grantAgentAuth(
          client as unknown as { execute(p: unknown): Promise<string> },
          did,
          nodeUrl,
          process.env.T3N_AGENT_DID
        );
        out("agent-auth-update", result);
        out(
          "note",
          result.selfGrant
            ? "Self-grant issued (agentDid = your DID). The user authorised exactly these functions on this contract — nothing else."
            : `Granted agent ${result.agentDid} access to these functions only.`
        );
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
  grant                Issue the agent-auth-update grant (self-grant; set T3N_AGENT_DID to scope an agent)
`);
  }
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
