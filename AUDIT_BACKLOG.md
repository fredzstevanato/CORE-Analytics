# CORE Analytics — Backlog Técnico-Funcional Inicial

## Objetivo desta etapa

Converter a auditoria do projeto em um backlog executável, incremental e seguro, preservando:

- o fluxo UFDR já funcional;
- os pipelines de processamento existentes;
- a base de análise por IA já presente;
- o reaproveitamento de lógica madura do `IPED-ANALYZER-ATUALIZADO`.

Esta etapa corresponde à **Sprint 1: auditoria técnica + inventário funcional**.

---

## 1. Estado atual consolidado

### 1.1 Núcleo já maduro e que deve ser preservado

#### Ingestão e evidências

- upload/importação de UFDR;
- criação de `Evidence` + `Extraction`;
- fila de ingestão;
- parsing de `report.xml`;
- persistência de chats, mensagens, anexos, artefatos e dispositivo extraído;
- extração de áudio + transcrição + classificação;
- indexação para busca;
- monitoramento de progresso;
- reprocessamento, retranscrição, relink e indexação de paths.

#### Análise já funcional

- busca full-text;
- visualização de mensagens;
- triagem investigativa por IA;
- correlação entre chats;
- geração de relatório investigativo;
- enriquecimento de contexto do caso por PDF e por metadados UFDR.

### 1.2 Núcleo existente, porém incompleto

#### Casos

- entidade `Case` rica;
- cadastro atual centrado em intake por IA;
- enriquecimento tardio por PDF;
- ausência de fluxo operacional completo de criação manual e rascunho por importação.

#### Custódia / timeline / relatórios

- entidades já existem;
- telas iniciais já existem;
- uso operacional ainda superficial;
- sem consolidação forte entre módulos.

### 1.3 Lacunas principais

- fluxo formal de criação de caso manual;
- fluxo de criação de caso por PDF com revisão humana antes da confirmação;
- módulo de laudo pericial;
- módulo de objetos apreendidos;
- módulo de aparelhos com visão operacional;
- match laudo ↔ aparelho ↔ objeto apreendido;
- timeline consolidada;
- localizações;
- relatório consolidado de caso.

---

## 2. Organização alvo de produto

## Menu principal proposto

- `Casos`
- `Evidências`
- `Análise`
- `Relatórios`

## Submenus propostos

### Casos

- `Lista`
- `Novo Caso`
- `Rascunhos`
- `Documentos do Caso`

### Evidências

- `Processamento`
- `Aparelhos`
- `Custódia`
- `Cadeia de Custódia`

### Análise

- `Buscas`
- `Mensagens`
- `Análise de IA`
- `Timeline`
- `Localizações`

### Relatórios

- `Relatórios Consolidados`

---

## 3. Backlog por módulo

## 3.1 Casos

### Meta

Transformar `Case` em entidade operacional central do produto.

### O que reaproveitar

- `packages/db/prisma/schema.prisma`
- `packages/cases/src/services.ts`
- `packages/cases/src/investigation.ts`
- `apps/web/app/(dashboard)/cases/page.tsx`
- `apps/web/app/(dashboard)/cases/[id]/page.tsx`
- `apps/web/app/api/cases/intake/route.ts`
- `apps/web/app/api/cases/[id]/enrich-pdf/route.ts`
- `apps/web/app/api/cases/[id]/parse-ufdr-context/route.ts`

### Entregas

#### C1. Fluxo manual de criação de caso

- criar formulário manual de caso;
- exigir campos mínimos:
  - título;
  - identificador do caso / IP;
  - tipificação;
  - unidade/origem;
  - contexto inicial para IA;
- manter edição posterior.

#### C2. Fluxo de criação de caso por PDF

- importar PDF do inquérito;
- executar pipeline de OCR/análise já existente;
- extrair dados estruturados;
- criar **rascunho de caso**;
- permitir revisão humana;
- somente depois confirmar criação final do caso.

#### C3. Estado operacional do caso

- expandir estados do caso para algo como:
  - `DRAFT`
  - `UNDER_REVIEW`
  - `ACTIVE`
  - `CLOSED`
  - `ARCHIVED`

#### C4. Documentos do caso

- separar documentos de contexto institucional do caso das evidências forenses;
- suportar PDF de inquérito, laudo, peças auxiliares e anexos de apoio.

### Mudanças de dados sugeridas

- expandir `Case`;
- criar `CaseDocument`;
- criar `CaseImportSession` ou `CaseDraft`.

### Riscos

- misturar evidência forense com documento de contexto;
- substituir o intake atual em vez de coexistir com ele na transição.

---

## 3.2 Evidências

### Meta

Reorganizar visualmente e semanticamente sem quebrar o pipeline UFDR.

### O que reaproveitar

