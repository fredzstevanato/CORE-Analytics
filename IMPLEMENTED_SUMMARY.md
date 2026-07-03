# CORE Analytics - Resumo implementado

## 1. Estrutura do monorepo

Monorepo com Turborepo + npm workspaces:

- `apps/web`: Next.js App Router, telas e APIs
- `apps/worker-ingest`: ingestao UFDR, parsing, persistencia, indexacao e recuperacao de anexos
- `apps/worker-ai`: transcricao, OCR, classificacao, triagem e relatorios por fila
- `packages/db`: Prisma + schema de dominio
- `packages/shared`: schemas Zod e tipos compartilhados
- `packages/search`: OpenSearch, indices e busca investigativa
- `packages/parsers`: parser UFDR/Cellebrite
- `packages/cases`: servicos de caso, evidencia, triagem e sincronizacao
- `packages/reports`: relatorio consolidado
- `packages/queue`: BullMQ e filas
- `packages/storage`, `packages/ui`, `packages/forensics`

## 2. Stack

- Next.js + TypeScript estrito
- Tailwind CSS + componentes estilo shadcn/ui
- PostgreSQL + Prisma
- Redis + BullMQ
- OpenSearch
- Storage local com abstracao para evolucao
- Docker Compose para ambiente de desenvolvimento

## 3. Ingestao UFDR

Fluxo implementado:

1. Registro de evidencia e extracao por caso
2. Copia do `.ufdr` para storage local
3. Calculo de SHA-256
4. Job `ingest-ufdr`
5. Abertura do container UFDR
6. Parsing resiliente de XML/model graph
7. Persistencia de aparelho, chats, participantes, mensagens, anexos, contatos, chamadas, localizacoes e entidades
8. Indexacao em OpenSearch
9. Atualizacao de progresso em `Extraction.processingDetails`
10. Finalizacao com evento de custodia

O sistema suporta extracoes sem `report.xml` quando consegue extrair dados relevantes do UFDR/model graph.

## 4. Audios e transcricoes

Implementado:

- extracao de audios do UFDR em area derivada
- criacao de `Attachment` e `AudioTranscription`
- fila `audio-transcription`
- transcricao por engine local, OpenAI ou AssemblyAI
- fallback local quando AssemblyAI falha por billing/quota
- transcricao de `.opus` mesmo quando nao ha chat vinculado
- classificacao de transcricoes por IA
- injecao opcional da transcricao no corpo da mensagem vinculada
- limpeza automatica de jobs com falha permanente

Politica atual:

- somente `.opus` e transcrito no fluxo principal
- arquivos nao `.opus` ficam como `FAILED` por politica no banco
- falhas permanentes nao deixam jobs sujos na fila
- falhas por credito/quota permanecem para retry apos regularizacao

## 5. OCR e arquivos auditaveis

Implementado:

- indexacao de caminhos de anexos
- extracao de cache auditavel
- classificacao de qualidade de imagens, PDFs e videos
- descarte de figurinhas, icones, thumbnails e arquivos pequenos/baixa qualidade
- fila `ocr-documents`
- OCR local com Tesseract
- fallback de idioma para `eng`/padrao quando o idioma solicitado nao existe
- classificacao de OCR por IA
- filtros de arquivos `Auditaveis`, `Revisao`, `Indexados`, `Excluidos` e `Pendentes`

## 6. Busca investigativa

Implementado em `/analysis/search`:

- busca full-text em mensagens, chats, entidades, anexos, chamadas e arquivos
- filtros por caso, evidencia e extracao
- resultados em cartoes navegaveis
- botoes para abrir caso, evidencia, extracao e modulo de analise em nova aba
- enriquecimento de contatos com telefone derivado de `phone`, `handle`, `externalId` e `@s.whatsapp.net`
- acesso rapido a mensagens/chats relacionados

## 7. Mensagens e participantes

Implementado em `/analysis/messages`:

- filtros por plataforma, caso, extracao e termo
- lista lateral de chats
- painel de conversa com mensagens, anexos e transcricoes
- exibicao de telefones/WhatsApp dos participantes
- derivacao de telefone a partir de identificadores WhatsApp

## 8. Localizacoes

Implementado em `/analysis/locations`:

- listagem de artefatos `LOCATION`
- filtro por caso e extracao
- abertura direta de coordenada no Google Maps
- exportacao KML por evidencia/recorte filtrado
- uso de latitude/longitude em metadata (`latitude`, `longitude`, `lat`, `lng`, `lon`)

## 9. Analise de IA

Implementado em `/analysis/ai`:

- estimativa de triagem
- execucao de triagem investigativa
- classificacao de chats por relevancia (`alta`, `media`, `baixa`)
- correlacoes entre chats
- selecao de chats relevantes
- recuperacao de job ativo ao clicar em carregar ultima triagem
- progresso real consultado em BullMQ sem cache
- sanitizacao de payloads antes de gravar em PostgreSQL para remover `\u0000` e Unicode invalido

## 10. Relatorios

Implementado:

- relatorio consolidado por caso/evidencia
- inclusao de chats selecionados na triagem
- nomes e telefones/WhatsApp dos interlocutores
- trechos relevantes de mensagens
- arquivos auditaveis triados
- audios `.opus` sem chat selecionados pelo analista
- transcricao e analise de IA desses audios
- localizacoes disponiveis
- metadados de rastreabilidade

## 11. Operacoes e filas

Filas principais:

- `local-ufdr-import`
- `ingest-ufdr`
- `audio-recovery-batch`
- `audio-recovery-finalize`
- `audio-transcription`
- `ocr-documents`
- `ai-classification`
- `investigation-triage`
- `investigation-report`

Implementado em `/settings/operations`:

- visualizacao de jobs ativos, aguardando, pausados, falhados e atrasados
- retry/remocao de jobs
- pausar/retomar fila
- limpeza de jobs pausados antigos
- remocao por referencia/caso/evidencia/extracao

## 12. Integracoes e politica operacional

- CORE Hub export existe, mas e acao manual/discricionaria do analista.
- OpenAI API key pode ser configurada por settings criptografadas.
- Tesseract e Whisper podem ser configurados por variaveis de ambiente.
- Workers sao responsaveis por processamento pesado; a UI apenas enfileira e acompanha.

## 13. Validacao usual

Comandos principais:

```bash
npm run typecheck --workspace @core/web
npm run typecheck --workspace @core/worker-ai
npm run typecheck --workspace @core/cases
npm run typecheck --workspace @core/reports
```

Para desenvolvimento completo:

```bash
npm run dev
```

Para web isolado:

```bash
npm run dev:web
```
