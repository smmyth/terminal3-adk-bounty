# BUIDL Submission — Confidential Intake Vault

Terminal 3 Agent Dev Kit Bounty Challenge (Launch Ed) · Track: **Best Agent utilising Terminal 3 Agent Auth SDK**

---

## 1. Quick-fill (copy field-by-field)

| Form field | Value |
|---|---|
| BUIDL name | `Confidential Intake Vault` |
| Tagline / one-liner | An agent that triages confidential submissions privately — scoring and redacting them inside a TEE, so raw PII never leaves the enclave. |
| Logo | `assets/logo.png` (480×480 PNG, 15 KB) |
| Category | AI / AI Agents → Privacy → Identity ⚠️ *pick from the form's actual options* |
| Is this BUIDL an AI Agent? | **Yes** |
| Track | Best Agent utilising Terminal 3 Agent Auth SDK |
| Source code | ⚠️ *push `terminal3-adk-bounty/` to a public repo and paste the URL* |
| Demo video | ⚠️ *record the run-through (script in §8) and paste the link* |
| Live demo / how to run | See §7 (one-command build + testnet CLI) |
| Team | ⚠️ *solo / add teammates* |
| Contact | ⚠️ *your email / Telegram* |

---

## 2. Vision — the problem this solves

Useful AI agents have to read sensitive data — vulnerability reports, KYC documents, whistleblower tips, deal memos — to triage, score and summarize it. But the instant that raw data touches the agent runtime, its logs, or any downstream consumer, it becomes a privacy and compliance liability, and most teams answer that by simply not letting agents near the sensitive stuff.

Confidential Intake Vault removes that trade-off: it ingests a sensitive submission, computes a completeness score and produces a redacted public summary **entirely inside a Terminal 3 TEE**, and only the redacted, derived output ever crosses the boundary. The raw body is persisted to a tenant-private map gated by verifiable tenant/contract identity — it is never returned to the caller and never logged. The result is an agent that can do real work on confidential data while being **private by construction and accountable by identity**.

---

## 3. Why verifiable identity is core

The vault acts on behalf of submitters and tenants, so "who did what, and were they allowed to" has to be provable, not assumed. Verifiable identity gives the agent a DID and a tenant identity that anchor every action: the private `reports` map and the public `summaries` map are gated by ACLs keyed to verified tenant/contract identity, and any access to a user's profile happens only under an explicit on-chain delegation grant — the agent never holds raw credentials. That's what lets confidentiality and auditability stop being a trade-off: every operation is attributable to a verified DID, and authorization is checked before any PII is touched.

---

## 4. How it integrates the Agent Auth SDK (rubric: 40% integration)

Full SDK surface exercised end to end (`apps/agent-cli`):

| SDK capability | API used | CLI command |
|---|---|---|
| Testnet auth + DID | `setEnvironment("testnet")`, `loadWasmComponent`, `T3nClient`, `createEthAuthInput`, `metamask_sign`, `client.handshake()`, `client.authenticate()` | `intake auth` |
| Tenant status + quotas | `TenantClient.tenant.me()` | `intake me` |
| Tenant maps + ACLs | `TenantClient.maps.create({ visibility, writers, readers })` — private `reports` + public `summaries` | `intake init-maps` |
| Contract register (WASM upload) | `TenantClient.contracts.register({ tail, version, wasm })` | `intake register` |
| Contract invoke | `TenantClient.contracts.execute(tail, { version, functionName, input })` | `intake submit` / `score` / `summary` |
| In-enclave logs | `TenantClient.contracts.logs(tail)` | `intake logs` |
| Token usage accounting | `TenantClient.token.getUsage()` | `intake usage` |
| **Agent delegation credential** | `buildDelegationCredential` + `canonicaliseCredential` + `signCredential` (EIP-191/JCS) | `intake grant` |

Plus a contract-side authorisation gate: `submit-report` requires a verified
`tenant-context.calling-user-did()` and refuses anonymous invocations, stamping
every stored report with the submitter DID for audit.

The CLI **typechecks against the real `@terminal3/t3n-sdk@3.5.2` types** (`tsc --noEmit` passes). It deliberately pins `setEnvironment("testnet")` before constructing any client rather than inheriting the SDK's production default.

---

## 5. Architecture

```
Agent CLI (Node/TS, @terminal3/t3n-sdk)
   │  auth → DID  ·  register contract  ·  create maps  ·  invoke  ·  logs  ·  usage
   ▼
intake-vault  (Rust → wasm32-wasip2, runs inside the Trinity TEE)
   ├─ submit-report : write RAW submission → z:<tid>:reports (private)   ← PII stays here
   │                  compute score + redact → z:<tid>:summaries (public)
   │                  return ONLY { id, score, severity, redacted_summary, submitted_at }
   ├─ score-report  : read raw in-enclave → return { id, score, breakdown }
   └─ get-summary   : return redacted public summary (never the raw map)

WIT imports (capabilities = imports, no manifest):
   host:tenant/tenant-context · host:interfaces/logging · host:interfaces/kv-store
```