- `apps/web/app/(dashboard)/evidences/page.tsx`
- `apps/web/app/(dashboard)/evidences/[id]/page.tsx`
- `apps/web/app/(dashboard)/extractions/page.tsx`
- `apps/web/app/(dashboard)/extractions/[id]/page.tsx`
- `apps/web/components/evidence-progress-list.tsx`
- `apps/web/components/ufdr-upload-form.tsx`
- `apps/worker-ingest/src/index.ts`
- `packages/cases/src/services.ts`

### Entregas

#### E1. Separação visual entre catálogo e processamento

- `Evidências` vira catálogo principal;
- `Processamento` passa a ser submódulo operacional;
- tela de extrações deixa de ser “módulo isolado” e passa a ser etapa do fluxo de evidências.

#### E2. Módulo de aparelhos

- listar dispositivos detectados por extração;
- exibir fabricante, modelo, IMEI, serial, origem da extração;
- preparar vínculo com laudo e objeto apreendido.

#### E3. Custódia e cadeia de custódia

- diferenciar:
  - custódia atual do item;
  - histórico cronológico formal;
- enriquecer `CustodyEvent` com tipo, responsável, local e observação.

#### E4. Tipologia de evidência

- classificar evidências por tipo:
  - UFDR;
  - PDF de inquérito;
  - laudo pericial;
  - mídia/anexo bruto;
  - documento complementar.

### Mudanças de dados sugeridas

- expandir `Evidence`;
- expandir `CustodyEvent`;
- criar visão operacional de `Device`.

### Riscos

- UI acoplada demais ao conceito técnico de extraction;
- nomenclatura atual confundir analista final.

---

## 3.3 Laudo pericial / objetos apreendidos / match de aparelho

### Meta

Portar o que já existe no IPED legado e integrar ao modelo atual.

### Fontes legadas relevantes

- `IPED-ANALYZER-ATUALIZADO/lib/laudo-parser.ts`
- `IPED-ANALYZER-ATUALIZADO/lib/laudo-device-parser.ts`
- `IPED-ANALYZER-ATUALIZADO/lib/device-match.ts`
- `IPED-ANALYZER-ATUALIZADO/lib/inquiry-parser.ts`

### Entregas

#### L1. Parser de laudo pericial

- extrair:
  - número do laudo;
  - protocolo;
  - autoridade;
  - referência/IP;
  - natureza;
  - data;
  - destino;
  - resumo técnico;
  - dispositivos citados;
  - hashes citados.

#### L2. Objetos apreendidos

- modelar itens apreendidos por caso;
- permitir vínculo com laudo;
- permitir vínculo com aparelho detectado pela extração.

#### L3. Match laudo ↔ aparelho

- comparar IMEI, ICCID, serial, modelo e tipo de extração;
- registrar:
  - rótulo do dispositivo compatível;
  - grau de confiança;
  - fundamentação do vínculo.

### Mudanças de dados sugeridas

- criar `ExpertReport`;
- criar `SeizedObject`;
- criar `DeviceMatch` ou expandir `Device`/`Extraction` com campos auditáveis de match.

### Riscos

- tentar integrar o legado inteiro;
- não diferenciar parsing heurístico de confirmação humana.

---

## 3.4 Análise

### Meta

Organizar navegação e responsabilidades sem reescrever a lógica já pronta.

### O que reaproveitar

- `apps/web/app/(dashboard)/search/page.tsx`
- `apps/web/app/(dashboard)/messages/page.tsx`
- `apps/web/app/(dashboard)/investigation/page.tsx`
- `apps/web/components/investigation-module.tsx`
- `packages/cases/src/investigation.ts`
- `packages/search/src/search.ts`
- `packages/search/src/indexer.ts`

### Entregas

#### A1. Busca como ponto de consulta transversal

- filtros unificados por:
  - caso;
  - evidência;
  - aparelho;
  - período;
  - origem;
  - tipo de conteúdo.

#### A2. Mensagens como workspace principal

- manter o console atual;
- adicionar filtros por caso/evidência/aparelho;
- reforçar agrupamentos por conversa/app/participante/data.

#### A3. Análise de IA mais previsível

- separar claramente:
  - triagem;
  - correlação;
  - seleção de achados;
  - geração de relatório.

#### A4. Separação entre processamento e visualização

- nada de misturar jobs/filas com experiência de leitura analítica;
- o módulo de análise deve consumir dados já prontos.

### Mudanças sugeridas

- nova organização de rotas;
- componentes compartilhados de filtro, contexto do caso e breadcrumbs.

### Riscos

- reorganizar páginas sem manter atalhos e compatibilidade;
- criar módulos paralelos em vez de consolidar os já existentes.

---

## 3.5 Timeline

### Meta

Transformar `TimelineEvent` em consolidado confiável de eventos relevantes.

### O que reaproveitar

- entidade `TimelineEvent`;
- tela inicial `apps/web/app/(dashboard)/timeline/page.tsx`.

