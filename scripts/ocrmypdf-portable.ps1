param(
  [Parameter(Mandatory = $true)]
  [string]$InputFile,
  [Parameter(Mandatory = $true)]
  [string]$OutputFile,
  [Parameter(Mandatory = $true)]
  [string]$Pages,
  [Parameter(Mandatory = $true)]
  [string]$Language
  ,
  [Parameter(Mandatory = $false)]
  [ValidateSet("skip-text", "redo-ocr", "force-ocr")]
  [string]$OcrMode = "redo-ocr"
  ,
  [Parameter(Mandatory = $false)]
  [string]$Sidecar = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$pythonExe = Join-Path $projectRoot "tools/ocr/env/python.exe"
$tesseractDir = Join-Path $projectRoot "tools/ocr/tesseract-runtime"
$tessdataDir = Join-Path $tesseractDir "tessdata"
$envPrefix = Join-Path $projectRoot "tools/ocr/env"
$envBin = Join-Path $envPrefix "Library/bin"
$envScripts = Join-Path $envPrefix "Scripts"

if (-not (Test-Path $pythonExe)) {
  throw "Python OCR local nao encontrado em: $pythonExe"
}

if (-not (Test-Path $envPrefix)) {
  throw "Ambiente OCR nao encontrado em: $envPrefix"
}

if (-not (Test-Path $tesseractDir)) {
  throw "Tesseract local nao encontrado em: $tesseractDir"
}

$env:PATH = "$tesseractDir;$envPrefix;$envBin;$envScripts;$env:PATH"
$env:TESSDATA_PREFIX = $tessdataDir

$sidecarArgs = @()
if ($Sidecar -ne "") {
  $sidecarArgs = @("--sidecar", $Sidecar)
}

& $pythonExe -m ocrmypdf --$OcrMode --invalidate-digital-signatures --language $Language --pages $Pages @sidecarArgs $InputFile $OutputFile
exit $LASTEXITCODE
