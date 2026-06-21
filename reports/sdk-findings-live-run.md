# Terminal 3 ADK — SDK findings (live testnet run)

Environment: `@terminal3/t3n-sdk@3.5.2`, testnet SG node
`https://cn-api.sg.testnet.t3n.terminal3.io`, tenant `testnet-dev` (`active`).
All four were hit while wiring a real tenant contract + CLI end to end; each is
reproducible, SDK-related, and requires a code/docs change to fix.

---

## R-A — `TenantClient` silently needs `baseUrl`; only fails at call time

**Severity:** medium (DX / onboarding blocker)

`TenantClientConfig.baseUrl` is typed optional (`baseUrl?: string`) and the
constructor accepts a config without it. The failure only appears when the first
control-plane method is called:

```
ERROR: TenantClient config requires baseUrl for tenant control operations
```

**Repro:**
```ts
const tenant = new TenantClient({ t3n: client, environment: "testnet", tenantDid });
await tenant.tenant.me(); // throws "requires baseUrl for tenant control operations"
```

**Expected:** either `baseUrl` is required in the type (non-optional, or a
discriminated config), or the client defaults it from `environment` /
`getNodeUrl()`. Today the optional type + deferred runtime error sends every new
integrator down a debugging detour.

**Fix:** default `baseUrl` from the resolved environment node URL, or make the
control-plane config shape require it at construction.

---

## R-B — `tenantScriptName` makes control-plane ops eagerly resolve the (unregistered) contract version → 404

**Severity:** medium (ordering trap)

Setting `tenantScriptName` in the `TenantClient` config causes control-plane
calls that have nothing to do with the business contract (e.g. `tenant.me()`) to
resolve the contract version up-front via `getScriptVersion`. Before the contract
is registered this 404s:

```
ERROR: Failed to fetch current version for intake-vault: 404 Not Found
```

**Repro:**
```ts
const tenant = new TenantClient({ t3n: client, environment: "testnet",
  baseUrl: nodeUrl, tenantDid, tenantScriptName: "intake-vault" });
await tenant.tenant.me(); // 404 — me() should not need the script version
```

**Workaround:** omit `tenantScriptName`; `contracts.execute(tail, …)` takes the
tail explicitly anyway.

**Expected:** control-plane ops (`me`, `maps.*`, `contracts.register`) must not
depend on resolving a business-contract version. Resolve it lazily, only inside
`executeBusinessContract`.

---

## R-C — Private map `writers: { only: [] }` blocks the owning contract's own in-enclave writes (HTTP 403); chicken-and-egg with the contract id

**Severity:** high (correctness + docs gap)

Map write ACLs are enforced against the **contract's numeric identity**, including
the contract's own in-enclave `kv-store::put`. A private map created with
`writers: { only: [] }` (intuitively "no external writers") therefore blocks the
contract that is supposed to own it:

```
HTTP 403: {"code":"forbidden","detail":"access denied:
TenantContract(did:t3n:…/411) cannot write map \"z:…:reports\""}
```

The contract id (`411`) is only known **after** `contracts.register`, but the map
ACL must reference it — a chicken-and-egg the map-create docs don't call out, nor
do they document that `writers`/`readers` `only` entries are numeric contract ids
gating the contract's own KV access (not just external API callers).

**Repro:**
1. `maps.create({ tail: "reports", visibility: "private", writers: { only: [] }, readers: { only: [] } })`
2. `contracts.register({ tail: "intake-vault", … })` → `contract_id: 411`
3. invoke a function that does `kv_store::put("…:reports", …)` → **403**
4. `maps.update("reports", { writers: { only: [411] }, readers: { only: [411] } })` → now succeeds

**Expected:** document that (a) `only` entries are numeric contract ids, (b) the
owning contract must be listed to perform its own writes/reads, and (c) the
register-before-lock ordering. Optionally auto-grant the owning contract.

---

## R-D — Delegation credential `contract` field cap (46 chars) rejects the canonical tenant contract name (55 chars)

**Severity:** medium (feature gap / docs gap)

`buildDelegationCredential` / `validateCredentialBody` cap the `contract` field at
**46 characters**. The canonical tenant contract name is `z:<40-hex-tid>:<tail>`
— e.g. `z:fca4e60cf57534943ebc6bd835cd323c173a7e9e:intake-vault` = **55 chars** —
so a delegation credential cannot bind to a tenant contract's canonical name:

```
Error: ContractTooLong
  at validateCredentialBody (…)
  at buildDelegationCredential (…)
```

**Repro:**
```ts
buildDelegationCredential({ /* … */, contract: canonicalTenantName(tenantDid, "intake-vault") });
// throws ContractTooLong (contract.length === 55 > 46)
```

Empirically: lengths ≤ 46 pass, ≥ 47 throw `ContractTooLong`.

**Expected:** either raise the cap to fit a canonical tenant name
(`z:` + 40 + `:` + tail), or document that delegation `contract` must be a short
id (e.g. the tail) and that the tenant is identified separately via `org_did`.
The cap is also undocumented in the public types/JSDoc.

**Workaround used here:** bind the credential to the tail `intake-vault` and carry
the tenant in `org_did`.