### Entregas

- definir categorias de timeline;
- alimentar eventos de:
  - mensagens relevantes;
  - extrações;
  - eventos de custódia;
  - OCR/transcrição;
  - referências temporais detectadas;
- permitir filtros por caso/evidência/aparelho.

### Riscos

- timeline vazia ou redundante se cada pipeline escrever eventos sem política comum.

---

## 3.6 Localizações

### Meta

Criar módulo próprio de geodados sem depender de grande refatoração inicial.

### Base existente

- `ArtifactType.LOCATION` já existe no schema;
- não há ainda pipeline/tela operacional real.

### Entregas

- criar estrutura de localização;
- suportar leitura inicial de coordenadas oriundas da extração;
- correlacionar localização com mensagens e timeline.

### Mudanças sugeridas

- criar `LocationEvent` ou expandir `Artifact` com visualização dedicada.

### Riscos

- manter localização “escondida” em JSON genérico e inviabilizar uso analítico.

---

## 3.7 Relatórios

### Meta

Consolidar relatório final de caso com base na arquitetura já existente.

### O que reaproveitar

- `GeneratedReport`;
- `packages/cases/src/investigation.ts`;
- `apps/web/app/api/reports/generate/route.ts`;
- `packages/reports/src/index.ts`.

### Entregas

#### R1. Tipos de relatório

- relatório investigativo por IA;
- relatório técnico consolidado do caso;
- relatório resumido operacional.

#### R2. Builder consolidado

- caso;
- documentos do caso;
- evidências;
- aparelhos;
- laudo;
- cadeia de custódia;
- triagem e achados;
- timeline;
- localizações.

#### R3. Snapshot de geração

- registrar versão do template;
- filtros aplicados;
- entidades incluídas;
- usuário autor;
- data/hora.

### Riscos

- gerar relatório antes de estabilizar dados de laudo/aparelho/timeline.

---

## 4. Backlog por entidades

## Criar

- `CaseDocument`
- `CaseDraft` ou `CaseImportSession`
- `ExpertReport`
- `SeizedObject`
- `DeviceMatch`
- `LocationEvent`

## Expandir

- `Case`
- `Evidence`
- `Device`
- `CustodyEvent`
- `TimelineEvent`
- `GeneratedReport`

## Preservar como base

- `Extraction`
- `Chat`
- `Message`
- `Attachment`
- `AudioTranscription`
- `AiInsight`

---

## 5. Ordem incremental recomendada

### Fase 1

- fechar arquitetura de `Casos`;
- adicionar documentos de caso e rascunho de importação;
- reorganizar menu e rotas sem mudar pipeline.

### Fase 2

- reorganizar `Evidências`;
- criar visão de `Aparelhos`;
- enriquecer `Custódia`.

### Fase 3

- integrar `LaudoPericial`, `ObjetoApreendido` e `DeviceMatch`;
- portar lógica útil do IPED legado.

### Fase 4

- consolidar `Análise`, `Timeline` e `Localizações`.

### Fase 5

- construir `Relatórios Consolidados`.

---

## 6. Arquivos-base prioritários para a próxima etapa

## Banco / domínio

- `packages/db/prisma/schema.prisma`
- `packages/cases/src/services.ts`
- `packages/cases/src/investigation.ts`

## PDF / parsing

- `packages/pdf-processing/src/services/pdf-import-pipeline.ts`
- `packages/parsers/src/ufdr-report-parser.ts`

## Web / navegação

- `apps/web/components/sidebar.tsx`
- `apps/web/app/(dashboard)/cases/page.tsx`
- `apps/web/app/(dashboard)/cases/[id]/page.tsx`
- `apps/web/app/(dashboard)/evidences/page.tsx`
- `apps/web/app/(dashboard)/extractions/page.tsx`
- `apps/web/app/(dashboard)/investigation/page.tsx`
- `apps/web/app/(dashboard)/reports/page.tsx`

## Legado IPED a reaproveitar

- `IPED-ANALYZER-ATUALIZADO/lib/laudo-parser.ts`
- `IPED-ANALYZER-ATUALIZADO/lib/laudo-device-parser.ts`
- `IPED-ANALYZER-ATUALIZADO/lib/device-match.ts`
- `IPED-ANALYZER-ATUALIZADO/lib/inquiry-parser.ts`

---

## 7. Próximo passo recomendado

Na próxima etapa, detalhar a **Sprint 2: módulo de casos** com:

- proposta final de entidades;
- campos mínimos;
- estados;
- fluxo de telas;
- rotas;
- serviços;
- impacto por arquivo.

---

## 8. Sprint 2 detalhada — Módulo de Casos

## 8.1 Objetivo da sprint

Entregar um módulo de `Casos` operacional, com duas portas de entrada:

- criação manual;
- criação por importação de PDF.

Sem quebrar:

