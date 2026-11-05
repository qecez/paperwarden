$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$html = [IO.File]::ReadAllText((Join-Path $root 'index.html'))
$docs = [IO.File]::ReadAllText((Join-Path $root 'docs/HOSTING.md'))
$htmlBlocks = [regex]::Matches($html, '(?s)<section\b[^>]*aria-labelledby="verify-windows"[^>]*>.*?<pre><code>(.*?)</code></pre>')
$docBlocks = [regex]::Matches($docs, '(?s)### Windows \(PowerShell\)\s+```powershell\s*\r?\n(.*?)\r?\n```')
if ($htmlBlocks.Count -ne 1 -or $docBlocks.Count -ne 1) {
  throw 'Expected one Windows verification block in the app and guide.'
}
$appCode = [Net.WebUtility]::HtmlDecode($htmlBlocks[0].Groups[1].Value).Replace("`r`n", "`n").Trim()
$docCode = $docBlocks[0].Groups[1].Value.Replace("`r`n", "`n").Trim()
if ($appCode -cne $docCode) { throw 'The app and guide have different verification instructions.' }

$directory = Join-Path ([IO.Path]::GetTempPath()) ('paperwarden-checksum-' + [guid]::NewGuid())
$bytes = [Text.Encoding]::UTF8.GetBytes("Public checksum test.`n")
$sha = [Security.Cryptography.SHA256]::Create()
try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
$cases = @(
  @{ Name = 'matching'; Reader = $true; Checksum = $digest; Result = 'OK' },
  @{ Name = 'mismatch'; Reader = $true; Checksum = ('0' * 64); Result = 'FAILED' },
  @{ Name = 'missing reader'; Reader = $false; Checksum = $digest; Result = 'FAILED' },
  @{ Name = 'missing checksum'; Reader = $true; Checksum = $null; Result = 'FAILED' },
  @{ Name = 'both missing'; Reader = $false; Checksum = $null; Result = 'FAILED' },
  @{ Name = 'malformed checksum'; Reader = $true; Checksum = 'not-a-checksum'; Result = 'FAILED' },
  @{ Name = 'empty checksum'; Reader = $true; Checksum = ''; Result = 'FAILED' },
  @{ Name = 'stale expected digest'; Reader = $true; Checksum = $null; Stale = $true; Result = 'FAILED' },
  @{ Name = 'stale values, both missing'; Reader = $false; Checksum = $null; Stale = $true; Result = 'FAILED' }
)
try {
  foreach ($case in $cases) {
    $folder = Join-Path $directory $case.Name
    [void][IO.Directory]::CreateDirectory($folder)
    if ($case.Reader) { [IO.File]::WriteAllBytes((Join-Path $folder 'paperwarden.html'), $bytes) }
    if ($null -ne $case.Checksum) {
      $checksumFile = if ($case.Checksum -eq '') { '' } else { $case.Checksum + "  paperwarden.html`n" }
      [IO.File]::WriteAllText((Join-Path $folder 'paperwarden.html.sha256'), $checksumFile)
    }
    # A separate session uses normal console error handling. The harness's Stop
    # preference and try block must not conceal the false-OK regression.
    $session = [powershell]::Create()
    try {
      $initial = if ($case.Stale) { $digest } else { $null }
      [void]$session.AddScript('$ErrorActionPreference = "Continue"; Set-Location -LiteralPath $args[0]; $expected = $args[1]; $actual = $args[1]' + "`n" + $appCode).AddArgument($folder).AddArgument($initial)
      $result = @($session.Invoke())
    } finally { $session.Dispose() }
    if ($result.Count -ne 1 -or $result[0] -cne $case.Result) {
      throw "Verification failed the '$($case.Name)' case."
    }
  }
  Write-Output "Windows verification instructions passed $($cases.Count) cases."
} finally {
  if (Test-Path $directory) { Remove-Item $directory -Recurse -Force }
}
