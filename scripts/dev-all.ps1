<#
  Windows launcher: opens three terminal windows, one per dev process.

  Run from the repo root:
      pwsh -ExecutionPolicy Bypass -File scripts\dev-all.ps1
  or just:
      pnpm dev:all

  Uses Windows Terminal (wt.exe) when available so the three processes land as
  tabs in one window; falls back to three separate PowerShell windows on
  machines without it. Requires infra up first: pnpm dev:up; pnpm dev:migrate
#>
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot

$jobs = @(
  @{ Title = 'market-data'; Command = 'cd services/market-data; go run ./cmd/market-data' },
  @{ Title = 'api-gateway'; Command = 'pnpm dev:gateway' },
  @{ Title = 'web';         Command = 'pnpm dev:web' }
)

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue

if ($wt) {
  # Build a single wt invocation: first job opens the window, the rest are
  # new-tabs joined by ';' (escaped as '`;' so PowerShell passes it through).
  $args = @()
  for ($i = 0; $i -lt $jobs.Count; $i++) {
    $j = $jobs[$i]
    if ($i -gt 0) { $args += '`;' ; $args += 'new-tab' }
    $args += '--title'
    $args += $j.Title
    $args += 'pwsh'
    $args += '-NoExit'
    $args += '-Command'
    $args += "Set-Location '$RepoRoot'; $($j.Command)"
  }
  Start-Process wt.exe -ArgumentList $args
} else {
  foreach ($j in $jobs) {
    Start-Process pwsh -ArgumentList @(
      '-NoExit', '-Command', "Set-Location '$RepoRoot'; `$Host.UI.RawUI.WindowTitle='$($j.Title)'; $($j.Command)"
    )
  }
}

Write-Host 'Launched 3 windows/tabs: market-data, api-gateway, web.'
Write-Host "If the terminal is empty, run 'pnpm dev:up; pnpm dev:migrate' first."
