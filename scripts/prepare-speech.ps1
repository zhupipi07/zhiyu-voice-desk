param([switch]$TestInputs)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$repo = Split-Path -Parent $PSScriptRoot
$folder = if ($TestInputs) {'data/probe-inputs'} else {'data/prompts'}
$dest = Join-Path $repo $folder
[IO.Directory]::CreateDirectory($dest) | Out-Null
$rows = & node --env-file-if-exists=.env (Join-Path $PSScriptRoot 'prompt-list.mjs') ($TestInputs.IsPresent.ToString()) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$rows) {throw 'Cannot load approved phrases.'}
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $zh = $voice.GetInstalledVoices() | Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN'} | Select-Object -First 1
  if (!$zh) {throw 'A local zh-CN system voice is required.'}
  $voice.SelectVoice($zh.VoiceInfo.Name)
  $voice.Rate = 1
  foreach ($row in $rows) {
    $file = Join-Path $dest ($row.key + '.wav')
    if (Test-Path -LiteralPath $file) {continue}
    $temp = Join-Path $dest ([guid]::NewGuid().ToString() + '.tmp')
    try {
      $voice.SetOutputToWaveFile($temp)
      $voice.Speak([string]$row.text)
      $voice.SetOutputToNull()
      if (!(Test-Path -LiteralPath $file)) {[IO.File]::Move($temp,$file)}
    } finally {if (Test-Path -LiteralPath $temp) {Remove-Item -LiteralPath $temp}}
  }
  Write-Output ("Prepared {0} phrases with {1}" -f $rows.Count,$zh.VoiceInfo.Name)
} finally {$voice.Dispose()}
