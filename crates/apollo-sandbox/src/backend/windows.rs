use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use std::collections::BTreeMap;

pub fn probe() -> ProbeInfo {
    ProbeInfo {
        platform: "windows".into(),
        arch: std::env::consts::ARCH.into(),
        libc: None,
        os_version: std::env::var("OS").unwrap_or_default(),
        tier: SandboxTier::None,
        features: BTreeMap::from([
            ("job_object".into(), false.into()),
            ("restricted_token".into(), false.into()),
            ("appcontainer".into(), false.into()),
        ]),
        known_limitations: vec![
            "Windows Tier 1/2 isolation is not active in this build; execution is refused".into(),
            "Authenticode and real-hardware escape evidence are release gates".into(),
        ],
    }
}

pub fn run(_request: &ExecRequest) -> Result<ExecResult, String> {
    Err("Windows sandbox Tier 1/2 unavailable; refusing unsandboxed execution".into())
}
