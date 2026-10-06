use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use std::{
    collections::BTreeMap,
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SeccompArch {
    X86_64,
    Aarch64,
}

#[cfg(any(target_os = "linux", test))]
fn seccomp_arch_for(arch: &str) -> Result<SeccompArch, String> {
    match arch {
        "x86_64" => Ok(SeccompArch::X86_64),
        "aarch64" => Ok(SeccompArch::Aarch64),
        arch => Err(format!("unsupported seccomp architecture: {arch}")),
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub fn probe() -> ProbeInfo {
    #[cfg(target_os = "macos")]
    {
        return macos::probe();
    }
    #[cfg(target_os = "linux")]
    {
        return linux::probe();
    }
    #[cfg(target_os = "windows")]
    {
        return windows::probe();
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
    #[cfg(target_os = "windows")]
    {
        return windows::run(request);
    }
    #[allow(unreachable_code)]
    Err("sandbox unavailable on this L1 platform".into())
}

/// Replace this process with the sandbox backend. This preserves the dedicated
/// bridge fd and makes killing the launcher kill the actual plugin host.
pub fn exec_persistent(request: &ExecRequest) -> Result<(), String> {
    request.validate()?;
    #[cfg(target_os = "linux")]
    return linux::exec_persistent(request);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        let mut command = macos::command(request)?;
        Err(format!(
            "failed to execute sandbox backend: {}",
            command.exec()
        ))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    Err("persistent plugin host is not yet supported by this sandbox backend".into())
}

/// exit code convention for a wall-clock timeout kill.
pub(crate) const TIMEOUT_EXIT_CODE: i32 = 124;

/// Failure of a restricted execution: a wall-clock timeout is a distinct,
/// inspectable outcome (surfaced as exit 124 + violation); everything else is
/// a setup/transport error string.
#[cfg(target_os = "windows")]
#[derive(Debug)]
pub(crate) enum RunFailure {
    Timeout,
    Other(String),
}

#[cfg(target_os = "windows")]
impl From<String> for RunFailure {
    fn from(error: String) -> Self {
        RunFailure::Other(error)
    }
}

fn execute(mut command: Command, tier: SandboxTier, timeout_ms: u64) -> Result<ExecResult, String> {
    use std::sync::mpsc;

    let started = Instant::now();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to execute sandbox backend: {e}"))?;
    // Pipes are drained on dedicated threads that forward chunks over a
    // channel: a descendant that outlives the sandboxed shell while holding
    // the write end must never block the parent on EOF (join would hang).
    let spawn_reader = |pipe: Box<dyn Read + Send>| {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            let mut pipe = pipe;
            let mut chunk = [0_u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        if tx.send(chunk[..read].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        rx
    };
    let stdout_rx = child.stdout.take().map(|p| spawn_reader(Box::new(p)));
    let stderr_rx = child.stderr.take().map(|p| spawn_reader(Box::new(p)));
    let deadline = started + Duration::from_millis(timeout_ms.max(1));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to await sandbox backend: {error}"));
            }
        }
    };
    // After the direct child is gone, give in-flight pipe data a short quiet
    // window; lingering descendants holding the write end only cost the cap.
    let drain = |rx: Option<mpsc::Receiver<Vec<u8>>>| -> String {
        let Some(rx) = rx else { return String::new() };
        let mut out = Vec::new();
        let quiet = Duration::from_millis(250);
        let started = Instant::now();
        loop {
            if started.elapsed() >= quiet {
                break;
            }
            match rx.recv_timeout(quiet - started.elapsed()) {
                Ok(chunk) => out.extend_from_slice(&chunk),
                Err(mpsc::RecvTimeoutError::Disconnected)
                | Err(mpsc::RecvTimeoutError::Timeout) => break,
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    };
    let stdout = drain(stdout_rx);
    let mut stderr = drain(stderr_rx);
    let mut violations = Vec::new();
    let exit_code = match status {
        Some(status) => status.code().unwrap_or(128),
        None => {
            violations.push("timeout".into());
            stderr.push_str(&format!("\nsandbox command timed out after {timeout_ms}ms"));
            TIMEOUT_EXIT_CODE
        }
    };
    Ok(ExecResult {
        stdout,
        stderr,
        exit_code,
        duration_ms: started.elapsed().as_millis(),
        sandbox_tier: tier,
        sandbox_violations: violations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn execute_enforces_wall_clock_timeout_as_a_result() {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("echo started; sleep 30 >&2");
        let result = execute(command, SandboxTier::None, 300).expect("timed run returns a result");
        assert_eq!(result.exit_code, TIMEOUT_EXIT_CODE);
        assert_eq!(result.sandbox_violations, vec!["timeout".to_string()]);
        assert!(result.stderr.contains("timed out after 300ms"));
        assert_eq!(result.stdout, "started\n");
        assert!(result.duration_ms < 10_000);
    }

    #[cfg(unix)]
    #[test]
    fn execute_drains_pipes_of_a_fast_command() {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("echo hello world; echo err >&2");
        let result = execute(command, SandboxTier::None, 10_000).expect("fast run succeeds");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.sandbox_violations, Vec::<String>::new());
        assert_eq!(result.stdout, "hello world\n");
        assert_eq!(result.stderr, "err\n");
    }

    #[test]
    fn seccomp_arch_matrix_selects_only_reviewed_native_targets() {
        assert_eq!(seccomp_arch_for("x86_64"), Ok(SeccompArch::X86_64));
        assert_eq!(seccomp_arch_for("aarch64"), Ok(SeccompArch::Aarch64));
        for arch in ["amd64", "arm64", "x86", "riscv64", ""] {
            assert_eq!(
                seccomp_arch_for(arch),
                Err(format!("unsupported seccomp architecture: {arch}"))
            );
        }
    }
}
