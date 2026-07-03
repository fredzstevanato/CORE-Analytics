# Tutorial do CORE Analytics

## 1. Para que o programa serve
O **CORE Analytics** e uma plataforma de analise forense de dados extraidos de celular (UFDR/Cellebrite), focada em:

- importar evidencias UFDR por caso
- organizar chats, mensagens, anexos, transcricoes e metadados de aparelho
- enriquecer dados (dispositivo, contas, geolocalizacao, timeline)
- executar analise investigativa com IA (triagem e relatorio)
- manter trilha de custodia e auditoria das acoes

## 2. Fluxo de uso (visao rapida)
1. Criar/selecionar um **Caso**
2. Ir em **Evidencias > Visao Geral**
3. Fazer upload/importar arquivo **.ufdr** vinculando ao caso
4. Acompanhar processamento em **Evidencias > Processamento**
5. Usar botoes por evidencia:
   - `Enriquecer Metadados`
   - `Recalcular Vinculos`
   - `Indexar Caminhos de Anexos`
   - `Reprocessar Completo` (sem transcricao)
   - `Reprocessar so Transcricoes`
6. Revisar em:
   - **Aparelhos**
   - **Contas**
   - **Mensagens**
   - **Arquivos**
   - **Audios**
   - **Timeline**
   - **Localizacoes**
   - **Buscas**
7. Rodar IA em **Analise > Analise de IA**
8. Gerar relatorios em **Relatorios**

## 3. Passo a passo detalhado

### 3.1 Configuracoes iniciais
Em **Administracao > Configuracoes**:
- cadastrar `OPENAI_API_KEY` (fica criptografada no banco)
- ajustar modelos padrao, se necessario

Importante:
- a chave de IA vem do banco para os fluxos de analise/transcricao online

### 3.2 Criar e organizar casos
Em **Casos**:
- crie o caso do inquerito
- um caso pode ter varias UFDRs (varios itens apreendidos)

### 3.3 Importar UFDR
Em **Evidencias > Visao Geral**:
- upload de `.ufdr` ou importacao por caminho local
- sempre selecionar o caso correto

Apos importar:
- ingestao/parsing e executado
- transcricao nao e forcada no reprocesso completo (fluxo separado)

### 3.4 Entender os botoes da evidencia
- `Enriquecer Metadados`:
  atualiza dados de aparelho/contas/localizacao/timeline sem mexer em chats/transcricoes
- `Recalcular Vinculos`:
  reconecta anexos de audio as mensagens
- `Indexar Caminhos de Anexos`:
  melhora resolucao de caminhos internos do UFDR
- `Reprocessar Completo`:
  refaz ingestao/dados principais, sem transcrever audio
- `Reprocessar so Transcricoes`:
  executa apenas fila de transcricao pendente/nao concluida
- `Excluir`:
  remove evidencia e derivados

### 3.5 Busca investigativa
Em **Analise > Buscas**:
- pesquise por palavra, telefone, contato ou trecho de mensagem
- filtre por caso, evidencia ou extracao
- cada resultado mostra botoes para abrir em nova aba:
  - caso
  - evidencia
  - extracao
  - modulo de analise correspondente

Para contatos de WhatsApp, a tela tenta mostrar o telefone mesmo quando o indice trouxe apenas o nome. O numero pode ser derivado de campos como `phone`, `handle`, `externalId` ou `5511999999999@s.whatsapp.net`.

### 3.6 Mensagens e participantes
Em **Analise > Mensagens**:
- selecione plataforma, caso, extracao e termo de busca
- abra o chat na lateral
- o cabecalho do chat mostra os telefones/WhatsApp dos participantes
- cada mensagem mostra remetente resolvido, texto, anexos e transcricao vinculada quando existir

Os telefones tambem aparecem no relatorio consolidado como `Nome (telefone)` quando o dado estiver disponivel ou puder ser derivado do identificador WhatsApp.

