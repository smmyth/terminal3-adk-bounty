// Agent-auth grant — mint a verifiable user→agent delegation credential.
//
// This exercises the Agent Auth SDK's core primitive directly: the user (the
// tenant operator, authenticated via T3N_DEV_KEY) signs a delegation
// credential that authorises ONE specific agent public key to call ONLY the
// intake-vault contract's functions, for a bounded validity window. The signed
// credential is verifiable offline (EIP-191 signature over RFC-8785 JCS bytes)
// and is exactly what lets an agent act on the user's behalf without ever
// holding the user's key.
//
// All crypto here is the real SDK surface (`buildDelegationCredential`,
// `canonicaliseCredential`, `signCredential`, `b64uEncodeBytes`,
// `canonicalTenantName`) plus @noble/curves for the agent keypair — no mocks.

import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  buildDelegationCredential,
  canonicaliseCredential,
  signCredential,
  b64uEncodeBytes,
  type DelegationCredential,
} from "@terminal3/t3n-sdk";

// The full intake-vault function surface, sorted ascending + deduped as
// `buildDelegationCredential` requires.
const INTAKE_FUNCTIONS = ["get-summary", "score-report", "submit-report"];

// The credential's `contract` field is capped at 46 chars by
// `validateCredentialBody`, so we bind to the tenant-local contract tail
// (`intake-vault`) rather than the full canonical `z:<40-hex-tid>:intake-vault`
// name (55 chars, which the validator rejects). The tenant is identified
// separately by `org_did`. (The length cap vs the canonical-name length is an
// SDK documentation gap — see the bug-report notes.)
const INTAKE_CONTRACT_ID = "intake-vault";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("expected a hex-encoded key");
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

export interface GrantResult {
  /** Compressed secp256k1 public key (33 bytes, hex) the credential binds to. */
  agent_pubkey_hex: string;
  /** Present only when the agent key was generated ephemerally (demo only). */
  agent_secret_hex?: string;
  /** Human-readable view of the signed credential body. */
  credential: Record<string, unknown>;
  /** The exact bytes that were signed (base64url-no-pad). */
  credential_jcs_b64u: string;
  /** The user's EIP-191 signature over `credential_jcs` (base64url-no-pad). */
  user_sig_b64u: string;
  /** ETH address recovered from the signature — must match the signing user. */
  signer_addr_hex: string;
}

export interface MintGrantOpts {
  userDid: string;
  tenantDid: string;
  userKeyHex: string;
  /** Validity window in seconds (default 1h). */
  ttlSecs?: number;
  /** Bind to a specific agent key; if omitted an ephemeral one is generated. */
  agentKeyHex?: string;
}

/** Build and user-sign an intake-vault delegation credential. */
export function mintGrant(opts: MintGrantOpts): GrantResult {
  const userSecret = hexToBytes(opts.userKeyHex);

  const ephemeral = !opts.agentKeyHex;
  const agentSecret = opts.agentKeyHex
    ? hexToBytes(opts.agentKeyHex)
    : Uint8Array.from(randomBytes(32));
  const agentPubkey = secp256k1.getPublicKey(agentSecret, true); // 33-byte compressed

  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSecs ?? 3600;

  const credential: DelegationCredential = buildDelegationCredential({
    user_did: opts.userDid,
    agent_pubkey: agentPubkey,
    org_did: opts.tenantDid,
    contract: INTAKE_CONTRACT_ID,
    functions: [...INTAKE_FUNCTIONS].sort(),
    scopes: [],
    metadata: { app: "confidential-intake-vault" },
    not_before_secs: now,
    not_after_secs: now + ttl,
    vc_id: Uint8Array.from(randomBytes(16)),
  });

  const jcs = canonicaliseCredential(credential);
  const { sig, addr } = signCredential(jcs, userSecret);

  return {
    agent_pubkey_hex: Buffer.from(agentPubkey).toString("hex"),
    agent_secret_hex: ephemeral ? Buffer.from(agentSecret).toString("hex") : undefined,
    credential: {
      v: credential.v,
      user_did: credential.user_did,
      org_did: credential.org_did,
      contract: credential.contract,
      functions: credential.functions,
      not_before_secs: credential.not_before_secs.toString(),
      not_after_secs: credential.not_after_secs.toString(),
      agent_pubkey_b64u: b64uEncodeBytes(credential.agent_pubkey),
      vc_id_b64u: b64uEncodeBytes(credential.vc_id),
    },
    credential_jcs_b64u: b64uEncodeBytes(jcs),
    user_sig_b64u: b64uEncodeBytes(sig),
    signer_addr_hex: "0x" + Buffer.from(addr).toString("hex"),
  };
}
