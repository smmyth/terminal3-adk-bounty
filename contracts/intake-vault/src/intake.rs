//! Confidential intake logic.
//!
//! The pure helpers (`parse_submission`, `compute_score`, `redact_pii`) are
//! always compiled and unit-tested natively. The host-touching entry points
//! (`submit_report`, `score_report`, `get_summary`) gate their KV access behind
//! `target_arch = "wasm32"`, mirroring the z-tenant-flight pattern, so the
//! contract still type-checks and unit-tests on the host triple.

use serde::{Deserialize, Serialize};

/// Raw inbound submission. May carry PII in `body` / `contact`; it is persisted
/// only to the tenant-private `reports` map and never returned to the caller.
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Submission {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub contact: Option<String>,
}

/// `{ id }` lookups for score-report / get-summary.
#[derive(Deserialize, Debug)]
pub struct IdReq {
    pub id: String,
}

/// Non-sensitive, public-safe result returned across the WIT boundary and
/// stored in the `summaries` map.
#[derive(Serialize, Debug)]
pub struct Summary {
    pub id: String,
    pub score: u32,
    pub severity: String,
    pub redacted_summary: String,
    pub submitted_at: u64,
}

/// Per-criterion completeness breakdown (max 100).
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Breakdown {
    pub title: u32,
    pub detail: u32,
    pub severity: u32,
    pub repro: u32,
    pub contact: u32,
}

#[derive(Serialize, Debug)]
struct ScoreResult {
    id: String,
    score: u32,
    breakdown: Breakdown,
}

const SUMMARY_MAX_CHARS: usize = 280;
const VALID_SEVERITIES: [&str; 4] = ["low", "medium", "high", "critical"];

// ---------------------------------------------------------------------------
// Pure helpers (host-independent, unit-tested natively)
// ---------------------------------------------------------------------------

pub fn parse_submission(input: &[u8]) -> Result<Submission, String> {
    serde_json::from_slice(input).map_err(|e| format!("submit-report: bad input: {e}"))
}

/// Best-effort, in-enclave masking of **structured identifiers** only:
/// e-mail-looking tokens and tokens whose digits (ignoring common separators
/// like `-`, `.`, `(`, `)`, `/`) form a run of 7+ — phone, passport, card and
/// account numbers — then caps the summary length.
///
/// SCOPE / KNOWN LIMITATION (intentionally honest): this does NOT detect
/// free-text PII such as personal names or street addresses, and a phone
/// number split across whitespace (e.g. `44 1234 5678`) is only partially
/// caught. The public `summaries` map is therefore safe for structured
/// identifiers but is NOT a guarantee of zero PII for arbitrary prose. The
/// strong privacy invariant the contract DOES enforce is structural: the raw
/// submission body never crosses the WIT boundary and is never logged — see
/// `submit_report_wasm`. See the `redact_*` tests for the exact contract.
pub fn redact_pii(text: &str) -> String {
    let redacted: String = text
        .split_whitespace()
        .map(redact_token)
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(&redacted, SUMMARY_MAX_CHARS)
}

fn redact_token(tok: &str) -> String {
    // Strip leading/trailing punctuation so `jane@example.com,` still masks.
    let core = tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.');

    if looks_like_email(core) {
        return "[email]".to_string();
    }
    // Count digits within the token so `1234-5678` (8 digits) and `(44)1234567`
    // are caught, not just unbroken digit runs (the token is already
    // whitespace-delimited, so in-token separators don't break the count).
    let digit_count = core.chars().filter(|c| c.is_ascii_digit()).count();
    if digit_count >= 7 {
        return "[redacted-number]".to_string();
    }
    tok.to_string()
}

fn looks_like_email(tok: &str) -> bool {
    match tok.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.')
        }
        None => false,
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Completeness score 0-100 with a per-criterion breakdown.
pub fn compute_score(sub: &Submission) -> (u32, Breakdown) {
    let mut b = Breakdown::default();
    if !sub.title.trim().is_empty() {
        b.title = 20;
    }
    let body_len = sub.body.trim().chars().count();
    if body_len >= 80 {
        b.detail = 30;
    } else if body_len >= 30 {
        b.detail = 15;
    }
    if VALID_SEVERITIES.contains(&sub.severity.to_ascii_lowercase().as_str()) {
        b.severity = 20;
    }
    let body_l = sub.body.to_ascii_lowercase();
    if body_l.contains("repro") || body_l.contains("steps") || body_l.contains("reproduce") {
        b.repro = 15;
    }
    if sub
        .contact
        .as_deref()
        .map(|c| !c.trim().is_empty())
        .unwrap_or(false)
    {
        b.contact = 15;
    }
    let total = b.title + b.detail + b.severity + b.repro + b.contact;
    (total, b)
}

