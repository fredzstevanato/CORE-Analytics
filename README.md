# CORE Analytics Monorepo (UFDR-first)

Monorepo investigativo focado em ingestao, parsing e indexacao de extracoes Cellebrite UFDR, sem IPED como motor principal.

## Stack

- Turborepo + npm workspaces
- Next.js (App Router) + TypeScript estrito
- Tailwind CSS + componentes estilo shadcn/ui
- PostgreSQL + Prisma
- Redis + BullMQ
- OpenSearch
- Storage abstrato (local, pronto para S3/MinIO)
- Workers dedicados para processamento pesado

## Estrutura

```text
apps/
  web/                 # UI e APIs leves (upload, consulta)
  worker-ingest/       # ingestao, leitura UFDR, parsing report.xml, persistencia e indexacao
  worker-ai/           # OCR/transcricao/classificacao
packages/
  ui/
  db/
  shared/
  storage/
  search/
  parsers/
  cases/
  reports/
  forensics/
  queue/
```

## Pre-requisitos

- Node.js 22 LTS (recomendado: 22.14.0)
- Docker + Docker Compose

## Setup rapido

1. Copie variaveis:

```bash
cp .env.example .env
```

2. Suba servicos de infraestrutura:

```bash
docker compose up -d
```

3. Instale dependencias:

```bash
npm install
```

4. Gere client Prisma e aplique schema:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

5. Rode web + workers:

```bash
npm run dev
```

Acesso da aplicacao web:

- Endereco: `http://localhost:3001`
- Porta: `3001`

Se quiser subir apenas a interface web (sem workers):

```bash
npm run dev:web
```

### Login

- URL: `http://localhost:3001/login`
- Usuario padrao: `MOCK_USER_EMAIL`
- Senha padrao: `MOCK_USER_PASSWORD`

## Endpoints e telas MVP

- Web: `http://localhost:3001`
- Dashboard: `/dashboard`
- Casos: `/cases`
- Evidencias + upload UFDR: `/evidences`
- Processamento: `/extractions`
- Busca: `/search`
- Chats: `/chats`
- Mensagens: `/messages`
- Timeline: `/timeline`

## Fluxo implementado (MVP inicial)

1. Upload de `.ufdr` em `apps/web` (`/api/upload-ufdr`)
2. Hash SHA-256 calculado
3. Arquivo salvo via `@core/storage` (driver local)
4. Evidence + Extraction persistidos no PostgreSQL
5. Job BullMQ enfileirado (`ingest-ufdr`)
6. `worker-ingest` abre UFDR como pacote compactado
7. Procura `report.xml`
8. Se nao encontrar: marca extraction como `FAILED` com erro detalhado
9. Se encontrar: parse inicial resiliente do XML (`@core/parsers`)
10. Persiste dados normalizados iniciais (device/chats/messages/artifacts)
11. Indexa resumo em OpenSearch (`messages` index inicial)
12. Atualiza extraction para `COMPLETED`
13. Extrai arquivos de audio do UFDR e cria `AudioTranscription` pendente
14. Enfileira jobs para `worker-ai` com Whisper local
15. `worker-ai` transcreve e salva texto/segmentos vinculados a attachment/evidencia/extracao
16. `worker-ai` tambem processa OCR local (Tesseract) e classificacao inicial de texto para insights

## Observacoes

- O parser UFDR esta modular e desacoplado da persistencia.
- O processamento pesado esta isolado em workers/filas.
- O projeto ja nasce preparado para escalar com OCR/transcricao/IA via `worker-ai`.
- Para transcricao local, instale Whisper CLI no host e configure `WHISPER_BIN`/`WHISPER_MODEL`.
- Para OCR local, instale Tesseract e configure `TESSERACT_BIN`.

## Troubleshooting rapido

Se aparecer `Cannot GET /` ou a pagina nao abrir:

1. Garanta Node LTS 22 ativo (`node -v` deve retornar `v22.x`).
2. Rode apenas o web para validar primeiro: `npm run dev:web`.
3. Acesse `http://localhost:3001` (porta `3001`).
4. Se `3001` estiver ocupada, finalize o processo da porta e rode novamente.
