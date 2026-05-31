# Sprint 1 — Inventário Técnico-Funcional

## Objetivo

Registrar, de forma operacional, o estado atual do projeto para servir como base segura das próximas sprints.

Esta Sprint 1 cobre:

- inventário de módulos;
- inventário de rotas;
- inventário de entidades;
- inventário de serviços/pipelines;
- cobertura atual por requisito;
- lacunas, riscos e dependências;
- reaproveitamento do legado `IPED-ANALYZER-ATUALIZADO`.

---

## 1. Estrutura atual do projeto

## Apps

### `apps/web`

Responsável por:

- interface principal;
- APIs HTTP leves;
- navegação do dashboard;
- telas de casos, evidências, processamento, mensagens, análise, busca, timeline e relatórios.

### `apps/worker-ingest`

Responsável por:

- ingestão UFDR;
- leitura do container;
- busca e parsing de `report.xml`;
- persistência de domínio extraído;
- extração de arquivos de áudio;
- indexação de busca;
- atualização do progresso de extração.

### `apps/worker-ai`

Responsável por:

- transcrição local de áudio;
- OCR local;
- classificação IA;
- triagem investigativa;
- geração de relatório investigativo.

## Packages

### `packages/db`

- schema Prisma;
- migrations;
- client Prisma.

### `packages/cases`

- serviços de domínio de caso/evidência/extraction/custódia;
- persistência de OCR, IA e relatórios;
- lógica de análise investigativa por IA.

### `packages/pdf-processing`

- análise de PDF;
- detecção de OCR;
- detecção de páginas em branco;
- detecção de duplicidade;
- OCR seletivo.

### `packages/parsers`

- leitura e normalização de dados UFDR;
- parsing XML em memória e por stream;
- extração de arquivos internos.

### `packages/search`

- indexação;
- busca investigativa em OpenSearch.

### `packages/reports`

- esqueleto atual de builder de relatórios.

### `packages/storage`

- abstração de persistência de arquivos;
- driver local.

### `packages/queue`

- filas BullMQ;
- jobs de ingestão, OCR, transcrição e investigação.

### `packages/shared`

- schemas Zod;
- tipos compartilhados entre apps e workers.

---

## 2. Inventário de entidades atuais

## Entidades principais já existentes

- `User`
- `Case`
- `Evidence`
- `Extraction`
- `Device`
- `Artifact`
- `Chat`
- `Participant`
- `Message`
- `Attachment`
- `AudioTranscription`
- `CustodyEvent`
- `OcrDocument`
- `AiInsight`
- `GeneratedReport`
- `TimelineEvent`
- `Entity`
- `Link`
- `AnalystNote`
- `AuditLog`

## Leitura funcional dessas entidades

### `Case`

Já suporta:

- número do caso;
- título;
- descrição;
- tipo e número do inquérito;
- unidade policial;
- enquadramento legal;
- pessoas envolvidas;
- resumo, fatos e foco investigativo;
- resumo de relatório de extração.

### `Evidence`

Já suporta:

- vínculo com caso;
- arquivo físico;
- hash;
- uploader;
- vínculo com extraction.

### `Extraction`

Já suporta:

- status de processamento;
- formato de origem;
- relatório encontrado;
- progresso e detalhes do processamento;
- vínculo com `Device`, transcrições, OCR e IA.

### `Device`

Já suporta:

- fabricante;
- modelo;
- OS;
- IMEI;
- serial;
- metadata.

Limitação:

- ainda representa “dispositivo detectado na extração”, não “aparelho operacional do domínio investigativo”.

### `CustodyEvent`

Já suporta:

- trilha básica de ação;
- ator;
- hash;
- detalhes em JSON.

Limitação:

- ainda não está modelado como cadeia formal de custódia de produto.

### `TimelineEvent`

Já existe estruturalmente.

Limitação:

- quase não está sendo alimentado.

### `AiInsight`

Já suporta:

- insights de transcrição;
- contextualização de caso;
- triagem investigativa;
- relatórios investigativos.

### `GeneratedReport`

Já suporta:

- armazenamento persistido de relatórios em markdown/json.

## Entidades ausentes para o alvo funcional

- `CaseDocument`
- `CaseImportSession` / `CaseDraft`
- `ExpertReport`
- `SeizedObject`
- `DeviceMatch`
- `LocationEvent`

---

## 3. Inventário de rotas e telas atuais

## Dashboard / navegação atual

### Rotas principais

