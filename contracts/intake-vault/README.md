# intake-vault — v0.1.0

Confidential Intake Vault TEE contract for Trinity z-namespace tenants.

A Rust WASM contract that runs inside the Trinity TEE. It ingests a sensitive
submission, then computes a completeness score and a redacted summary **entirely
inside the enclave**. The raw submission is persisted only to the tenant-private
`reports` KV map and **never crosses the WIT boundary back to the caller**; only
the redacted summary + score do.

## Capabilities (WIT imports — no separate manifest)

`wit/world.wit` imports exactly what the contract uses:

- `host:tenant/tenant-context` — tenant DID (namespaces the KV maps) + cluster timestamp
- `host:interfaces/logging` — debug/info/error (raw submission is never logged)
- `host:interfaces/kv-store` — `reports` (raw, private) and `summaries` (redacted, public) maps

No HTTP / external API is needed — the privacy demo is fully self-contained.

## Exported functions

| Function | Input (JSON) | Output (JSON) |
|---|---|---|
| `submit-report` | `{ id, title, body, severity, contact }` | `{ id, score, severity, redacted_summary, submitted_at }` |
| `score-report` | `{ id }` | `{ id, score, breakdown }` |
| `get-summary` | `{ id }` | `{ id, score, severity, redacted_summary, submitted_at }` |

`score` is a 0–100 completeness score (title / detail / severity / repro-steps /
contact). `redacted_summary` masks e-mail-looking tokens and long digit runs
(phone / passport / card / account numbers) and is length-capped.

## Build & test

```bash
cargo test --lib --target x86_64-pc-windows-msvc   # 7 passed — pure score + redact logic
cargo build --target wasm32-wasip2 --release       # -> target/wasm32-wasip2/release/intake_vault.wasm
```

> The native test command uses an explicit `--target <host-triple>` because
> `.cargo/config.toml` defaults the build target to `wasm32-wasip2` (see bug
> report R4 — `cargo test --lib` alone is compiled for wasm and never runs).

## Setup (maps)

The tenant SDK creates the maps before first use (see `apps/agent-cli`):

```text
intake init-maps   # reports (private) + summaries (public)
```

The contract derives the physical map names at runtime as `z:<tid>:reports` and
`z:<tid>:summaries` from `tenant-context.tenant-did()`.
