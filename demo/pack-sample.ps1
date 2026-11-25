$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
  node --import tsx demo/generate.ts
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic backup generation failed.' }
  New-Item -ItemType Directory -Force .cache/samsung | Out-Null
  Compress-Archive -Path .cache/demo-backup/manifest.json,.cache/demo-backup/media -DestinationPath .cache/samsung/auto-crm-showcase-data.zip -Force
  Get-Item -LiteralPath .cache/samsung/auto-crm-showcase-data.zip | Select-Object -ExpandProperty FullName
} finally { Pop-Location }
