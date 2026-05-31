$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$envPrefix = Join-Path $projectRoot "tools/ocr/env"
$pythonExe = Join-Path $projectRoot "tools/ocr/env/python.exe"
$tesseractExe = Join-Path $projectRoot "tools/ocr/tesseract-runtime/tesseract.exe"
$tessdataDir = Join-Path $projectRoot "tools/ocr/tesseract-runtime/tessdata"
$envBin = Join-Path $envPrefix "Library/bin"
$envScripts = Join-Path $envPrefix "Scripts"

if (-not (Test-Path $pythonExe)) {
  throw "Python OCR local nao encontrado em: $pythonExe"
}

if (-not (Test-Path $envPrefix)) {
  throw "Ambiente OCR nao encontrado em: $envPrefix"
}

$env:PATH = "$(Split-Path -Parent $tesseractExe);$envPrefix;$envBin;$envScripts;$env:PATH"
$env:TESSDATA_PREFIX = $tessdataDir

Write-Host "OCRmyPDF:"
& $pythonExe -m ocrmypdf --version

Write-Host "Tesseract:"
& $tesseractExe --version

Write-Host "Ghostscript:"
& (Join-Path $envBin "gswin64c.exe") -v

Write-Host "QPDF:"
& (Join-Path $envBin "qpdf.exe") --version