// ---------------------------------------------------------------------------
// Entry points (KV access gated to wasm32)
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
use crate::host::{interfaces::kv_store, interfaces::logging, tenant::tenant_context};

pub fn submit_report(input: &[u8]) -> Result<Vec<u8>, String> {
    let sub = parse_submission(input)?;

    #[cfg(target_arch = "wasm32")]
    {
        submit_report_wasm(sub)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = sub;
        Err("submit_report is only implemented on the wasm32 target".to_string())
    }
}

pub fn score_report(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: IdReq =
        serde_json::from_slice(input).map_err(|e| format!("score-report: bad input: {e}"))?;

    #[cfg(target_arch = "wasm32")]
    {
        score_report_wasm(req)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        Err("score_report is only implemented on the wasm32 target".to_string())
    }
}

pub fn get_summary(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: IdReq =
        serde_json::from_slice(input).map_err(|e| format!("get-summary: bad input: {e}"))?;

    #[cfg(target_arch = "wasm32")]
    {
        get_summary_wasm(req)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        Err("get_summary is only implemented on the wasm32 target".to_string())
    }
}

// ---------------------------------------------------------------------------
// wasm-only host wiring
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn tenant_map(suffix: &str) -> String {
    let tid = tenant_context::tenant_did();
    format!("z:{}:{}", hex::encode(&tid), suffix)
}

/// What actually lands in the tenant-private `reports` map: the raw submission
/// PLUS the verified identity that submitted it and when. Persisting the
/// caller DID makes every confidential write attributable (accountable by
/// identity) without that identity ever reaching the public `summaries` map.
#[cfg(target_arch = "wasm32")]
#[derive(Serialize, Deserialize)]
struct StoredReport {
    submission: Submission,
    /// Hex of the authenticated calling DID (20-byte CompactDid). A DID is an
    /// identifier, not the user's PII, and it never crosses to the public map.
    submitted_by: String,
    submitted_at: u64,
}

#[cfg(target_arch = "wasm32")]
fn submit_report_wasm(sub: Submission) -> Result<Vec<u8>, String> {
    // --- Agent-auth gate -------------------------------------------------
    // A confidential write MUST be attributable to a verified caller. The
    // tenant runtime stamps `calling-user-did()` from the authenticated
    // session DID; it is `None` for anonymous `/api/dev/exec` invocations.
    // Reject those so nothing unauthenticated can land in the private vault.
    // (This is the correct authorisation primitive for a tenant contract:
    // `host:interfaces/authorisation::check-authorized` gates HTTP egress
    // hosts, which this no-egress contract does not use.)
    let caller = tenant_context::calling_user_did().ok_or_else(|| {
        "submit-report: unauthenticated — a verified calling DID is required".to_string()
    })?;
    let caller_hex = hex::encode(&caller);

    let reports_map = tenant_map("reports");
    let summaries_map = tenant_map("summaries");
    let submitted_at = tenant_context::cluster_timestamp_secs();

    // 1) Persist the RAW submission + submitter identity to the tenant-private
    //    map. It is never returned across the WIT boundary.
    let stored = StoredReport {
        submission: sub.clone(),
        submitted_by: caller_hex.clone(),
        submitted_at,
    };
    let raw = serde_json::to_vec(&stored).map_err(|e| e.to_string())?;
    kv_store::put(&reports_map, sub.id.as_bytes(), &raw)
        .map_err(|e| format!("kv put reports: {e}"))?;

    // 2) Derive the non-sensitive result in-enclave.
    let (score, _breakdown) = compute_score(&sub);
    let summary = Summary {
        id: sub.id.clone(),
        score,
        severity: sub.severity.clone(),
        redacted_summary: redact_pii(&sub.body),
        submitted_at,
    };
    let summary_bytes = serde_json::to_vec(&summary).map_err(|e| e.to_string())?;

    // 3) Publish only the redacted summary to the public map.
    kv_store::put(&summaries_map, sub.id.as_bytes(), &summary_bytes)
        .map_err(|e| format!("kv put summaries: {e}"))?;

    // Audit trail: log the authenticated submitter DID + score, never the body.
    let _ = logging::info(&format!(
        "intake: report {} stored by {} score={}",
        sub.id, caller_hex, score
    ));

    Ok(summary_bytes)
}