- o intake atual por IA;
- o enriquecimento tardio por PDF;
- o pipeline de PDF já implementado;
- o vínculo atual entre caso e evidências.

---

## 8.2 Resultado esperado ao final da sprint

Ao final da Sprint 2, o sistema deve permitir:

- criar caso manualmente com campos mínimos;
- importar PDF do inquérito para gerar um rascunho;
- revisar e editar os dados extraídos;
- confirmar o caso somente após revisão humana;
- anexar documentos institucionais do caso;
- manter compatibilidade com o fluxo atual de `intake IA`.

---

## 8.3 Decisões de arquitetura

## Manter

- `Case` como entidade central;
- `apps/web/app/(dashboard)/cases/page.tsx` como entrada principal;
- `apps/web/app/(dashboard)/cases/[id]/page.tsx` como detalhe;
- `runPdfImportPipeline` como pipeline técnico de PDF;
- `enrichCaseContextFromPdf` como base de extração contextual.

## Adicionar

- camada de rascunho para importação por PDF;
- documentos do caso separados da evidência forense;
- estado operacional explícito para o caso;
- API própria de criação manual.

## Não fazer nesta sprint

- integrar laudo pericial;
- modelar aparelho ↔ objeto apreendido;
- refatorar o worker UFDR;
- substituir o fluxo atual de evidências.

---

## 8.4 Modelo de dados proposto

## 8.4.1 Expansão de `Case`

### Novos campos sugeridos

- `sourceType`
  - valores sugeridos:
    - `MANUAL`
    - `PDF_IMPORT`
    - `AI_INTAKE`
    - `UFDR_CONTEXT`
- `operationalStatus`
  - valores sugeridos:
    - `DRAFT`
    - `UNDER_REVIEW`
    - `ACTIVE`
    - `CLOSED`
    - `ARCHIVED`
- `initialContextSource`
  - origem do contexto inicial da IA;
- `reviewedAt`
- `reviewedById`

### Observação

O `status` atual pode ser mantido por compatibilidade. O novo estado operacional pode coexistir temporariamente.

## 8.4.2 Nova entidade `CaseDocument`

### Finalidade

Separar documento institucional do caso de evidência forense.

### Campos sugeridos

- `id`
- `caseId`
- `type`
  - `INQUIRY_PDF`
  - `EXPERT_REPORT_PDF`
  - `SUPPORTING_DOCUMENT`
  - `CASE_NOTE_ATTACHMENT`
- `title`
- `fileName`
- `mimeType`
- `storagePath`
- `sizeBytes`
- `sha256`
- `source`
- `uploadedById`
- `createdAt`
- `metadata`

### Benefício

Evita tratar PDF do inquérito como `Evidence`, preservando semântica.

## 8.4.3 Nova entidade `CaseImportSession`

### Finalidade

Representar o rascunho de criação do caso por PDF antes da confirmação.

### Campos sugeridos

- `id`
- `sourceType`
  - `PDF_IMPORT`
- `status`
  - `PENDING_ANALYSIS`
  - `READY_FOR_REVIEW`
  - `CONFIRMED`
  - `DISCARDED`
  - `FAILED`
- `draftPayload`
  - campos extraídos do PDF;
- `pipelineSummary`
  - OCR, páginas em branco, duplicidade, warnings;
- `documentId`
  - FK para `CaseDocument`;
- `createdCaseId`
  - FK opcional após confirmação;
- `createdById`
- `createdAt`
- `updatedAt`

### Benefício

Permite revisão humana sem gravar caso definitivo cedo demais.

---

## 8.5 Campos mínimos da criação manual

## Obrigatórios

- `title`
- `caseNumber` ou `internalIdentifier`
- `inquiryLegalFraming`
- `policeUnit`
- `inquirySummaryText` ou `inquiryInvestigativeFocus`

## Recomendados

- `inquiryType`
- `inquiryNumber`
- `inquiryMainFacts`
- `description`
- `inquiryInvolvedPeople`

## Regra de UX

Se o usuário não tiver `inquiryNumber`, deve conseguir salvar com identificador interno temporário controlado pelo sistema.

---

## 8.6 Fluxo funcional proposto

## 8.6.1 Fluxo manual

### Tela: `Casos > Novo Caso`

#### Etapa 1 — dados mínimos

- título;
- número do IP / identificador;
- tipificação;
- unidade/origem;
- contexto inicial.

#### Etapa 2 — dados complementares

- envolvidos;
- fatos principais;
- foco investigativo;
- observações.

#### Etapa 3 — confirmação

- salvar como `ACTIVE` ou `UNDER_REVIEW`, conforme perfil/decisão de produto.

## 8.6.2 Fluxo por PDF

### Tela: `Casos > Novo Caso > Importar PDF`

#### Etapa 1 — upload

- receber PDF;
- armazenar como `CaseDocument`;
- rodar análise técnica do PDF.

#### Etapa 2 — processamento

