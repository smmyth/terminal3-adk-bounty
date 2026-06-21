# Confidential Intake Vault — Terminal 3 ADK Bounty (Best Agent track)

An agentic, privacy-preserving **intake & triage vault** built on the Terminal 3
Agent Dev Kit (ADK). It demonstrates the platform's core differentiator end to
end: a TEE WASM tenant contract that ingests a **sensitive submission**, does all
the privacy-bearing work **inside the enclave**, and only ever returns
**redacted, derived output** across the WIT boundary — under an explicit,
verifiable agent authorization.

> Meta-narrative: *an agent that triages confidential reports privately — built on,
> and dogfooding, the bounty platform itself.*

**Source:** https://github.com/smmyth/terminal3-adk-bounty · **Track:** Best Agent
utilising Terminal 3 Agent Auth SDK · **Status:** verified live on testnet.

---

## What it does

A submitter sends a confidential report (a bug report, a tip, a KYC note — any
text carrying PII). The agent, inside the TEE:

1. **Authenticates** the caller and **authorizes** the agent via a real
   `agent-auth-update` grant scoped to exactly this contract's functions.
2. **Persists the raw submission** to a tenant-**private** `reports` map, stamped
   with the verified submitter DID for audit. The raw body never leaves the enclave.
3. **Scores completeness** and **redacts** structured identifiers in-enclave, and
   publishes only the redacted summary + score to a **public** `summaries` map.
4. Returns only the non-sensitive result. Logs carry only the submitter DID + score.

The "aha": same input, **no PII in the output or the logs**, yet the agent still
scored and summarized the report — and every write is attributable to a verified DID.

---

## How it exercises the Agent Auth SDK (scoring: 40% integration / 30% completeness / 30% creativity)

| ADK / SDK surface | API | CLI command |
|---|---|---|
| Testnet auth + DID | `setEnvironment("testnet")`, `loadWasmComponent`, `T3nClient`, `createEthAuthInput`, `metamask_sign`, `handshake()`, `authenticate()` | `intake auth` |
| Tenant status + quotas | `TenantClient.tenant.me()` | `intake me` |
| Tenant maps + ACLs | `TenantClient.maps.create / update` (private `reports`, public `summaries`, writers/readers locked to the contract id) | `intake init-maps <id>` |
| Contract register (WASM upload) | `TenantClient.contracts.register({ tail, version, wasm })` | `intake register` |
| **Agent authorization** | `client.execute({ script_name: "tee:user/contracts", function_name: "agent-auth-update", … })` via `getScriptVersion` | `intake grant` |
| Contract invoke | `TenantClient.contracts.execute(tail, { version, functionName, input })` | `intake submit` / `score` / `summary` |
| In-enclave logs | `TenantClient.contracts.logs(tail)` | `intake logs` |
| Token usage accounting | `TenantClient.token.getUsage()` | `intake usage` |
| TEE contract (Rust → `wasm32-wasip2`) using `tenant-context` + `kv-store` + `logging` (`tenant-base` world) | — | `contracts/intake-vault` |

**Privacy guarantee (structural):** the raw submission is written only to the
private `reports` map and is never returned across the WIT boundary nor logged.
This is enforced in `contracts/intake-vault/src/intake.rs`, not just by policy.

**Redaction (best-effort):** masks **structured identifiers** — e-mail, phone,
long-digit IDs (passport/card/account). Free-text PII such as personal names is
explicitly **out of scope**; a `redact_known_limitation_*` unit test pins this so
the claim stays honest.

**Accountable by identity:** `submit-report` requires a verified
`tenant-context.calling-user-did()` and refuses anonymous invocations; each stored
report is stamped with the submitter DID. `intake grant` issues the documented
`tee:user/contracts::agent-auth-update` — a user-signed authorization scoping an
agent DID to **only** this contract's functions (a self-grant by default; set
`T3N_AGENT_DID` to scope a separate agent). This is the Agent Auth SDK's core
"act on the user's behalf, under explicit policy" primitive.

---

## Layout

```
contracts/intake-vault/   Rust WASM TEE contract (builds + 9 native tests pass)
  wit/world.wit           imports: tenant-context, logging, kv-store; exports: submit/score/summary
  src/intake.rs           pure score + redact (native-tested) + wasm KV wiring + auth gate
  src/lib.rs              wit-bindgen Guest impl, CONTRACT_VERSION
apps/agent-cli/           Node/TS CLI driving the contract over @terminal3/t3n-sdk
  src/t3n.ts              auth + TenantClient construction (pins testnet, loads .env)
  src/grant.ts            agent-auth-update grant
  src/index.ts            commands: auth, me, register, init-maps, grant, submit, score, summary, logs, usage
scripts/demo.ps1          one-command end-to-end live demo runner
reports/                  reproducible SDK findings (Bug Discovery track)
```

## Build & test the contract (verified)

```bash
cd contracts/intake-vault
cargo test --lib --target x86_64-pc-windows-msvc   # 9 passed (use your host triple)
cargo build --target wasm32-wasip2 --release       # -> target/wasm32-wasip2/release/intake_vault.wasm (~170 KB)
```

