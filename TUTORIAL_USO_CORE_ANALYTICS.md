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
   - **Timeline**
   - **Localizacoes**
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

### 3.5 Analise investigativa com IA
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

### 3.6 Tratamento de PDF
Em **Tratamento PDF**:
- processa PDF temporariamente (OCR, limpeza etc., conforme recursos implementados)
- permite download do resultado sem armazenamento definitivo obrigatorio

### 3.7 Monitoramento operacional
Em **Administracao > Saude Operacional**:
- status de DB, Redis, OpenSearch
- status das filas/workers
- carga de extracoes/transcricoes
- atualizacao automatica

## 4. Boas praticas de uso
1. Sempre vincule UFDR ao caso correto antes de processar.
2. Rode `Enriquecer Metadados` apos ingestao para popular aparelho/contas/localizacoes.
3. Use `Reprocessar Completo` e `Reprocessar so Transcricoes` separadamente para controle de custo.
4. Antes de IA, garanta contexto do caso (PDF/contexto manual).
5. Acompanhe Saude Operacional para evitar filas paradas.

## 5. Problemas comuns
- **"Unsupported state or unable to authenticate data"**:
  geralmente chave de criptografia/configuracao divergente; regravar configuracao sensivel.
- **Sem dados de aparelho/conta**:
  rodar `Enriquecer Metadados`.
- **Poucas transcricoes**:
  usar `Reprocessar so Transcricoes` e conferir fila/worker.

