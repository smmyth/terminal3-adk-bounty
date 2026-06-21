//! intake-vault v0.1.0 — Confidential Intake Vault.
//!
//! A Trinity z-tenant TEE contract that demonstrates the platform's core
//! privacy primitive end to end:
//!   - `submit-report`: persists the RAW (possibly PII-bearing) submission to
//!     the tenant-private `reports` KV map, computes a completeness score and a
//!     REDACTED summary in-enclave, persists the redacted summary to the public
//!     `summaries` map, and returns ONLY the non-sensitive result. The raw body
//!     never crosses the WIT boundary back to the caller.
//!   - `score-report`: reads the raw body in-enclave, returns only the score.
//!   - `get-summary`: returns the redacted public summary (never the raw map).
//!
//! Capabilities come from the WIT imports in `wit/world.wit` — there is no
//! separate manifest. KV maps are namespaced per tenant as `z:<tid>:<map>`,
//! derived at runtime from `tenant-context.tenant-did()`.
#![warn(clippy::style)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

pub const CONTRACT_VERSION: &str = "0.2.1";

wit_bindgen::generate!({
    world: "intake-vault",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

mod intake;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::intake_vault::contracts::Guest for Component {
    fn submit_report(
        req: exports::z::intake_vault::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("submit-report: missing input")?;
        intake::submit_report(&input)
    }

    fn score_report(
        req: exports::z::intake_vault::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("score-report: missing input")?;
        intake::score_report(&input)
    }

    fn get_summary(
        req: exports::z::intake_vault::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("get-summary: missing input")?;
        intake::get_summary(&input)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_is_semver() {
        let parts: alloc::vec::Vec<&str> = CONTRACT_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "CONTRACT_VERSION must be MAJOR.MINOR.PATCH");
        for part in parts {
            assert!(part.parse::<u32>().is_ok(), "each part must be a number");
        }
    }
}
