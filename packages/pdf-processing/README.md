# @core/pdf-processing

Pipeline reutilizavel para triagem e saneamento de PDF no monorepo.

## Decisao arquitetural

Opcao A (Node no proprio Turborepo): o processamento foi encapsulado em `@core/pdf-processing`, com adapters para engine PDF e OCR.
Isso permite evoluir para worker externo sem alterar o contrato principal (`runPdfImportPipeline`).

## OCR opcional

Por padrao, OCR vem desativado.

Para habilitar comando externo, configure:

- `PDF_OCR_COMMAND`
- `PDF_OCR_COMMAND_ARGS`

Argumentos aceitam placeholders:

- `{input}`
- `{output}`
- `{pages}`
- `{lang}`

Exemplo (OCRmyPDF):

`PDF_OCR_COMMAND=ocrmypdf`

`PDF_OCR_COMMAND_ARGS=--skip-text --language {lang} --pages {pages} {input} {output}`

## Exemplo de uso

```ts
import { runPdfImportPipeline } from "@core/pdf-processing";

const result = await runPdfImportPipeline({
  inputFilePath: "C:/tmp/evidence.pdf",
  originalFileName: "evidence.pdf",
  mode: "analysis-and-ocr"
});
```

## Exemplo de retorno

```json
{
  "success": true,
  "mode": "analysis-and-ocr",
  "originalFile": {
    "fileName": "evidence.pdf",
    "absolutePath": "C:/tmp/evidence.pdf"
  },
  "processedFile": {
    "fileName": "evidence.ocr.pdf",
    "absolutePath": "C:/storage/derived/pdf-processing/evidence.ocr.pdf"
  },
  "processingTimeMs": 381,
  "summary": {
    "totalPages": 10,
    "pagesNeedingOcr": 3,
    "blankPages": 1,
    "possibleDuplicatePages": 2
  },
  "pages": [],
  "duplicateGroups": [],
  "warnings": [],
  "errors": []
}
```

## Rodando local

1. `npm run --workspace @core/pdf-processing typecheck`
2. `npm run --workspace @core/web dev`
3. Abrir `Evidencias > Triagem de PDF` no frontend

## OCR portatil no proprio projeto

Se voce instalou o runtime em `tools/ocr`, configure no `.env`:

`PDF_OCR_COMMAND=powershell`

`PDF_OCR_COMMAND_ARGS=-NoProfile -ExecutionPolicy Bypass -File {projectRoot}/scripts/ocrmypdf-portable.ps1 -InputFile {input} -OutputFile {output} -Pages {pages} -Language {lang}`

`PDF_OCR_LANGUAGE=por+eng`