### 3.7 Arquivos auditaveis
Em **Analise > Arquivos**:
- imagens, documentos e videos recebem classificacao de qualidade
- itens pequenos, figurinhas, icones, thumbnails e arquivos de baixa utilidade podem ser descartados por politica
- use os filtros `Auditaveis`, `Revisao`, `Indexados`, `Excluidos` e `Pendentes`
- OCR e classificacao de IA sao executados nos itens auditaveis quando aplicavel

### 3.8 Audios e transcricoes
Em **Analise > Audios**:
- audios `.opus` sao transcritos, inclusive quando nao possuem chat vinculado
- audios sem chat podem ser filtrados explicitamente
- audios soltos relevantes podem ser selecionados para constar no relatorio final
- a transcricao aparece junto do audio e pode ser usada pela analise de IA

Observacoes:
- por politica, apenas `.opus` e transcrito no fluxo principal
- arquivos nao `.opus` sao marcados como falha de politica e nao ficam presos na fila
- erros de credito/quota ficam preservados para retry apos regularizacao

### 3.9 Localizacoes
Em **Analise > Localizacoes**:
- filtre por caso e extracao
- cada coordenada possui botao para abrir diretamente no Google Maps em nova aba
- o botao `Baixar KML da evidencia` gera um arquivo `.kml` com todas as localizacoes disponiveis na evidencia filtrada

### 3.10 Analise investigativa com IA
Em **Analise > Analise de IA**:
1. selecione o caso
2. escolha engine/modelo (local ou OpenAI)
3. informe contexto manual se o caso ainda nao tiver contexto suficiente
4. use:
   - `Estimar Triagem`
   - `Rodar Triagem`
   - `Estimar Relatorio`
   - `Gerar Relatorio`

A triagem classifica chats por relevancia (`alta/media/baixa`) e mostra correlacoes.

Se houver triagem em andamento, o botao `Carregar ultima` recupera o job ativo e volta a acompanhar a barra de progresso real.

### 3.11 Relatorio consolidado
O relatorio consolidado pode incluir:
- chats selecionados na triagem
- nomes e telefones/WhatsApp dos interlocutores
- trechos relevantes de mensagens
- audios `.opus` sem chat selecionados pelo analista
- transcricoes desses audios
- arquivos auditaveis triados
- localizacoes disponiveis
- metadados de OCR e classificacao de IA

### 3.12 Tratamento de PDF
Em **Tratamento PDF**:
- processa PDF temporariamente (OCR, limpeza etc., conforme recursos implementados)
- permite download do resultado sem armazenamento definitivo obrigatorio

### 3.13 Monitoramento operacional
Em **Administracao > Saude Operacional**:
- status de DB, Redis, OpenSearch
- status das filas/workers
- carga de extracoes/transcricoes
- atualizacao automatica

Em **Administracao > Operacoes**:
- visualize jobs ativos, aguardando, pausados e falhados
- remova/retry jobs pontuais
- limpe jobs pausados antigos para evitar residuos de extracoes anteriores

## 4. Boas praticas de uso
1. Sempre vincule UFDR ao caso correto antes de processar.
2. Rode `Enriquecer Metadados` apos ingestao para popular aparelho/contas/localizacoes.
3. Use `Reprocessar Completo` e `Reprocessar so Transcricoes` separadamente para controle de custo.
4. Antes de IA, garanta contexto do caso (PDF/contexto manual).
5. Acompanhe Saude Operacional para evitar filas paradas.
6. Use o filtro de audios sem chat para revisar arquivos recuperados/lixeira.
7. Use KML para conferir trajetos/localizacoes em ferramenta externa.

## 5. Problemas comuns
- **"Unsupported state or unable to authenticate data"**:
  geralmente chave de criptografia/configuracao divergente; regravar configuracao sensivel.
- **Sem dados de aparelho/conta**:
  rodar `Enriquecer Metadados`.
- **Poucas transcricoes**:
  usar `Reprocessar so Transcricoes` e conferir fila/worker.
- **OCR falhando por idioma**:
  conferir `TESSERACT_BIN` e idiomas instalados. O sistema tenta fallback para `eng` quando o idioma solicitado nao existe.
- **Fila com jobs antigos pausados**:
  usar a limpeza de pausados antigos em **Administracao > Operacoes**.