- `/dashboard`
- `/cases`
- `/cases/[id]`
- `/evidences`
- `/evidences/[id]`
- `/extractions`
- `/extractions/[id]`
- `/search`
- `/messages`
- `/investigation`
- `/timeline`
- `/custody`
- `/reports`
- `/graph`
- `/transcriptions`
- `/benchmark`

## Leitura funcional

### `Casos`

Atualmente:

- lista casos;
- exibe formulário de intake IA;
- exibe detalhe do caso;
- permite enriquecimento tardio por PDF.

### `Evidências`

Atualmente:

- concentra upload UFDR;
- concentra triagem de PDF;
- lista evidências;
- expõe ações operacionais por item.

### `Processamento`

Atualmente:

- mostra status das extrações;
- mostra diagnóstico operacional;
- acompanha progresso em tempo real.

### `Mensagens`

Atualmente:

- é o módulo mais maduro de visualização analítica;
- permite agrupamento por app;
- lista conversas;
- mostra mensagens e anexos.

### `Busca`

Atualmente:

- já faz full-text com filtros básicos.

### `Análise IA`

Atualmente:

- já faz triagem investigativa;
- já gera relatório investigativo;
- já exibe correlações.

### `Timeline`

Atualmente:

- apenas lista eventos `TimelineEvent`.

### `Custódia`

Atualmente:

- lista `CustodyEvent` em formato simples.

### `Relatórios`

Atualmente:

- lista relatórios gerados;
- cria relatório técnico inicial;
- recebe relatórios investigativos do pipeline de IA.

---

## 4. Inventário de APIs atuais

## Casos

- `POST /api/cases/intake`
- `POST /api/cases/[id]/enrich-pdf`
- `POST /api/cases/[id]/parse-ufdr-context`

## PDF

- `POST /api/pdf/import`
- `GET /api/pdf/processed`

## Evidências / UFDR

- `POST /api/upload-ufdr`
- `POST /api/import-ufdr-path`
- `POST /api/evidences/[id]/reprocess`
- `POST /api/evidences/[id]/retranscribe`
- `POST /api/evidences/[id]/relink`
- `POST /api/evidences/[id]/index-attachment-paths`
- `POST /api/evidences/[id]/delete`

## Extrações

- `GET /api/extractions/[id]/status`
- `GET /api/extractions/[id]/stream`

## Investigação

- `GET /api/investigation/triage`
- `POST /api/investigation/triage`
- `POST /api/investigation/report`
- `GET /api/investigation/jobs/[jobId]`

## Relatórios

- `POST /api/reports/generate`

## Conclusão

As APIs atuais já são fortes em:

- ingestão;
- processamento;
- busca;
- IA.

As lacunas estão em:

- criação manual de caso;
- sessão de importação por PDF;
- documentos do caso;
- laudo/aparelhos/objetos;
- localizações.

---

## 5. Inventário de pipelines atuais

## 5.1 Pipeline UFDR

### Situação

Implementado ponta a ponta.

### Etapas cobertas

- upload/import local;
- hash;
- storage;
- `Evidence` + `Extraction`;
- enqueue;
- scan do arquivo UFDR;
- parse do `report.xml`;
- persistência de chats/mensagens/anexos/artefatos;
- persistência do `Device`;
- enriquecimento contextual do caso a partir do UFDR;
- extração de áudio;
- criação de transcrições pendentes;
- classificação IA;
- indexação em OpenSearch.

### Avaliação

- **status:** maduro;
- **ação recomendada:** preservar e expandir só por acoplamento lateral.

## 5.2 Pipeline PDF

### Situação

Implementado parcialmente.

### Etapas cobertas

- upload de PDF;
- análise técnica;
- detecção de OCR;
- OCR seletivo;
- detecção de páginas em branco;
- detecção de duplicidade;
- extração textual posterior;
- contextualização de caso por IA.

### Limitação

- ainda não gera caso como rascunho revisável;
- hoje entra como triagem isolada ou enriquecimento de caso já existente.

## 5.3 Pipeline de transcrição

### Situação

Implementado.

### Etapas cobertas

- criação de jobs;
- Whisper local;
- persistência;
- classificação;
- vínculo com mensagens/anexos.

## 5.4 Pipeline de OCR documental

### Situação

Existe base operacional no worker AI e no módulo PDF.

### Limitação

- ainda não está acoplado a um módulo operacional de “documentos do caso”.

## 5.5 Pipeline de análise investigativa

### Situação

Implementado.

### Etapas cobertas

- triagem por IA;
- score de relevância;
- correlação entre chats;
- geração de relatório investigativo.

### Limitação

- navegação e UX ainda dispersas.

---

## 6. Cobertura atual por requisito funcional

## 6.1 Casos

### Criação manual

