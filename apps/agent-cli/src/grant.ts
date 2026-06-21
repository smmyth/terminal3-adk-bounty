// Agent-auth grant — the documented Terminal 3 agent authorisation flow.
//
// The user (data owner) signs a `tee:user/contracts::agent-auth-update` that
// scopes an agent DID to exactly this tenant contract, its functions, and the
// hosts it may reach. This is the canonical "authorize an agent to act on my
// behalf, under explicit policy" primitive (see the ADK "Invoke your contract"
// walkthrough). By default we issue a SELF-grant (agentDid = the user's own
// DID), which is the documented direct-call form; pass T3N_AGENT_DID to scope a
// separate agent identity instead.
//
// intake-vault makes no outbound HTTP calls, so `allowedHosts` is empty — the
// grant here is purely the function-scoping authorisation, not egress.

import { getScriptVersion } from "@terminal3/t3n-sdk";

const CONTRACT_TAIL = "intake-vault";
const INTAKE_FUNCTIONS = ["get-summary", "score-report", "submit-report"];
const USER_CONTRACT = "tee:user/contracts";

/** Minimal structural view of the authenticated client's execute transport. */
export interface ExecuteClient {
  execute(payload: unknown): Promise<string>;
}

export interface GrantResult {
  agentDid: string;
  scriptName: string;
  scriptVersion: string;
  functions: string[];
  selfGrant: boolean;
  response: unknown;
}

/**
 * Issue an agent-auth-update authorising `agentDid` (default: the user's own
 * DID) to call the intake-vault contract's functions. Requires the contract to
 * already be registered (so its version resolves).
 */
export async function grantAgentAuth(
  client: ExecuteClient,
  userDid: string,
  nodeUrl: string,
  agentDid?: string
): Promise<GrantResult> {
  const tenantId = userDid.slice("did:t3n:".length);
  const scriptName = `z:${tenantId}:${CONTRACT_TAIL}`;

  const scriptVersion = await getScriptVersion(nodeUrl, scriptName);
  const userContractVersion = await getScriptVersion(nodeUrl, USER_CONTRACT);
  const functions = [...INTAKE_FUNCTIONS].sort();
  const effectiveAgent = agentDid ?? userDid;

  const raw = await client.execute({
    script_name: USER_CONTRACT,
    script_version: userContractVersion,
    function_name: "agent-auth-update",
    input: {
      agents: [
        {
          agentDid: effectiveAgent,
          scripts: [
            {
              scriptName,
              versionReq: scriptVersion,
              functions,
              allowedHosts: [], // no outbound HTTP — function scoping only
            },
          ],
        },
      ],
    },
  });

  let response: unknown = raw;
  try {
    response = JSON.parse(raw);
  } catch {
    /* keep raw string */
  }

  return {
    agentDid: effectiveAgent,
    scriptName,
    scriptVersion,
    functions,
    selfGrant: !agentDid,
    response,
  };
}
