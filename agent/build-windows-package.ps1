$ErrorActionPreference = 'Stop'
$packageDir = Join-Path $PSScriptRoot 'windows-package'
$projectRoot = Split-Path $PSScriptRoot -Parent
$downloadDir = Join-Path $projectRoot 'public/downloads'
$target = Join-Path $downloadDir 'PhoneBridge-Agent-Windows.zip'
$temp = Join-Path $downloadDir ('PhoneBridge-Agent-Windows.' + [guid]::NewGuid().ToString('N') + '.zip')
$required = @('README.txt', 'Start-PhoneBridge.cmd', 'Start-PhoneBridge-Background.vbs', 'cloud-worker.js', 'credential-store.js', 'enrollment.js', 'reconnect-loop.js', 'local-pairing-bridge.js', 'file-transfer.js')
foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $packageDir $name) -PathType Leaf)) { throw "Windows Agent package source is missing $name." }
}
try {
  $files = $required | ForEach-Object { Join-Path $packageDir $_ }
  Compress-Archive -LiteralPath $files -DestinationPath $temp -CompressionLevel Optimal
  Move-Item -LiteralPath $temp -Destination $target -Force
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}
