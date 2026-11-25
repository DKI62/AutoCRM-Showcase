$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expected = 'com.autocrm.showcase'

if (-not (Get-Command java -ErrorAction SilentlyContinue)) { throw 'Install a JDK 17 and put it on PATH.' }
$version = (& java -version 2>&1 | Out-String)
if ($version -notmatch 'version "17(?:\.|")') { throw 'Switch this terminal to JDK 17 before building the demo.' }

$sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA/Android/Sdk") |
  Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'build-tools') -PathType Container) } |
  Select-Object -First 1
if (-not $sdk) { throw 'Install the Android SDK including Build-Tools, then set ANDROID_HOME.' }
$aapt2 = Get-ChildItem -Path (Join-Path $sdk 'build-tools') -Filter aapt2.exe -Recurse |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $aapt2) { throw 'aapt2.exe is missing. Install Android SDK Build-Tools via SDK Manager.' }

$priorVariant = $env:APP_VARIANT
$priorSdk = $env:ANDROID_HOME
Push-Location $root
try {
  $env:APP_VARIANT = 'showcase'
  $env:ANDROID_HOME = $sdk
  if (-not (Test-Path -LiteralPath 'node_modules/.bin/expo.cmd')) { throw 'Run npm ci in this Showcase checkout first.' }
  $config = node -e "const e=require('@expo/config').getConfig(process.cwd()).exp; console.log(JSON.stringify({id:e.android.package,scheme:e.scheme,ota:e.updates?.enabled,linked:Boolean(e.extra?.eas?.projectId)}));"
  if ($LASTEXITCODE -ne 0) { throw 'Expo config evaluation failed.' }
  $config = $config | ConvertFrom-Json
  if ($config.id -cne $expected -or $config.scheme -cne 'autocrm-showcase' -or $config.ota -ne $false -or $config.linked) {
    throw 'Refusing to build a package outside the isolated Showcase configuration.'
  }

  if (-not (Test-Path -LiteralPath android)) {
    & node_modules/.bin/expo.cmd prebuild --platform android --no-install
    if ($LASTEXITCODE -ne 0) { throw 'Expo prebuild failed.' }
  }
  $gradle = Get-Content -LiteralPath 'android/app/build.gradle' -Raw
  if ($gradle -notmatch 'applicationId\s+"com\.autocrm\.showcase"\s' -or
      $gradle -notmatch '(?s)release\s*\{\s*signingConfig\s+signingConfigs\.debug') {
    throw 'Native project is not the Showcase release variant using local demo signing. Use a fresh Showcase checkout.'
  }
  Push-Location android
  try {
    & .\gradlew.bat :app:assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Showcase Gradle build failed.' }
  } finally { Pop-Location }

  $apk = 'android/app/build/outputs/apk/release/app-release.apk'
  $badging = & $aapt2.FullName dump badging $apk
  if ($LASTEXITCODE -ne 0 -or -not ($badging | Where-Object { $_ -match "^package:\s+name='com\.autocrm\.showcase'" })) {
    throw 'APK manifest does not match com.autocrm.showcase.'
  }
  $destination = New-Item -ItemType Directory -Force .cache/samsung
  Copy-Item -LiteralPath $apk -Destination (Join-Path $destination.FullName 'auto-crm-showcase.apk')
  Write-Output (Join-Path $destination.FullName 'auto-crm-showcase.apk')
} finally {
  Pop-Location
  $env:APP_VARIANT = $priorVariant
  $env:ANDROID_HOME = $priorSdk
}
