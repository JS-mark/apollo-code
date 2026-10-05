use super::execute;
use crate::profile::{ExecRequest, ExecResult, NetworkPermissions, ProbeInfo, SandboxTier};
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

fn profile(request: &ExecRequest) -> Result<String, String> {
    const UPSTREAM_BASE_POLICY: &str = include_str!(
        "../../../volund-sandbox-vendor/upstream/sandboxing/src/seatbelt_base_policy.sbpl"
    );
    const UPSTREAM_PLATFORM_DEFAULTS: &str = include_str!(
        "../../../volund-sandbox-vendor/upstream/sandboxing/src/restricted_read_only_platform_defaults.sbpl"
    );
    // Codex's minimal platform defaults are needed for dyld, system frameworks,
    // and shell startup. volund removes the upstream scratch-directory writes
    // because PermissionSpec remains the only source of writable roots.
    let platform_defaults = UPSTREAM_PLATFORM_DEFAULTS
        .replace(
            "(allow file-read* file-test-existence file-write* (subpath \"/tmp\"))",
            "(allow file-read* file-test-existence (subpath \"/tmp\"))",
        )
        .replace(
            "(allow file-read* file-write* (subpath \"/private/tmp\"))",
            "(allow file-read* (subpath \"/private/tmp\"))",
        )
        .replace(
            "(allow file-read* file-write* (subpath \"/var/tmp\"))",
            "(allow file-read* (subpath \"/var/tmp\"))",
        )
        .replace(
            "(allow file-read* file-write* (subpath \"/private/var/tmp\"))",
            "(allow file-read* (subpath \"/private/var/tmp\"))",
        );
    let mut rules = vec![
        UPSTREAM_BASE_POLICY,
        platform_defaults.as_str(),
        "(allow file-read-metadata)",
    ];
    let mut dynamic = Vec::new();
    for path in &request.permissions.fs.read {
        let path = canonical_policy_path(path);
        dynamic.push(format!(
            "(allow file-read* (subpath \"{}\"))",
            escape_sbpl_string(&path)
        ));
    }
    for path in &request.permissions.fs.write {
        let path = canonical_policy_path(path);
        dynamic.push(format!(
            "(allow file-write* (subpath \"{}\"))",
            escape_sbpl_string(&path)
        ));
    }
    // Tier 3 on macOS: an explicit allowlist becomes per-endpoint outbound
    // rules over the pre-resolved IP:port tuples (network.rs pins DNS before
    // the sandbox starts, closing the rebinding window). Legacy `true` keeps
    // the historical blanket grant.
    match &request.permissions.net {
        NetworkPermissions::Allowlist { allowlist } => {
            for endpoint in crate::network::resolve_allowlist(allowlist)? {
                // Seatbelt's remote-ip grammar is host:port; IPv6 hosts the
                // bracketed form so the port stays unambiguous.
                let host = if endpoint.address.is_ipv6() {
                    format!("[{}]", endpoint.address)
                } else {
                    endpoint.address.to_string()
                };
                dynamic.push(format!(
                    "(allow network-outbound (remote ip \"{host}:{}\"))",
                    endpoint.port
                ));
            }
        }
        net if net.allows_network() => dynamic.push("(allow network*)".into()),
        _ => {}
    }
    rules.extend(dynamic.iter().map(String::as_str));
    Ok(rules.join("\n"))
}

fn canonical_policy_path(path: &str) -> String {
    let path = path.trim_end_matches("/**");
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.into())
        .to_string_lossy()
        .into_owned()
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
    execute(command(request)?, SandboxTier::Partial, request.timeout_ms)
}

pub(crate) fn command(request: &ExecRequest) -> Result<Command, String> {
    if probe().tier < SandboxTier::Partial {
        return Err("macOS sandbox backend unavailable; refusing unsandboxed execution".into());
    }
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .arg("-p")
        .arg(profile(request)?)
        .arg("/bin/sh")
        .arg("-c")
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
    Ok(command)
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
        let generated = profile(&request).expect("default profile builds");
        assert!(generated.contains("(deny default)"));
        assert!(generated.contains("(allow signal (target same-sandbox))"));
        assert!(generated.contains("Map system frameworks + dylibs for loader"));
        assert!(!generated.contains("file-test-existence file-write* (subpath \"/tmp\")"));
        assert!(!generated.contains("file-write* (subpath \"/private/tmp\")"));
        assert!(!generated.contains("(allow network*)"));
    }

    #[test]
    fn network_allowlist_becomes_pinned_remote_ip_rules() {
        let request = ExecRequest {
            command: "true".into(),
            cwd: "/".into(),
            timeout_ms: 1,
            permissions: crate::profile::Permissions {
                fs: Default::default(),
                net: NetworkPermissions::Allowlist {
                    allowlist: vec!["127.0.0.1:443".into(), "[::1]:8443".into()],
                },
                env: Default::default(),
            },
            env: Default::default(),
        };
        let generated = profile(&request).expect("allowlist profile builds");
        assert!(generated.contains("(allow network-outbound (remote ip \"127.0.0.1:443\"))"));
        assert!(generated.contains("(allow network-outbound (remote ip \"[::1]:8443\"))"));
        assert!(!generated.contains("(allow network*)"));
    }
}