Privacy invariant: the raw submission body never crosses the WIT boundary back to the caller and is never written to logs — only redacted/derived output does. Enforced in `contracts/intake-vault/src/intake.rs`.

---

## 6. Status — what's built (rubric: 30% completeness)

- ✅ **TEE contract** (`contracts/intake-vault`): compiles to `wasm32-wasip2` (~170 KB, under the 1 MB tenant quota); **9 native unit tests pass**.
- ✅ **Agent CLI** (`apps/agent-cli`): 10 commands wired to the real tenant SDK API; typechecks clean against `@terminal3/t3n-sdk@3.5.2`.
- ✅ **Verified live on testnet** (SG node, tenant `testnet-dev` `active`): full flow `auth → me → grant → register (contract_id 411) → init-maps 411 → submit → summary → score → logs → usage`. `submit` returned score 100 with e-mail/phone/passport masked; `logs` show only the submitter DID + score (no PII).
- ✅ **Agent-auth**: `submit-report` gates on a verified `calling-user-did`; `intake grant` mints + user-signs a real delegation credential — the EIP-191 signature recovers the signer's address.
- ✅ **ACLs hardened + runtime-enforced**: private `reports` is locked to the contract id for read **and** write; `summaries` is read-all / contract-write-only. (A write before locking returned HTTP 403 — proof the runtime enforces it.)

---

## 7. Build & run

```bash
# Contract (verified)
cd contracts/intake-vault
cargo test --lib --target x86_64-pc-windows-msvc   # 7 passed
cargo build --target wasm32-wasip2 --release       # -> target/wasm32-wasip2/release/intake_vault.wasm

# Agent (testnet) — Node >=18; export the dev key, never hardcode it
cd ../../apps/agent-cli && npm install
export T3N_DEV_KEY=0x...        # PowerShell: $env:T3N_DEV_KEY="0x..."
npm run intake -- auth
```

---

## 8. Demo script (for the video)

1. `intake auth` → prints DID + `env: testnet` (proves identity + correct network).
2. `intake me` → tenant status `active` + quotas.
3. `intake grant` → mints a user-signed agent delegation credential scoped to intake-vault (show the recovered signer address matches the user).
4. `intake register` → publishes `intake_vault.wasm`, prints `contract_id`.
5. `intake init-maps <contractId>` → creates + locks contract-only private `reports` and public-read `summaries` to that id.
6. `intake submit '{"id":"r1","title":"Auth bypass","body":"Steps to reproduce ... contact jane@example.com phone 441234567890 passport AB1234567","severity":"high","contact":"jane@example.com"}'`
   → returns `{ score, redacted_summary }` with the e-mail, phone and passport **masked**.
7. `intake summary r1` → the public redacted summary (structured identifiers masked).
8. `intake logs` → only `report r1 stored by <did> score=100`; the raw body / e-mail / phone never appear.
9. `intake usage` → token accounting.

The "aha": the structured identifiers and the raw body never appear in the output or logs, yet the agent still scored and summarized the report — and the write was gated by a verified caller DID.

---

## 9. What makes it creative (rubric: 30%)

The agent **dogfoods the platform's core primitive on the platform itself** — a confidential report-triage agent built on, and submitted to, a bounty platform. It uses the TEE not for compute secrecy but for a *data-handling guarantee* (redact-then-publish), and proves the guarantee observably: same input, no PII in output or logs. One tight vertical (confidential intake), one crisp story.

---

## 10. Bonus — Bug Discovery contributions

Four SDK issues were found and reproduced during the live testnet integration,
each requiring a code/docs change — full reports with reproductions in
[`reports/sdk-findings-live-run.md`](reports/sdk-findings-live-run.md):

- **R-A** `TenantClient` needs `baseUrl` (typed optional) but only fails at call time.
- **R-B** `tenantScriptName` makes control-plane ops eagerly resolve the unregistered contract version → 404.
- **R-C** a private map's `writers: { only: [] }` blocks the owning contract's own in-enclave writes (HTTP 403); the numeric-contract-id ACL semantics + register-before-lock ordering are undocumented.
- **R-D** delegation credential `contract` field cap (46 chars) rejects the 55-char canonical tenant name (`ContractTooLong`); cap is undocumented.

---

### ⚠️ Before you submit
- Push `terminal3-adk-bounty/` to a public repo → paste the URL (§1).
- Record the §8 demo → paste the link.
- Pick the real Category option(s) from the form.
- Fill team + contact.
- Rotate the dev key after the demo (it was pasted in chat).