- verificar OCR;
- OCRizar páginas quando necessário;
- detectar páginas em branco;
- detectar páginas duplicadas;
- extrair texto consolidado.

#### Etapa 3 — extração de dados

- usar parser contextual existente;
- preencher `draftPayload` com:
  - título;
  - número;
  - tipificação;
  - unidade;
  - resumo;
  - fatos;
  - foco;
  - envolvidos;
  - objetos citados quando possível.

#### Etapa 4 — revisão humana

- mostrar:
  - campos extraídos;
  - resumo do pipeline;
  - warnings;
  - páginas problemáticas;
- permitir:
  - editar;
  - remover;
  - complementar;
  - confirmar criação.

#### Etapa 5 — confirmação

- criar `Case`;
- ligar `CaseImportSession.createdCaseId`;
- manter o documento vinculado ao caso;
- registrar log/auditoria.

---

## 8.7 Estados do caso e transições

## Estados propostos

- `DRAFT`
- `UNDER_REVIEW`
- `ACTIVE`
- `CLOSED`
- `ARCHIVED`

## Transições

- manual novo → `ACTIVE` ou `UNDER_REVIEW`
- PDF importado → `DRAFT`
- revisado por humano → `UNDER_REVIEW`
- confirmado → `ACTIVE`
- encerrado → `CLOSED`
- descontinuado/inativo → `ARCHIVED`

## Regras

- caso em `DRAFT` não deve aparecer como caso operacional principal;
- caso `ACTIVE` já pode receber evidências;
- import session descartada não gera `Case`.

---

## 8.8 Rotas sugeridas

## Web

### Novas páginas

- `apps/web/app/(dashboard)/cases/new/page.tsx`
- `apps/web/app/(dashboard)/cases/import/page.tsx`
- `apps/web/app/(dashboard)/cases/import/[sessionId]/page.tsx`
- `apps/web/app/(dashboard)/cases/[id]/documents/page.tsx`

### Páginas a adaptar

- `apps/web/app/(dashboard)/cases/page.tsx`
- `apps/web/app/(dashboard)/cases/[id]/page.tsx`

## API

### Novas rotas

- `apps/web/app/api/cases/create/route.ts`
- `apps/web/app/api/cases/import-pdf/route.ts`
- `apps/web/app/api/cases/import-pdf/[sessionId]/route.ts`
- `apps/web/app/api/cases/import-pdf/[sessionId]/confirm/route.ts`
- `apps/web/app/api/cases/[id]/documents/route.ts`

### Rotas existentes que permanecem

- `apps/web/app/api/cases/intake/route.ts`
- `apps/web/app/api/cases/[id]/enrich-pdf/route.ts`
- `apps/web/app/api/cases/[id]/parse-ufdr-context/route.ts`

---

## 8.9 Serviços sugeridos

## Em `packages/cases/src/services.ts`

### Novas funções

- `createManualCase`
- `createCaseDocument`
- `createCaseImportSession`
- `updateCaseImportSession`
- `confirmCaseImportSession`
- `listCaseDocuments`
- `getCaseImportSessionById`

### Funções existentes a reutilizar

- `createCase`
- `enrichCaseContextFromUfdrMetadata`
- `addCustodyEvent`
- `createAiInsight`

## Em `packages/cases/src/investigation.ts`

### Reutilizar

- `enrichCaseContextFromPdf`

### Ajustar

- permitir que a extração de contexto para PDF seja usada também para montar `draftPayload`, sem criar caso final diretamente.

## Em `packages/pdf-processing`

### Reutilizar sem refatorar

- `runPdfImportPipeline`
- `PdfAnalysisService`
- `PdfOcrService`

---

## 8.10 Validações

## Criação manual

- título mínimo;
- identificador mínimo;
- tipificação obrigatória;
- unidade/origem obrigatória se o sistema já usa esse padrão;
- contexto inicial com tamanho mínimo.

## Importação por PDF

- aceitar apenas PDF;
- barrar confirmação se a sessão ainda estiver `PENDING_ANALYSIS`;
- permitir confirmação mesmo com warnings, mas exigir revisão humana;
- se texto extraído for insuficiente, manter sessão em `FAILED` ou `READY_FOR_REVIEW` com baixa confiança, conforme implementação.

## Consistência

- `caseNumber` deve continuar único;
- `CaseImportSession` confirmada não pode ser confirmada novamente;
- `CaseDocument` precisa sempre apontar para arquivo válido no storage.

---

## 8.11 Proposta de UX

## Página de casos

Substituir a experiência atual de “apenas intake IA” por três CTAs claros:

- `Novo caso manual`
- `Importar PDF do inquérito`
- `Usar intake IA legado`

## Página de revisão do rascunho

Blocos visuais:

- resumo do documento;
- resultado técnico do pipeline;
- dados extraídos;
- dados complementares editáveis;
- ações:
  - confirmar;
  - salvar e continuar depois;
  - descartar.