## Run the agent (testnet)

> Requires Node ≥18. Provide your testnet dev key **either** by exporting
> `T3N_DEV_KEY` **or** by creating a gitignored `apps/agent-cli/.env` with
> `T3N_DEV_KEY=0x...` (auto-loaded by the CLI). Never hardcode it in source.

```bash
cd apps/agent-cli && npm install
# PowerShell: $env:T3N_DEV_KEY="0x..."   |   or: echo 'T3N_DEV_KEY=0x...' > .env

npm run intake -- auth             # DID + env (testnet)
npm run intake -- me               # tenant status + quotas
npm run intake -- register         # publish intake_vault.wasm -> prints contract_id
npm run intake -- init-maps <id>   # create + lock reports (private) & summaries (public) to that id
npm run intake -- grant            # agent-auth-update: authorize the agent for this contract's functions
npm run intake -- submit '{"id":"r1","title":"Auth bypass","body":"Steps to reproduce ... contact jane@example.com phone 441234567890","severity":"high","contact":"jane@example.com"}'
npm run intake -- summary r1       # redacted summary — email/phone masked, raw body never returned
npm run intake -- score r1
npm run intake -- logs             # submitter DID + score only, no PII
npm run intake -- usage
```

> **Ordering:** map ACLs are enforced against the contract's identity, so
> `register` must run **before** `init-maps <id>` (the id from `register` is what
> the maps are locked to), and `grant` must run **after** `register` (it resolves
> the contract version). Inline JSON is fiddly to quote on Windows — `submit` also
> accepts `submit @path/to/report.json`.

### One-command demo (for the video)

```powershell
$env:T3N_DEV_KEY = "0x<your-testnet-dev-key>"   # or use apps/agent-cli/.env
pwsh -File scripts/demo.ps1
```

`scripts/demo.ps1` runs labelled steps 1–10 (auth → me → register → init-maps →
grant → submit → summary → score → logs → usage). `register` saves the allocated
`contract_id` to a gitignored `apps/agent-cli/.contract-id`, so `init-maps` and
re-runs find it automatically — on a re-run at the same version `register`
reports a benign "version not higher" and the saved id is reused. Override the
id if ever needed with `-ContractId <id>`.

---

## Status — verified live on testnet (SG node)

- ✅ **Contract** compiles to `wasm32-wasip2` (~170 KB, under the 1 MB quota); **9 native unit tests pass** (scoring + redaction incl. separator-bearing numbers + a test pinning the documented free-text limitation).
- ✅ **CLI** typechecks clean (`tsc --noEmit`) against `@terminal3/t3n-sdk@3.5.2`.
- ✅ **End-to-end live run** (contract_id 423, v0.2.1): `auth` → `me` (tenant `active`) → `register` → `init-maps` → `grant` (`agent-auth-update`, on-chain `tx_hash` returned) → `submit` (score 100, e-mail/phone/passport masked) → `summary`/`score` → `logs` (submitter DID only, **no PII**) → `usage`.
- ✅ **Agent-auth**: `submit-report` gates on a verified `calling-user-did`; `intake grant` issues a real `tee:user/contracts::agent-auth-update`, scoping the agent to this contract's functions.
- ✅ **ACLs**: `reports` is contract-only (read+write locked to the contract id); `summaries` is public-read / contract-write only — runtime-enforced (a write before locking returns HTTP 403).

---

## Alignment with the T3N docs

This build was reviewed against the official docs and follows them where the SDK
allows:

- **Contract shape** mirrors the canonical `z-tenant-flight` sample: the
  `generic-input` 3-field envelope, the `contracts` export interface, the
  `#[cfg(target_arch = "wasm32")] Guest` impl + `export!`, and building the
  `z:<tid>:<map>` name at runtime from `tenant_context::tenant_did()`.
- **Capabilities = WIT imports, no manifest.** The contract imports only
  `tenant-context` + `logging` + `kv-store` (the `tenant-base` world). Privileged
  host interfaces (signing, authorisation, user-profile) are never linked into
  tenant worlds — which is exactly why the in-contract auth gate uses
  `tenant-context.calling-user-did()` rather than `host:interfaces/authorisation`.
- **Map ACLs** follow the documented `writers/readers: { only: [contractId] }`
  pattern (readers default to deny), with `register` before the ACL lock.
- **Public map** uses `visibility: "public"`. The docs say a public-map tail
  should begin with `public:`, but the SDK's `maps.create` rejects `:` in a tail —
  a docs ⇄ SDK contradiction documented in `reports/sdk-findings-live-run.md` (R-C).

---

## Bug Discovery contributions

Four reproducible SDK findings discovered during this integration are written up
with repros in [`reports/sdk-findings-live-run.md`](reports/sdk-findings-live-run.md):
`TenantClient` `baseUrl` inconsistency (R-A), `tenantScriptName` side-effect 404
(R-B), the public-map `public:` tail vs `validateTail` contradiction (R-C), and the
delegation-credential `contract` length cap (R-D).

## License

MIT — see [LICENSE](LICENSE).
