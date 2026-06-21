# intake-vault — v0.2.1

Confidential Intake Vault TEE contract for Trinity z-namespace tenants.

A Rust WASM contract that runs inside the Trinity TEE. It ingests a sensitive
submission, then computes a completeness score and a redacted summary **entirely
inside the enclave**. The raw submission is persisted only to the tenant-private
`reports` KV map and **never crosses the WIT boundary back to the caller**; only
the redacted summary + score do.

## Capabilities (WIT imports — no separate manifest)

`wit/world.wit` imports exactly what the contract uses — the `tenant-base` world:

- `host:tenant/tenant-context` — tenant DID (namespaces the KV maps), cluster timestamp, and `calling-user-did` (the authenticated caller, used for the auth gate)
- `host:interfaces/logging` — debug/info/error (raw submission is never logged; only the submitter DID + score are)
- `host:interfaces/kv-store` — `reports` (raw, private) and `summaries` (redacted, public) maps

No HTTP / external API is needed — the privacy demo is fully self-contained.
Privileged interfaces (signing, authorisation, user-profile) are never linked
into tenant worlds, so authorization here uses `calling-user-did`, not
`host:interfaces/authorisation`.

## Exported functions

| Function | Input (JSON) | Output (JSON) |
|---|---|---|
| `submit-report` | `{ id, title, body, severity, contact }` | `{ id, score, severity, redacted_summary, submitted_at }` |
| `score-report` | `{ id }` | `{ id, score, breakdown }` |
| `get-summary` | `{ id }` | `{ id, score, severity, redacted_summary, submitted_at }` |

`submit-report` **requires a verified `calling-user-did`** (rejects anonymous
invocations) and stamps the stored record with the submitter DID for audit.
`score` is a 0–100 completeness score (title / detail / severity / repro-steps /
contact). `redacted_summary` masks **structured identifiers** — e-mail tokens and
long digit runs (phone / passport / card / account numbers) — and is
length-capped. Free-text PII such as names is out of scope (a unit test pins this).

## Build & test

```bash
cargo test --lib --target x86_64-pc-windows-msvc   # 9 passed — score + redaction logic
cargo build --target wasm32-wasip2 --release       # -> target/wasm32-wasip2/release/intake_vault.wasm
```

> The native test command uses an explicit `--target <host-triple>` because
> `.cargo/config.toml` defaults the build target to `wasm32-wasip2` (`cargo test
> --lib` alone is compiled for wasm and never runs).

## Setup (maps)

The tenant SDK creates and locks the maps to the registered contract id before
first use (see `apps/agent-cli`):

```text
intake register        # prints contract_id
intake init-maps <id>  # reports (private) + summaries (public), writers/readers locked to <id>
```

The contract derives the physical map names at runtime as `z:<tid>:reports` and
`z:<tid>:summaries` from `tenant-context.tenant-did()`.