## Página do caso

Separar em abas ou blocos:

- resumo;
- dados do inquérito;
- documentos do caso;
- evidências vinculadas;
- próximos passos.

---

## 8.12 Backlog técnico por arquivo

## Banco

### `packages/db/prisma/schema.prisma`

#### Alterar

- expandir `Case`;
- criar `CaseDocument`;
- criar `CaseImportSession`.

#### Impacto

- novas migrations;
- atualização do client Prisma.

## Serviços de domínio

### `packages/cases/src/services.ts`

#### Alterar

- adicionar CRUD e confirmação de sessão de importação;
- adicionar CRUD de documentos do caso;
- separar criação manual do `createCase` genérico.

### `packages/cases/src/investigation.ts`

#### Alterar

- reutilizar extração contextual do PDF para `CaseImportSession`.

## Web

### `apps/web/components/sidebar.tsx`

#### Alterar

- reorganizar entrada de `Casos`.

### `apps/web/app/(dashboard)/cases/page.tsx`

#### Alterar

- converter para landing operacional de casos;
- manter acesso ao fluxo legado de intake.

### `apps/web/app/(dashboard)/cases/[id]/page.tsx`

#### Alterar

- incluir documentos do caso;
- separar melhor resumo e contexto.

### Novos componentes sugeridos

- `apps/web/components/case-manual-form.tsx`
- `apps/web/components/case-import-session-review.tsx`
- `apps/web/components/case-documents-panel.tsx`
- `apps/web/components/case-entry-actions.tsx`

## APIs

### Criar

- `apps/web/app/api/cases/create/route.ts`
- `apps/web/app/api/cases/import-pdf/route.ts`
- `apps/web/app/api/cases/import-pdf/[sessionId]/route.ts`
- `apps/web/app/api/cases/import-pdf/[sessionId]/confirm/route.ts`
- `apps/web/app/api/cases/[id]/documents/route.ts`

### Adaptar

- `apps/web/app/api/cases/intake/route.ts`
  - manter, mas reposicionar como fluxo legado;
- `apps/web/app/api/cases/[id]/enrich-pdf/route.ts`
  - manter como enriquecimento tardio de caso existente.

---

## 8.13 Critérios de aceite da sprint

- usuário cria caso manual sem depender de IA;
- usuário importa PDF e obtém rascunho revisável;
- dados extraídos podem ser corrigidos antes da confirmação;
- caso confirmado aparece normalmente em `/cases`;
- documento do caso fica vinculado ao caso;
- fluxo antigo de intake IA continua funcional;
- enriquecimento tardio por PDF continua funcional.

---

## 8.14 Riscos e mitigação

## Risco 1 — duplicar lógica de criação de caso

### Mitigação

- centralizar persistência final em serviço único;
- usar novos fluxos apenas como orquestração.

## Risco 2 — tratar documento do caso como evidência

### Mitigação

- criar `CaseDocument`;
- usar `Evidence` apenas para fluxo forense.

## Risco 3 — quebrar UX atual

### Mitigação

- manter intake IA existente como opção secundária;
- reorganizar, não remover.

## Risco 4 — acoplar demais o rascunho ao caso final

### Mitigação

- sessão de importação independente até confirmação.

---

## 8.15 Ordem de implementação da Sprint 2

### Etapa 1

- modelar schema;
- criar migrations;
- atualizar serviços de domínio.

### Etapa 2

- criar APIs novas;
- manter compatibilidade das rotas legadas.

### Etapa 3

- criar telas/componentes do fluxo manual;
- criar telas/componentes do fluxo por PDF.

### Etapa 4

- adaptar listagem e detalhe do caso;
- encaixar documentos do caso.

### Etapa 5

- validar ponta a ponta:
  - manual;
  - PDF import;
  - fluxo legado.

---

## 9. Sprint 2 — Plano técnico por arquivo

## 9.1 Estratégia de execução

Implementar em quatro camadas, nesta ordem:

- **camada 1: banco e domínio**
- **camada 2: APIs**
- **camada 3: UI**
- **camada 4: validação e compatibilidade**

Motivo:

- reduz risco de retrabalho;
- evita criar UI sem serviços prontos;
- preserva os fluxos já existentes enquanto os novos entram em paralelo.

---

## 9.2 Camada 1 — banco e domínio

## Arquivo: `packages/db/prisma/schema.prisma`

### Mudanças

#### Expandir `Case`

- adicionar `sourceType`;
- adicionar `operationalStatus`;
- adicionar `initialContextSource`;
- adicionar `reviewedAt`;
- adicionar `reviewedById`.

#### Criar `CaseDocument`

- FK para `Case`;
- metadados de arquivo;
- tipo do documento;
- origem do upload/importação.

#### Criar `CaseImportSession`