- **status:** ausente
- **observação:** hoje existe intake IA, não criação manual operacional.

### Criação por importação de PDF

- **status:** parcial
- **observação:** o PDF já é processado, mas não cria rascunho de caso revisável.

### Revisão humana dos dados extraídos

- **status:** ausente

### Campos mínimos operacionais

- **status:** parcial
- **observação:** os campos existem na entidade, mas a UX de entrada ainda não.

## 6.2 Evidências

### Cadastro e processamento de evidências

- **status:** implementado

### Vínculo com caso

- **status:** implementado

### Vínculo com laudo pericial

- **status:** ausente

### Match aparelho ↔ objeto apreendido

- **status:** ausente no monorepo atual
- **observação:** existe referência madura no legado IPED.

### Custódia

- **status:** parcial

### Cadeia de custódia formal

- **status:** parcial

## 6.3 Análise

### Buscas

- **status:** implementado

### Mensagens

- **status:** implementado

### Análise de IA

- **status:** implementado

### Timeline

- **status:** parcial

### Localizações

- **status:** ausente / estruturalmente insinuado

## 6.4 Relatórios

### Relatório técnico inicial

- **status:** implementado

### Relatório investigativo por IA

- **status:** implementado

### Relatório consolidado completo

- **status:** ausente

---

## 7. Reaproveitamento do legado IPED

## Itens úteis já localizados

### Inquérito

- parser de texto de inquérito;
- extração de tipificação, envolvidos, foco investigativo e fatos.

### Laudo pericial

- parser de laudo;
- parser específico de dispositivos extraídos do laudo;
- contexto de laudo para relatório.

### Match de dispositivo

- lógica de comparação por:
  - IMEI;
  - ICCID;
  - serial;
  - modelo;
  - tipo de extração.

## Conclusão de reaproveitamento

O legado deve ser reaproveitado de forma **cirúrgica**, especialmente em:

- `inquiry-parser`
- `laudo-parser`
- `laudo-device-parser`
- `device-match`

Não é recomendável portar a UI inteira do legado.

---

## 8. Riscos técnicos identificados

## Risco 1 — misturar documentos do caso com evidências forenses

### Impacto

- semântica ruim;
- relatórios inconsistentes;
- UX confusa.

### Mitigação

- criar `CaseDocument`.

## Risco 2 — reorganizar menus sem consolidar o domínio

### Impacto

- apenas “troca de nome de menu”, sem ganho real.

### Mitigação

- alinhar menu, rota, entidade e responsabilidade do serviço.

## Risco 3 — refatorar pipeline UFDR cedo demais

### Impacto

- quebra do núcleo mais maduro do sistema.

### Mitigação

- preservar `worker-ingest` e trabalhar por extensão lateral.

## Risco 4 — depender demais de IA no cadastro de caso

### Impacto

- fragilidade operacional;
- dificuldade de auditoria;
- baixa previsibilidade.

### Mitigação

- criação manual obrigatoriamente suportada.

## Risco 5 — timeline e localizações continuarem “embutidas em JSON”

### Impacto

- inviabiliza exploração analítica consistente.

### Mitigação

- criar modelos dedicados ou políticas claras de consolidação.

---

## 9. Dependências entre sprints

## Sprint 1 → Sprint 2

Necessário:

- inventário do que já existe;
- backlog de `Casos`;
- plano técnico inicial.

## Sprint 2 → Sprint 3

Necessário:

- `Case` operacional;
- documentos do caso;
- navegação de casos estável.

## Sprint 3 → Sprint 4

Necessário:

- reorganização de evidências;
- visão de aparelhos;
- base para laudo.

## Sprint 4 → Sprint 5/6/7

Necessário:

- match laudo ↔ aparelho ↔ objeto;
- domínio estabilizado para análise consolidada e relatório final.

---

## 10. Conclusão executiva da Sprint 1

### O que está pronto

- base de dados robusta;
- fluxo UFDR maduro;
- transcrição/OCR/IA operacionais;
- busca e mensagens utilizáveis;
- análise investigativa já funcional.

### O que está parcialmente pronto

- casos;
- PDF;
- timeline;
- custódia;
- relatórios.

### O que falta

- centralidade do módulo de casos;
- separação entre documento institucional e evidência;
- módulo de laudo;
- módulo de aparelhos;
- objeto apreendido;
- localizações;
- relatório consolidado final.

### Recomendação

Seguir imediatamente para:

- Sprint 2: `Casos`
- Sprint 3: `Evidências`
- Sprint 4: `Laudo + match de aparelho`

Sem refatorar o pipeline UFDR existente.
