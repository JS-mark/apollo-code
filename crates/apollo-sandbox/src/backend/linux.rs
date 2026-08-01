use super::execute;
use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use std::{collections::BTreeMap, process::Command};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeccompArch {
    X86_64,
    Aarch64,
}
pub fn seccomp_arch() -> Result<SeccompArch, String> {
    match std::env::consts::ARCH {
        "x86_64" => Ok(SeccompArch::X86_64),
        "aarch64" => Ok(SeccompArch::Aarch64),
        arch => Err(format!("unsupported seccomp architecture: {arch}")),
    }
}
fn bwrap() -> Option<&'static str> {
    ["/usr/bin/bwrap", "/bin/bwrap"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
}
pub fn probe() -> ProbeInfo {
    let bwrap = bwrap().is_some();
    let seccomp = seccomp_arch().is_ok();
    ProbeInfo {
        platform: "linux".into(),
        arch: std::env::consts::ARCH.into(),
        libc: Some(
            if cfg!(target_env = "musl") {
                "musl"
            } else {
                "gnu"
            }
            .into(),
        ),
        os_version: Command::new("uname")
            .arg("-r")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().into())
            .unwrap_or_default(),
        tier: if bwrap && seccomp {
            SandboxTier::Full
        } else {
            SandboxTier::None
        },
        features: BTreeMap::from([
            ("namespaces".into(), bwrap.into()),
            ("seccomp".into(), seccomp.into()),
        ]),
        known_limitations: if bwrap {
            vec!["seccomp filter installation is pending vendor integration".into()]
        } else {
            vec!["bundled bwrap unavailable".into()]
        },
    }
}
pub fn run(request: &ExecRequest) -> Result<ExecResult, String> {
    let path = bwrap().ok_or("Linux bwrap backend unavailable; refusing unsandboxed execution")?;
    seccomp_arch()?;
    let mut command = Command::new(path);
    command.args([
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]);
    if !request.permissions.net {
        command.arg("--unshare-net");
    }
    for writable in &request.permissions.fs.write {
        let path = writable.trim_end_matches("/**");
        command.args(["--bind", path, path]);
    }
    command.args(["--chdir", &request.cwd, "--clearenv"]);
    for key in &request.permissions.env.read {
        if let Ok(value) = std::env::var(key) {
            command.args(["--setenv", key, &value]);
        }
    }
    command.args(["/bin/sh", "-lc", &request.command]);
    execute(command, SandboxTier::Full)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seccomp_table_matches_l1_architectures() {
        assert!(matches!(
            seccomp_arch(),
            Ok(SeccompArch::X86_64 | SeccompArch::Aarch64)
        ));
    }
}