- status da sessão;
- payload bruto/draft extraído;
- resumo do pipeline PDF;
- referência para `CaseDocument`;
- referência opcional para `Case` após confirmação.

### Observações de implementação

- manter `Case.status` atual por compatibilidade;
- o novo `operationalStatus` deve ser a referência da UI nova;
- usar enums novos para evitar string solta.

### Saídas esperadas

- migration Prisma nova;
- client Prisma regenerado.

## Arquivo: `packages/cases/src/services.ts`

### Mudanças

#### Criar serviço de criação manual

- `createManualCase(input)`
- internamente pode chamar `createCase`, mas com regras de negócio próprias.

#### Criar serviços de documentos

- `createCaseDocument(input)`
- `listCaseDocuments(caseId)`
- `getCaseDocumentById(id)`

#### Criar serviços de sessão de importação

- `createCaseImportSession(input)`
- `updateCaseImportSessionDraft(input)`
- `markCaseImportSessionReady(input)`
- `markCaseImportSessionFailed(input)`
- `confirmCaseImportSession(input)`
- `discardCaseImportSession(input)`
- `getCaseImportSessionById(id)`

#### Criar consultas de listagem

- `listCaseImportSessions(status?)`
- opção para exibir rascunhos recentes na UI.

### Observações de implementação

- a persistência final do caso deve continuar centralizada;
- `confirmCaseImportSession` deve ser transacional;
- a confirmação deve:
  - criar `Case`;
  - vincular o documento;
  - atualizar a sessão;
  - registrar auditoria/custódia lógica.

## Arquivo: `packages/cases/src/index.ts`

### Mudanças

- exportar os novos serviços do módulo de casos.

## Arquivo: `packages/cases/src/investigation.ts`

### Mudanças

#### Reaproveitar a extração de contexto por PDF

- criar função auxiliar separada da atualização direta do caso;
- sugestão:
  - `extractCaseContextFromPdfText(...)`
- `enrichCaseContextFromPdf(...)` passa a reutilizar essa função.

### Benefício

- o mesmo parsing serve para:
  - rascunho de importação;
  - enriquecimento tardio de caso existente.

---

## 9.3 Camada 2 — APIs

## Arquivo novo: `apps/web/app/api/cases/create/route.ts`

### Responsabilidade

- receber payload do cadastro manual;
- validar dados mínimos;
- criar caso manual;
- retornar `caseId`.

### Regras

- não usar OpenAI;
- gerar identificador fallback quando necessário;
- marcar `sourceType = MANUAL`.

## Arquivo novo: `apps/web/app/api/cases/import-pdf/route.ts`

### Responsabilidade

- receber PDF;
- salvar documento como `CaseDocument` ainda sem caso definitivo;
- rodar `runPdfImportPipeline`;
- extrair texto útil;
- montar `draftPayload`;
- criar `CaseImportSession`;
- retornar `sessionId`.

### Regras

- se a análise falhar, a sessão deve ficar `FAILED`;
- se a análise for parcial, a sessão pode ficar `READY_FOR_REVIEW` com warnings;
- não criar `Case` definitivo nesta etapa.

## Arquivo novo: `apps/web/app/api/cases/import-pdf/[sessionId]/route.ts`

### Responsabilidade

- buscar detalhes da sessão;
- opcionalmente atualizar draft editado.

### Uso

- base da tela de revisão humana.

## Arquivo novo: `apps/web/app/api/cases/import-pdf/[sessionId]/confirm/route.ts`

### Responsabilidade

- confirmar o rascunho;
- criar o caso final;
- vincular documento;
- mudar sessão para `CONFIRMED`.

### Regras

- confirmar apenas sessão `READY_FOR_REVIEW`;
- impedir dupla confirmação;
- registrar ação de auditoria.

## Arquivo novo: `apps/web/app/api/cases/[id]/documents/route.ts`

### Responsabilidade

- listar documentos do caso;
- suportar upload complementar depois que o caso já existe.

## Arquivo existente: `apps/web/app/api/cases/intake/route.ts`

### Mudanças

- nenhuma mudança funcional obrigatória nesta fase;
- apenas documentar como “fluxo legado/assistido por IA”.

## Arquivo existente: `apps/web/app/api/cases/[id]/enrich-pdf/route.ts`

### Mudanças

- preservar comportamento atual;
- futuramente reutilizar helper compartilhado de parsing do PDF.

---

## 9.4 Camada 3 — UI

## Arquivo: `apps/web/components/sidebar.tsx`

### Mudanças

- reorganizar `Casos` como módulo principal;
- preparar subrotas futuras, mesmo que inicialmente sem menu colapsável completo.

## Arquivo: `apps/web/app/(dashboard)/cases/page.tsx`

### Mudanças

- transformar a página em landing do módulo;
- incluir três ações principais:
  - novo caso manual;
  - importar PDF;
  - intake IA legado;
