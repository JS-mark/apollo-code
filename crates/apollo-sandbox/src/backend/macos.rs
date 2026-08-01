use super::execute;
use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use std::{collections::BTreeMap, process::Command};

pub fn escape_sbpl_string(value: &str) -> String {
    value
        .chars()
        .flat_map(|c| match c {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '"' => "\\\"".chars().collect(),
            '\n' => "\\n".chars().collect(),
            '\r' => "\\r".chars().collect(),
            '(' => "\\(".chars().collect(),
            ')' => "\\)".chars().collect(),
            _ => vec![c],
        })
        .collect()
}

fn profile(request: &ExecRequest) -> String {
    const UPSTREAM_BASE_POLICY: &str = include_str!(
        "../../../apollo-sandbox-vendor/upstream/sandboxing/src/seatbelt_base_policy.sbpl"
    );
    let mut rules = vec![UPSTREAM_BASE_POLICY, "(allow file-read-metadata)"];
    let mut dynamic = Vec::new();
    for path in &request.permissions.fs.read {
        dynamic.push(format!(
            "(allow file-read* (subpath \"{}\"))",
            escape_sbpl_string(path.trim_end_matches("/**"))
        ));
    }
    for path in &request.permissions.fs.write {
        dynamic.push(format!(
            "(allow file-write* (subpath \"{}\"))",
            escape_sbpl_string(path.trim_end_matches("/**"))
        ));
    }
    if request.permissions.net {
        dynamic.push("(allow network*)".into());
    }
    rules.extend(dynamic.iter().map(String::as_str));
    rules.join("\n")
}

pub fn probe() -> ProbeInfo {
    let available = std::path::Path::new("/usr/bin/sandbox-exec").exists();
    ProbeInfo {
        platform: "darwin".into(),
        arch: std::env::consts::ARCH.into(),
        libc: None,
        os_version: Command::new("uname")
            .arg("-r")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().into())
            .unwrap_or_default(),
        tier: if available {
            SandboxTier::Partial
        } else {
            SandboxTier::None
        },
        features: BTreeMap::from([("sandbox_init".into(), available.into())]),
        known_limitations: vec![
            "network allowlists are not hostname-granular in this foundation".into(),
        ],
    }
}

pub fn run(request: &ExecRequest) -> Result<ExecResult, String> {
    if probe().tier < SandboxTier::Partial {
        return Err("macOS sandbox backend unavailable; refusing unsandboxed execution".into());
    }
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .arg("-p")
        .arg(profile(request))
        .arg("/bin/sh")
        .arg("-lc")
        .arg(&request.command)
        .current_dir(&request.cwd)
        .env_clear();
    for key in &request.permissions.env.read {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for (key, value) in &request.env {
        if request.permissions.env.read.contains(key) {
            command.env(key, value);
        }
    }
    execute(command, SandboxTier::Partial)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escapes_sbpl_injection_characters() {
        assert_eq!(escape_sbpl_string("a\")\\\n(b"), "a\\\"\\)\\\\\\n\\(b");
    }

    #[test]
    fn profile_uses_pinned_closed_by_default_upstream_policy() {
        let request = ExecRequest {
            command: "true".into(),
            cwd: "/".into(),
            timeout_ms: 1,
            permissions: Default::default(),
            env: Default::default(),
        };
        let generated = profile(&request);
        assert!(generated.contains("(deny default)"));
        assert!(generated.contains("(allow signal (target same-sandbox))"));
        assert!(!generated.contains("(allow network*)"));
    }
}
