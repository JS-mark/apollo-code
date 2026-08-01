use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use std::{collections::BTreeMap, process::Command, time::Instant};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

pub fn probe() -> ProbeInfo {
    #[cfg(target_os = "macos")]
    {
        return macos::probe();
    }
    #[cfg(target_os = "linux")]
    {
        return linux::probe();
    }
    #[allow(unreachable_code)]
    ProbeInfo {
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        libc: None,
        os_version: String::new(),
        tier: SandboxTier::None,
        features: BTreeMap::new(),
        known_limitations: vec!["unsupported L1 platform".into()],
    }
}

pub fn run(request: &ExecRequest) -> Result<ExecResult, String> {
    request.validate()?;
    #[cfg(target_os = "macos")]
    {
        return macos::run(request);
    }
    #[cfg(target_os = "linux")]
    {
        return linux::run(request);
    }
    #[allow(unreachable_code)]
    Err("sandbox unavailable on this L1 platform".into())
}

fn execute(mut command: Command, tier: SandboxTier) -> Result<ExecResult, String> {
    let started = Instant::now();
    let output = command
        .output()
        .map_err(|e| format!("failed to execute sandbox backend: {e}"))?;
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(128),
        duration_ms: started.elapsed().as_millis(),
        sandbox_tier: tier,
        sandbox_violations: vec![],
    })
}
