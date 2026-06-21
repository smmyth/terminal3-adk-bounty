# Confidential Intake Vault — Terminal 3 ADK Bounty (Best Agent track)

An agentic, privacy-preserving **intake & triage vault** built on the Terminal 3
Agent Dev Kit. It demonstrates the platform's core differentiator end to end: a
TEE WASM contract that ingests a **sensitive submission**, does all the
privacy-bearing work **inside the enclave**, and only ever returns
**redacted, derived output** across the WIT boundary.

> Meta-narrative: *an agent that triages confidential reports privately — built on,
> and dogfooding, the bounty platform itself.*

## Why this exercises the SDK (scoring: 40% integration / 30% completeness / 30% creativity)

| ADK / SDK surface | Where it's used |
|---|---|
| Testnet auth + DID (`setEnvironment("testnet")`, `T3nClient`, eth auth) | `apps/agent-cli/src/t3n.ts` |
| Tenant status + quotas (`tenant.me`) | `intake me` |
| Tenant maps + ACLs (`maps.create`, private vs public) | `intake init-maps` |
| Contract register (`contracts.register`, WASM upload) | `intake register` |
| Contract invoke (`contracts.execute`) | `intake submit` / `score` / `summary` |
| In-enclave logs (`contracts.logs`) | `intake logs` |
| Token usage accounting (`token.getUsage`) | `intake usage` |
| Agent delegation credential (`buildDelegationCredential`, `signCredential`, `canonicaliseCredential`) | `intake grant` |
| TEE contract (Rust → `wasm32-wasip2`) using `tenant-context` + `kv-store` + `logging` | `contracts/intake-vault` |

The **privacy guarantee** is the demo's spine and it is *structural*: the raw
submission is written only to the tenant-private `reports` map; the completeness
score and a redacted summary are computed in-enclave and written to the public
`summaries` map. The raw body **never crosses the WIT boundary back to the
caller** and is never logged (see `contracts/intake-vault/src/intake.rs`).

Redaction of the public summary is best-effort masking of **structured
identifiers** (e-mail, phone, long-digit IDs); free-text PII such as personal
names is explicitly out of scope (a `redact_known_limitation_*` test pins this
honestly). The strong guarantee is the structural one above, not name removal.

**Accountable by identity:** `submit-report` requires a verified
`tenant-context.calling-user-did()` and refuses anonymous invocations; every
stored report is stamped with the submitter DID for audit. The CLI `grant`
command mints a real **user-signed agent delegation credential** (EIP-191 over
RFC-8785 JCS) authorising a specific agent key to call only intake-vault's
functions for a bounded window — the Agent Auth SDK's core "act on the user's
behalf without holding their key" primitive.

## Layout

```
contracts/intake-vault/   Rust WASM TEE contract (builds + 7 native tests pass)
  wit/world.wit           imports: tenant-context, logging, kv-store; exports: submit/score/summary
  src/intake.rs           pure score + redact (native-tested) + wasm KV wiring
apps/agent-cli/           Node/TS CLI driving the contract over @terminal3/t3n-sdk
  src/t3n.ts              auth + TenantClient construction (pins testnet)
  src/index.ts            commands: auth, me, init-maps, register, submit, score, summary, logs, usage
```

## Build & test the contract (verified)

```bash
cd contracts/intake-vault
cargo test --lib --target x86_64-pc-windows-msvc   # 7 passed (use your host triple)
cargo build --target wasm32-wasip2 --release       # -> target/wasm32-wasip2/release/intake_vault.wasm (~160 KB)
```

## Run the agent (testnet)

> Requires Node ≥18. Provide your testnet dev key **either** by exporting
> `T3N_DEV_KEY` **or** by creating a gitignored `apps/agent-cli/.env` with
> `T3N_DEV_KEY=0x...` (auto-loaded by the CLI). Never hardcode it in source.

```bash
cd apps/agent-cli && npm install
export T3N_DEV_KEY=0x...            # PowerShell: $env:T3N_DEV_KEY="0x..."
                                    # or: echo 'T3N_DEV_KEY=0x...' > apps/agent-cli/.env

npm run intake -- auth             # DID + env (should print testnet)
npm run intake -- me               # tenant status + quotas
npm run intake -- grant            # mint a user-signed agent delegation credential (1h)
npm run intake -- register         # publish intake_vault.wasm -> prints contract_id (e.g. 411)
npm run intake -- init-maps 411    # create + lock reports (private) & summaries (public) to that id
npm run intake -- submit '{"id":"r1","title":"Auth bypass","body":"Steps to reproduce: ... contact jane@example.com phone 441234567890","severity":"high","contact":"jane@example.com"}'
npm run intake -- summary r1       # redacted summary — email/phone masked, raw body never returned
npm run intake -- score r1
npm run intake -- logs
npm run intake -- usage
```

> Map ACLs are enforced against the contract's identity, so `register` must run
> **before** `init-maps <contractId>` — the contract id from `register` is what
> the maps are locked to.

### One-command demo (for the video)

`scripts/demo.ps1` runs the whole flow in sequence, auto-capturing the
`contract_id` from `register` and locking the maps to it:

```powershell
$env:T3N_DEV_KEY = "0x<your-testnet-dev-key>"
pwsh -File scripts/demo.ps1
# re-run when the contract is already registered (skips id auto-capture):
pwsh -File scripts/demo.ps1 -ContractId 411
```

It prints labelled steps 1–10 (auth → me → grant → register → init-maps →
submit → summary → score → logs → usage). On a re-run, `register` returns a
harmless `400 version not higher` (the contract already exists) and the script
falls back to the provided `-ContractId`.

## Status

- ✅ Contract: compiles to `wasm32-wasip2`, **9 native unit tests pass** (scoring + redaction incl. separators + the documented free-text limitation).
- ✅ CLI: full command surface wired to the real tenant SDK API; `tsc --noEmit` passes against `@terminal3/t3n-sdk@3.5.2`.
- ✅ **Verified live on testnet** (SG node): `auth` → `me` (tenant `active`) → `grant` → `register` (contract_id 411) → `init-maps 411` → `submit` (score 100, e-mail/phone/passport masked) → `summary`/`score` → `logs` (submitter DID only, **no PII**) → `usage`.
- ✅ Agent-auth: `submit-report` gates on a verified `calling-user-did`; `intake grant` mints + user-signs a real delegation credential (EIP-191 sig recovers the signer).
- ✅ ACLs: `reports` is contract-only (read+write locked to the contract id); `summaries` is public-read, contract-write only — enforced by the runtime (a write attempt before locking returned HTTP 403).
