$ErrorActionPreference = 'Stop'
$binary = $args[0]
$probe = (& $binary --probe | ConvertFrom-Json)
if ($probe.platform -ne 'windows' -or $probe.tier -ne 'weak') { throw 'Windows Tier 1 must disclose tier=weak' }
if (-not $probe.features.job_object -or -not $probe.features.restricted_token) { throw 'Windows Tier 1 mechanisms are missing' }
if ($probe.features.appcontainer) { throw 'Windows Tier 2 must not be claimed before AppContainer is active' }

function Invoke-Sandbox([string] $command) {
  $request = @{
    command = $command
    cwd = $PWD.Path
    timeout_ms = 10000
    permissions = @{}
  } | ConvertTo-Json -Compress -Depth 4
  $result = $request | & $binary | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "sandbox command failed: $command" }
  return $result
}

$builtin = Invoke-Sandbox 'echo tier-one-active'
if ($builtin.sandbox_tier -ne 'weak' -or $builtin.stdout.Trim() -ne 'tier-one-active') { throw 'restricted command did not execute at Weak tier' }

$privileges = Invoke-Sandbox 'whoami /priv'
if ($privileges.stdout -match 'SeDebugPrivilege|SeShutdownPrivilege|SeTakeOwnershipPrivilege') { throw 'restricted token retained a sensitive privilege' }

$nested = Invoke-Sandbox 'cmd.exe /D /C "cmd.exe /D /C echo escaped"'
if ($nested.stdout -match 'escaped') { throw 'Job Object active-process limit allowed a grandchild escape' }
