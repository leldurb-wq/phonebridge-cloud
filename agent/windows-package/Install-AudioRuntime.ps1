param([Parameter(Mandatory=$true)][string]$RuntimeDir)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$audioDir = Join-Path $RuntimeDir 'audio'
$dll = Join-Path $audioDir 'NAudio.dll'
if (Test-Path -LiteralPath $dll) { exit 0 }
New-Item -ItemType Directory -Force -Path $audioDir | Out-Null
$tempRoot = Join-Path $env:TEMP ('PhoneBridge-NAudio-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $package = Join-Path $tempRoot 'naudio.nupkg'
  $archive = Join-Path $tempRoot 'naudio.zip'
  $extract = Join-Path $tempRoot 'package'
  Invoke-WebRequest -Uri 'https://api.nuget.org/v3-flatcontainer/naudio/1.10.0/naudio.1.10.0.nupkg' -OutFile $package -UseBasicParsing
  Copy-Item -LiteralPath $package -Destination $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  $sourceDll = Join-Path $extract 'lib\net35\NAudio.dll'
  if (-not (Test-Path -LiteralPath $sourceDll)) { throw 'NAudio loopback assembly was not found in the package.' }
  Copy-Item -LiteralPath $sourceDll -Destination $dll -Force
  Write-Output 'PhoneBridge Windows system-audio runtime installed.'
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
