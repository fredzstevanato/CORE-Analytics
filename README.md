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
- Busca investigativa: `/analysis/search`
- Mensagens/chats: `/analysis/messages`
- Arquivos auditaveis: `/analysis/attachments`
- Audios/transcricoes: `/analysis/audios`
- Analise de IA: `/analysis/ai`
- Timeline: `/analysis/timeline`
- Localizacoes: `/analysis/locations`
- Grafo de telefones: `/graph`
- Operacoes e filas: `/settings/operations`

## Fluxo implementado

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
14. Enfileira jobs para `worker-ai` com engine local, OpenAI ou AssemblyAI
15. `worker-ai` transcreve `.opus` e salva texto/segmentos vinculados a attachment/evidencia/extracao
16. Audios nao `.opus` sao marcados como falha por politica e nao ficam presos na fila
17. `worker-ai` processa OCR local (Tesseract) para anexos auditaveis e classifica textos para insights
18. Arquivos, imagens, PDFs e videos recebem triagem de qualidade (`AUDITABLE`, `REVIEWABLE`, `DISCARDED`)
19. Localizacoes podem ser abertas no Google Maps e exportadas em KML por evidencia
20. Triagem investigativa e relatorio consolidado usam chats, transcricoes, OCR, arquivos auditaveis e audios sem chat selecionados

## Observacoes

- O parser UFDR esta modular e desacoplado da persistencia.
- O processamento pesado esta isolado em workers/filas.
- O projeto ja nasce preparado para escalar com OCR/transcricao/IA via `worker-ai`.
- Para transcricao local, instale Whisper CLI no host e configure `WHISPER_BIN`/`WHISPER_MODEL`.
- Para OCR local, instale Tesseract e configure `TESSERACT_BIN`.
- Se o Tesseract nao tiver o idioma solicitado, o OCR tenta fallback para `eng`/padrao.
- Exportacao CORE Hub e acao manual/discricionaria, nao automatica.
- Jobs de transcricao com erro permanente sao removidos da fila apos gravar o erro no banco; erros de credito/quota permanecem para retry.

## Funcionalidades de analise

- Busca full-text em mensagens, chats, contatos, anexos, chamadas e arquivos.
- Resultados de busca exibem botoes para abrir caso, evidencia, extracao e contexto de analise em nova aba.
- Contatos e participantes de WhatsApp mostram telefone derivado de `phone`, `handle` ou `@s.whatsapp.net`.
- Mensagens mostram participantes, telefones/WhatsApp, anexos e transcricoes vinculadas.
- Audios `.opus` sem chat tambem sao transcritos e podem ser selecionados para entrar no relatorio final.
- Arquivos auditaveis podem ser filtrados por qualidade e usados no relatorio consolidado.
- Localizacoes mostram coordenadas, botao para Google Maps e download KML.
- Triagem de IA permite recuperar job em andamento e sincronizar barra com estado real da fila.

## Troubleshooting rapido

Se aparecer `Cannot GET /` ou a pagina nao abrir:

1. Garanta Node LTS 22 ativo (`node -v` deve retornar `v22.x`).
2. Rode apenas o web para validar primeiro: `npm run dev:web`.
3. Acesse `http://localhost:3001` (porta `3001`).
4. Se `3001` estiver ocupada, finalize o processo da porta e rode novamente.
