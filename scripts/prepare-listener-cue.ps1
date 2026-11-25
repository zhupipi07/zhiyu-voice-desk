# Optional asset rebuild on Windows with the zh-CN system voice and FFmpeg.
# The pre-rendered WAV is served as a static file during a call.
$ErrorActionPreference = 'Stop'
$dest = Join-Path (Split-Path -Parent $PSScriptRoot) 'public/listening.wav'
$raw = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString() + '.wav')
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice.SelectVoice('Microsoft Huihui Desktop')
  $voice.Rate = 1
  $voice.SetOutputToWaveFile($raw)
  $voice.Speak([string][char]0x55ef)
  $voice.SetOutputToNull()
  $trim = 'silenceremove=start_periods=1:start_threshold=-56dB:start_silence=0.008,areverse,silenceremove=start_periods=1:start_threshold=-56dB:start_silence=0.015,areverse'
  & ffmpeg -nostdin -hide_banner -loglevel error -y -i $raw -af $trim -ar 16000 -ac 1 -c:a pcm_s16le $dest
  if ($LASTEXITCODE -ne 0) { throw 'Could not render the listening cue.' }
} finally {
  $voice.Dispose()
  if (Test-Path -LiteralPath $raw) {Remove-Item -LiteralPath $raw}
}