#[cfg(target_arch = "wasm32")]
fn score_report_wasm(req: IdReq) -> Result<Vec<u8>, String> {
    let reports_map = tenant_map("reports");
    let raw = kv_store::get(&reports_map, req.id.as_bytes())
        .map_err(|e| format!("kv get reports: {e}"))?
        .ok_or_else(|| format!("report {} not found", req.id))?;
    let stored: StoredReport = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let (score, breakdown) = compute_score(&stored.submission);
    serde_json::to_vec(&ScoreResult {
        id: req.id,
        score,
        breakdown,
    })
    .map_err(|e| e.to_string())
}

#[cfg(target_arch = "wasm32")]
fn get_summary_wasm(req: IdReq) -> Result<Vec<u8>, String> {
    let summaries_map = tenant_map("summaries");
    kv_store::get(&summaries_map, req.id.as_bytes())
        .map_err(|e| format!("kv get summaries: {e}"))?
        .ok_or_else(|| format!("summary {} not found", req.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rejects_non_json() {
        let err = parse_submission(b"not json").unwrap_err();
        assert!(err.contains("bad input"), "got: {err}");
    }

    #[test]
    fn parse_requires_id_and_body() {
        let err = parse_submission(br#"{"title":"x"}"#).unwrap_err();
        assert!(err.contains("bad input"), "got: {err}");
    }

    #[test]
    fn redact_masks_email_and_long_numbers() {
        let out = redact_pii("contact jane@example.com phone 441234567890 passport AB1234567 ok");
        assert!(!out.contains("jane@example.com"), "email leaked: {out}");
        assert!(!out.contains("441234567890"), "phone leaked: {out}");
        assert!(!out.contains("AB1234567"), "passport leaked: {out}");
        assert!(out.contains("[email]"));
        assert!(out.contains("[redacted-number]"));
        assert!(out.contains("ok"));
    }

    #[test]
    fn redact_masks_numbers_with_separators_and_trailing_punctuation() {
        // Phone with in-token separators and an email with a trailing comma.
        let out = redact_pii("reach me at jane@example.com, or 1234-567-890.");
        assert!(!out.contains("jane@example.com"), "email leaked: {out}");
        assert!(!out.contains("1234-567-890"), "separated phone leaked: {out}");
        assert!(out.contains("[email]"), "got: {out}");
        assert!(out.contains("[redacted-number]"), "got: {out}");
    }

    #[test]
    fn redact_known_limitation_free_text_names_pass_through() {
        // DOCUMENTED LIMITATION: structured-identifier masking does NOT catch
        // free-text PII like personal names. This test pins that behaviour so
        // the claim stays honest — the strong guarantee is the structural one
        // (raw body never leaves the enclave), not name redaction.
        let out = redact_pii("My name is John Smith and I report a bug");
        assert!(out.contains("John"), "name unexpectedly redacted: {out}");
        assert!(out.contains("Smith"), "name unexpectedly redacted: {out}");
    }

    #[test]
    fn redact_truncates_long_text() {
        let long = "word ".repeat(200);
        let out = redact_pii(&long);
        assert!(out.chars().count() <= SUMMARY_MAX_CHARS, "len={}", out.chars().count());
    }

    #[test]
    fn complete_report_scores_high() {
        let sub = Submission {
            id: "r1".into(),
            title: "Auth bypass".into(),
            body: "Detailed description well over the eighty character threshold so the detail criterion is satisfied. Steps to reproduce: do X then Y.".into(),
            severity: "High".into(),
            contact: Some("jane@example.com".into()),
        };
        let (score, b) = compute_score(&sub);
        assert_eq!(b.title, 20);
        assert_eq!(b.detail, 30);
        assert_eq!(b.severity, 20);
        assert_eq!(b.repro, 15);
        assert_eq!(b.contact, 15);
        assert_eq!(score, 100);
    }

    #[test]
    fn sparse_report_scores_low() {
        let sub = Submission {
            id: "r2".into(),
            title: "".into(),
            body: "short".into(),
            severity: "bogus".into(),
            contact: None,
        };
        let (score, _) = compute_score(&sub);
        assert_eq!(score, 0);
    }
}
