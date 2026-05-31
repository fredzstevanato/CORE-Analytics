# CORE Analytics - Resumo do que já foi implementado

## 1) Estrutura do monorepo

Monorepo criado com Turborepo + npm workspaces:

- `apps/web` (Next.js App Router)
- `apps/worker-ingest` (ingestão UFDR + parsing + indexação + fila de transcrição)
- `apps/worker-ai` (transcrição local com Whisper)
- `packages/ui`
- `packages/db`
- `packages/shared`
- `packages/storage`
- `packages/search`
- `packages/parsers`
- `packages/cases`
- `packages/reports`
- `packages/forensics`
- `packages/queue`

## 2) Stack base configurada

- Next.js + TypeScript estrito
- Tailwind + componentes base estilo shadcn
- Prisma + PostgreSQL
- Redis + BullMQ
- OpenSearch
- Storage local com abstração para evolução S3/MinIO
- Docker Compose para desenvolvimento (`postgres`, `redis`, `opensearch`, `minio`)

## 3) Domínio e banco de dados

Schema Prisma implementado com entidades:

- `User`, `Case`, `Evidence`, `Extraction`, `Device`
- `Artifact`, `Chat`, `Participant`, `Message`, `Attachment`
- `TimelineEvent`, `Entity`, `Link`, `AnalystNote`, `AuditLog`
- `AudioTranscription` (novo para pipeline de transcrição)

Migrations criadas:

- `0001_init`
- `0002_audio_transcription`

## 4) Fluxo UFDR implementado (end-to-end)

Fluxo funcional:

1. Upload de `.ufdr` via web (`/api/upload-ufdr`)
2. Cálculo de hash SHA-256
3. Armazenamento do original no storage local
4. Registro de `Evidence` + `Extraction`
5. Enfileiramento de job BullMQ (`ingest-ufdr`)
6. `worker-ingest` abre UFDR como pacote compactado
7. Procura `report.xml`
8. Se não encontrar: marca `Extraction` como `FAILED` com erro detalhado
9. Se encontrar: parse inicial de `report.xml` (modular, resiliente)
10. Persistência de dados normalizados iniciais (device/chats/messages/artifacts)
11. Indexação inicial no OpenSearch (mensagens)
12. Atualização de status final de extração

## 5) Parser UFDR (modular e desacoplado)

Implementado em `packages/parsers`:

- scanner de container UFDR (zip)
- leitura de `report.xml`
- normalização tipada com Zod
- extração de artefatos de áudio para pipeline de transcrição

Parser não depende de Prisma diretamente (persistência separada em `packages/cases`).

## 6) Transcrição local de áudio (obrigatória)

Implementado pipeline completo com Whisper local:

- `worker-ingest` extrai áudios do UFDR para área derivada
- cria `Attachment` + `AudioTranscription` (`PENDING`)
- enfileira jobs em `audio-transcription`
- `worker-ai` executa Whisper local (`WHISPER_BIN`, `WHISPER_MODEL`)
- salva transcrição (`text`, `segments`) e status (`PROCESSING`, `COMPLETED`, `FAILED`)

## 7) Vínculo automático áudio <-> mensagens/chats

Vinculação automática implementada com estratégia e score:

- `direct-id`
- `hint-id`
- `timestamp-nearest`
- `chat-fallback`
- `unlinked`

Metadados de auditoria persistidos em `Attachment.metadata.linkage`:

- estratégia
- score
- ids candidatos
- timestamp da ligação

Resumo agregado também salvo em `Extraction.processingDetails.audioLinkageSummary`.

## 8) Busca e indexação

`packages/search` implementado com:

- criação de índices iniciais
- indexação de mensagens extraídas
- busca investigativa com full-text + filtros base

Tela inicial de busca no web app:

- `/search`

## 9) Interface web MVP

Telas criadas:

- `/dashboard`
- `/cases`
- `/cases/[id]`
- `/evidences`
- `/evidences/[id]`
- `/extractions`
- `/extractions/[id]`
- `/search`
- `/chats`
- `/messages`
- `/timeline`

## 10) Progresso do processamento (UI)

Implementado acompanhamento com barra de progresso:

- progresso por fases no `worker-ingest` (`processingDetails.phase/progress`)
- endpoint de status:
  - `/api/extractions/[id]/status`
- stream em tempo real com SSE:
  - `/api/extractions/[id]/stream`
- frontend com atualização ao vivo via `EventSource`
- fallback automático para polling

## 11) Validação e build

Já validado localmente:

- `npm install`
- `npm run db:generate`
- `npm run typecheck`
- `npm run build`

## 12) Configuração de ambiente

Variáveis principais em `.env.example` incluindo:

- banco (`DATABASE_URL`)
- fila (`REDIS_URL`)
- busca (`OPENSEARCH_URL`)
- storage (`STORAGE_ROOT`, `STORAGE_DRIVER`)
- Whisper local (`WHISPER_BIN`, `WHISPER_MODEL`)

---

Resumo técnico: o projeto já está com base funcional para ingestão UFDR especializada, parsing inicial, indexação, transcrição local de áudio com vínculo investigativo auditável e monitoramento de progresso em tempo real.
