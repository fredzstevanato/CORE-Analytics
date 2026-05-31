# Go-Live Checklist (CORE Analytics)

Data de atualizacao: 11/04/2026

## 1) Critico (bloqueia producao)

- [x] Fluxo UFDR separado: ingestao sem transcricao automatica.
- [x] Reprocessar completo sem transcricao; transcricao em botao separado.
- [x] Chave OpenAI vinda de Configuracoes (banco) para transcricao online.
- [x] Remocao de limitadores silenciosos de ingestao/transcricao por default.
- [x] Rotas criticas de evidencia/UFDR exigem sessao autenticada.
- [x] Middleware valida assinatura da sessao (nao apenas cookie presente).
- [x] SESSION_SECRET obrigatorio em producao.
- [x] SETTINGS_ENCRYPTION_KEY/segredo de configuracoes obrigatorio em producao.

Pendencias criticas restantes:
- [ ] Rotacionar segredos e garantir valores fortes no ambiente de producao (sem defaults de desenvolvimento).
- [ ] Definir politica de backup e restore testado (Postgres + storage de evidencias + OpenSearch).
- [ ] Configurar HTTPS, proxy reverso e cabecalhos de seguranca em ambiente produtivo.

## 2) Alta prioridade (go-live recomendado)

- [x] Runtime/modelo de transcricao e IA expostos no frontend de processamento.
- [x] Estimativa de custo/tokens/tempo antes de acionar reprocessamento.
- [x] Enriquecimento de metadados com device + contas + georreferenciamento + timeline.
- [x] Pagina de tratamento de PDF em fluxo temporario (sem persistencia obrigatoria).

Pendencias altas:
- [x] Observabilidade: painel de saude operacional unico (fila, workers, Redis, OpenSearch, DB).
- [ ] Alertas ativos (falha de worker, fila parada, erro de parser, queda de dependencia).
- [ ] Testes E2E dos fluxos principais (upload UFDR, enriquecer, reprocessar, retranscrever).
- [ ] Politica de retentiva e limpeza automatica de temporarios de PDF.

## 3) Operacao e qualidade

- [ ] Runbook operacional (subir, parar, recuperar fila, reindexar, restaurar backup).
- [ ] Auditoria de permissao por perfil (ADMIN/ANALISTA) em todas as APIs sensiveis.
- [ ] Teste de carga com UFDR grande (chats/mensagens/anexos/transcricoes em volume real).
- [ ] Validacao forense: cadeia de custodia ponta a ponta (hash e eventos em cada acao).

## 4) Criterio objetivo de pronto para uso

Aplicacao apta para uso quando todos os itens abaixo estiverem verdes:

- [ ] Checklist Critico 100% concluido.
- [ ] Pelo menos 1 restore completo validado em ambiente homologacao.
- [ ] Suite E2E minima passando em CI para fluxos UFDR e reprocessamento.
- [ ] Monitoramento/alerta ativo com responsavel de plantao definido.
- [ ] Documento de operacao entregue para equipe usuaria.
