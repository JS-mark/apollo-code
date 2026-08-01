$ErrorActionPreference = 'Stop'
$binary = $args[0]
$probe = (& $binary --probe | ConvertFrom-Json)
if ($probe.platform -ne 'windows' -or $probe.tier -ne 'none') { throw 'Windows foundation must disclose tier=none until Tier 1/2 is active' }
$request = '{"command":"whoami","cwd":"' + ($PWD.Path -replace '\\','\\') + '","permissions":{}}'
$previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
try {
  $PSNativeCommandUseErrorActionPreference = $false
  $request | & $binary 2>$null | Out-Null
  $exitCode = $LASTEXITCODE
} finally {
  $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
}
if ($exitCode -eq 0) { throw 'Windows foundation executed a command without an active sandbox' }
