# Terminal 3 ADK — SDK findings (live testnet run)

Environment: `@terminal3/t3n-sdk@3.5.2`, testnet SG node
`https://cn-api.sg.testnet.t3n.terminal3.io`, tenant `testnet-dev` (`active`).
Each item below was hit while wiring a real tenant contract + CLI end to end,
is reproducible, and was validated against the official docs (so documented
behaviour is not reported as a bug).

---

## R-A — `TenantClient` requires `baseUrl` even though the SDK "resolves the cluster URL for every client"

**Severity:** low/medium (API inconsistency / DX)

`TenantClientConfig.baseUrl` is typed optional (`baseUrl?: string`). The
Set-up-dev-env doc constructs the client with `baseUrl: getNodeUrl()` and the
comment states the SDK "resolves the cluster URL for every client, so you never
hardcode a node URL." Yet omitting `baseUrl` does not fall back to the active
environment — the first control-plane call throws:

```
ERROR: TenantClient config requires baseUrl for tenant control operations
```

**Repro:**
```ts
setEnvironment("testnet");
const tenant = new TenantClient({ t3n, tenantDid });   // no baseUrl
await tenant.tenant.me();                               // throws: requires baseUrl
```

**Expected:** since `setEnvironment` already fixes the node URL (and `getNodeUrl()`
returns it), `TenantClient` should default `baseUrl` from the active environment,
or the type should make `baseUrl` required so the gap is caught at compile time
rather than as a deferred runtime error.

---

## R-B — Setting `tenantScriptName` breaks unrelated control-plane calls with a confusing 404

**Severity:** medium (footgun; undocumented side effect)

`TenantClientConfig.tenantScriptName` is an accepted, optional field. Setting it
makes control-plane calls that have nothing to do with the business contract
(e.g. `tenant.me()`) eagerly resolve the contract version via `getScriptVersion`.
Before the contract is registered this 404s:

```
ERROR: Failed to fetch current version for intake-vault: 404 Not Found
```

The Set-up-dev-env doc constructs `TenantClient` WITHOUT `tenantScriptName`, so
there is no documented warning that setting it changes the behaviour of
`me()` / `maps.*` / `register`.

**Repro:**
```ts
const tenant = new TenantClient({ t3n, baseUrl: getNodeUrl(), tenantDid,
  tenantScriptName: "intake-vault" });
await tenant.tenant.me();   // 404 — me() should not resolve the contract version
```

**Expected:** either control-plane ops must not depend on resolving a
business-contract version, or the field's side effect should be documented (and
ideally the version resolved lazily, only inside `executeBusinessContract`).

---

## R-C — Public-map naming: docs require a `public:` tail, but the SDK rejects `:` in a tail

**Severity:** high (docs ⇄ SDK contradiction; blocks a documented feature)

The docs are explicit that a world-readable map must use a `public:` tail:
- Storage Namespaces: *"A tenant-public map must use both: `z:<tid>:public:<tail>` and visibility = Public."*
- Create Tenant KV Maps: *"Map tail must start with `public:`."*

But `maps.create` runs the tail through `validateTail`, whose regex rejects the
colon, so the canonical public name cannot be created through the SDK:

```
ERROR: Tenant name tail must match /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/
```

**Repro:**
```ts
await tenant.maps.create({ tail: "public:summaries", visibility: "public",
  writers: { only: [contractId] }, readers: "all" });
// throws: Tenant name tail must match /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/
```

A plain tail with `visibility: "public"` (e.g. `summaries`) is accepted and is
readable, but it does not match the documented `public:` canonical name.

**Expected:** make `validateTail` allow the documented `public:` prefix (and/or
the `:` separator for the public segment), OR correct the docs to describe the
tail shape the SDK actually accepts for public maps and how the public segment
is expressed.

---

## R-D — Delegation credential `contract` field cap (46 chars) rejects the canonical tenant name (55 chars)

**Severity:** medium (feature gap / undocumented cap)

`buildDelegationCredential` / `validateCredentialBody` cap the `contract` field
at **46 characters**. The canonical tenant contract name `z:<40-hex-tid>:<tail>`
— e.g. `z:fca4e60cf57534943ebc6bd835cd323c173a7e9e:intake-vault` = **55 chars** —
is rejected:

```
Error: ContractTooLong
  at validateCredentialBody (…)
  at buildDelegationCredential (…)
```

Empirically: lengths ≤ 46 pass, ≥ 47 throw `ContractTooLong`. The cap is not
documented in the public types/JSDoc.

**Repro:**
```ts
buildDelegationCredential({ /* … */, contract: "z:" + "f".repeat(40) + ":intake-vault" });
// throws ContractTooLong (length 55 > 46)
```

**Expected:** either raise the cap to fit a canonical tenant name, or document
that `contract` must be a short id and that the tenant is carried in `org_did`.