- manter listagem de casos abaixo.

## Arquivo novo: `apps/web/app/(dashboard)/cases/new/page.tsx`

### Responsabilidade

- tela de criação manual do caso.

## Arquivo novo: `apps/web/components/case-manual-form.tsx`

### Responsabilidade

- formulário manual;
- validação de UX;
- submissão para `/api/cases/create`.

## Arquivo novo: `apps/web/app/(dashboard)/cases/import/page.tsx`

### Responsabilidade

- tela de upload do PDF para criação de caso.

## Arquivo novo: `apps/web/components/case-pdf-import-form.tsx`

### Responsabilidade

- upload do PDF;
- exibir progresso;
- chamar `/api/cases/import-pdf`;
- redirecionar para tela de revisão da sessão.

## Arquivo novo: `apps/web/app/(dashboard)/cases/import/[sessionId]/page.tsx`

### Responsabilidade

- tela de revisão do rascunho.

## Arquivo novo: `apps/web/components/case-import-session-review.tsx`

### Responsabilidade

- mostrar:
  - resumo do pipeline;
  - warnings;
  - dados extraídos;
  - campos editáveis;
- confirmar ou descartar sessão.

## Arquivo: `apps/web/app/(dashboard)/cases/[id]/page.tsx`

### Mudanças

- incluir bloco/aba de documentos do caso;
- apresentar origem do caso e estado operacional;
- separar melhor:
  - resumo;
  - contexto do inquérito;
  - documentos;
  - evidências vinculadas.

## Arquivo novo: `apps/web/components/case-documents-panel.tsx`

### Responsabilidade

- listar documentos do caso;
- permitir anexar documentos complementares.

## Arquivo existente: `apps/web/components/case-intake-form.tsx`

### Mudanças

- manter como fluxo legado;
- opcionalmente renomear visualmente para “Intake IA assistido”.

---

## 9.5 Camada 4 — compatibilidade e validação

## Compatibilidade obrigatória

- `/cases` continua funcionando;
- `/cases/[id]` continua funcionando;
- `/api/cases/intake` continua funcionando;
- `/api/cases/[id]/enrich-pdf` continua funcionando.

## Regras de rollout

- novo fluxo entra em paralelo;
- legado só perde protagonismo visual;
- nada de remover comportamento antigo nesta sprint.

---

## 9.6 Sequência de implementação sugerida

## Passo 1 — schema

### Arquivos

- `packages/db/prisma/schema.prisma`

### Entrega

- novos models e enums definidos.

## Passo 2 — migration + client

### Ações

- gerar migration;
- regenerar Prisma client.

## Passo 3 — serviços de domínio

### Arquivos

- `packages/cases/src/services.ts`
- `packages/cases/src/index.ts`
- `packages/cases/src/investigation.ts`

### Entrega

- serviços novos prontos para API.

## Passo 4 — APIs

### Arquivos

- criar rotas novas de `create`, `import-pdf`, `confirm`, `documents`.

### Entrega

- backend completo da Sprint 2.

## Passo 5 — páginas e componentes

### Arquivos

- `apps/web/app/(dashboard)/cases/page.tsx`
- novas páginas `new`, `import`, `import/[sessionId]`
- componentes novos do módulo.

### Entrega

- fluxo manual e por PDF navegáveis.

## Passo 6 — detalhe do caso

### Arquivos

- `apps/web/app/(dashboard)/cases/[id]/page.tsx`
- `apps/web/components/case-documents-panel.tsx`

### Entrega

- caso passa a exibir documentos e estado operacional.

## Passo 7 — refinamento de UX

### Ajustes

- nomenclatura;
- mensagens de erro;
- CTAs;
- fallback para warnings do PDF.

---

## 9.7 Checklist técnico de validação

## Banco

- migration aplica sem conflito;
- client Prisma compila;
- novos relacionamentos funcionam.

## Backend

- criação manual persiste caso corretamente;
- importação por PDF cria sessão, não caso final;
- confirmação da sessão cria caso apenas uma vez;
- documentos vinculam corretamente ao caso.

## Frontend

- `/cases/new` salva corretamente;
- `/cases/import` redireciona para revisão;
- tela de revisão permite editar e confirmar;
- `/cases/[id]` mostra documentos.

## Compatibilidade

- `CaseIntakeForm` ainda cria caso;
- enriquecimento tardio por PDF continua operacional.

---

## 9.8 Critério para iniciar implementação

Quando começarmos a codar, a ordem recomendada é:

1. `schema.prisma`
2. migration/client Prisma
3. `packages/cases/src/services.ts`
4. `packages/cases/src/investigation.ts`
5. APIs novas
6. componentes/páginas novas
7. ajuste de `cases/page.tsx` e `cases/[id]/page.tsx`

Essa é a ordem de menor risco para começar a implementar sem quebrar os fluxos maduros do projeto.
