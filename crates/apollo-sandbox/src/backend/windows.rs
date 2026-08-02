use crate::profile::{ExecRequest, ExecResult, ProbeInfo, SandboxTier};
use std::{
    collections::BTreeMap,
    ffi::c_void,
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr::{null, null_mut},
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT},
    Security::{CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, TOKEN_ALL_ACCESS},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        },
        Threading::{
            CreateProcessWithTokenW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
            ResumeThread, WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
            PROCESS_INFORMATION, STARTUPINFOW,
        },
    },
};

const TIER_ONE_PROCESS_MEMORY_LIMIT: usize = 512 * 1024 * 1024;

pub fn probe() -> ProbeInfo {
    ProbeInfo {
        platform: "windows".into(),
        arch: std::env::consts::ARCH.into(),
        libc: None,
        os_version: std::env::var("OS").unwrap_or_default(),
        tier: SandboxTier::Weak,
        features: BTreeMap::from([
            ("job_object".into(), true.into()),
            ("restricted_token".into(), true.into()),
            ("appcontainer".into(), false.into()),
        ]),
        known_limitations: vec![
            "Windows Tier 1 strips privileges and applies Job Object resource limits, but cannot isolate filesystem or network access".into(),
            "Windows Tier 2 AppContainer filesystem isolation remains unavailable".into(),
        ],
    }
}

pub fn run(request: &ExecRequest) -> Result<ExecResult, String> {
    let started = Instant::now();
    let output_dir = std::env::temp_dir().join(format!(
        "apollo-sandbox-{}-{}",
        std::process::id(),
        started.elapsed().as_nanos()
    ));
    std::fs::create_dir(&output_dir)
        .map_err(|error| format!("create output directory: {error}"))?;
    let stdout_path = output_dir.join("stdout.txt");
    let stderr_path = output_dir.join("stderr.txt");
    let result = unsafe { run_restricted(request, &stdout_path, &stderr_path) };
    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&output_dir);
    let exit_code = result?;
    Ok(ExecResult {
        stdout,
        stderr,
        exit_code,
        duration_ms: started.elapsed().as_millis(),
        sandbox_tier: SandboxTier::Weak,
        sandbox_violations: vec![],
    })
}

unsafe fn run_restricted(
    request: &ExecRequest,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<i32, String> {
    let mut process_token: HANDLE = null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &mut process_token) == 0 {
        return Err(last_error("open process token"));
    }
    let process_token = OwnedHandle(process_token);

    let mut restricted_token: HANDLE = null_mut();
    if CreateRestrictedToken(
        process_token.0,
        DISABLE_MAX_PRIVILEGE,
        0,
        null(),
        0,
        null(),
        0,
        null(),
        &mut restricted_token,
    ) == 0
    {
        return Err(last_error("create restricted token"));
    }
    let restricted_token = OwnedHandle(restricted_token);

    let job = CreateJobObjectW(null(), null());
    if job.is_null() {
        return Err(last_error("create Job Object"));
    }
    let job = OwnedHandle(job);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    // The command processor and one direct child may run; a grandchild is
    // rejected by the Job Object and covered by the native escape suite.
    limits.BasicLimitInformation.ActiveProcessLimit = 2;
    limits.ProcessMemoryLimit = TIER_ONE_PROCESS_MEMORY_LIMIT;
    if SetInformationJobObject(
        job.0,
        JobObjectExtendedLimitInformation,
        &limits as *const _ as *const c_void,
        std::mem::size_of_val(&limits) as u32,
    ) == 0
    {
        return Err(last_error("configure Job Object"));
    }

    let command_processor = std::env::var_os("COMSPEC")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    let shell_command = format!(
        "\"{}\" /D /S /C \"{} 1>\"{}\" 2>\"{}\"\"",
        command_processor.display(),
        request.command,
        stdout_path.display(),
        stderr_path.display()
    );
    let mut command_line = wide_null(&shell_command);
    let application = wide_null(command_processor.as_os_str());
    let cwd = wide_null(std::ffi::OsStr::new(&request.cwd));
    let environment = environment_block(request);
    let mut startup = STARTUPINFOW::default();
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process = PROCESS_INFORMATION::default();
    if CreateProcessWithTokenW(
        restricted_token.0,
        0,
        application.as_ptr(),
        command_line.as_mut_ptr(),
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        environment.as_ptr() as *const c_void,
        cwd.as_ptr(),
        &startup,
        &mut process,
    ) == 0
    {
        return Err(last_error("create restricted process"));
    }
    let child_process = OwnedHandle(process.hProcess);
    let child_thread = OwnedHandle(process.hThread);
    if AssignProcessToJobObject(job.0, child_process.0) == 0 {
        return Err(last_error("assign restricted process to Job Object"));
    }
    if ResumeThread(child_thread.0) == u32::MAX {
        return Err(last_error("resume restricted process"));
    }
    if WaitForSingleObject(
        child_process.0,
        request.timeout_ms.min(u32::MAX as u64) as u32,
    ) == WAIT_TIMEOUT
    {
        TerminateJobObject(job.0, 124);
        return Err(format!(
            "sandbox command timed out after {}ms",
            request.timeout_ms
        ));
    }
    let mut exit_code = 0;
    if GetExitCodeProcess(child_process.0, &mut exit_code) == 0 {
        return Err(last_error("read restricted process exit code"));
    }
    Ok(exit_code as i32)
}

fn environment_block(request: &ExecRequest) -> Vec<u16> {
    let mut entries = request
        .env
        .iter()
        .filter(|(name, _)| request.permissions.env.read.contains(name))
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>();
    for required in ["COMSPEC", "SYSTEMROOT"] {
        if let Ok(value) = std::env::var(required) {
            entries.push(format!("{required}={value}"));
        }
    }
    entries.sort_unstable_by_key(|value| value.to_ascii_uppercase());
    let mut block = entries
        .join("\0")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    block.push(0);
    block
}

fn wide_null(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn last_error(action: &str) -> String {
    format!("{action}: {}", std::io::Error::last_os_error())
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}
