# Atualizacao do CORE Analytics

## Objetivo
Este documento descreve o processo de atualizacao em dois perfis:

- Desenvolvedor: prepara e publica uma nova versao.
- Usuario final: aplica a atualizacao pela interface web em Settings/Updates.

---

## 1. Fluxo do Desenvolvedor

### 1.1 Pre requisitos

- Docker funcionando na maquina de build.
- Acesso ao repositorio GitHub.
- Acesso SSH na maquina de destino.
- Ambiente remoto com Docker Compose em execucao.

### 1.2 Publicar codigo

1. Validar mudancas localmente.
2. Commitar e enviar para o repositorio:
   - git add .
   - git commit -m "mensagem objetiva"
   - git push origin main

### 1.3 Gerar imagem atualizada

1. Build da imagem local:
   - docker build -t core-analytics:local .
2. Exportar imagem para arquivo:
   - docker save core-analytics:local | gzip > /tmp/core-analytics-local.tar.gz

### 1.4 Enviar imagem para maquina remota

1. Transferir arquivo:
   - scp /tmp/core-analytics-local.tar.gz steva@192.168.3.89:/C:/Users/steva/Desktop/core-analytics-local.tar.gz
2. Entrar na maquina e carregar imagem:
   - docker load --input C:\Users\steva\Desktop\core-analytics-local.tar.gz

### 1.5 Garantir configuracao do botao de update

No .env da release remota, definir:

- COMPOSE_WORKDIR=C:/Users/steva/Desktop/core-analytics-releases/CORE-Analytics-transfer-windows-20260708

Observacao:
- Esse caminho deve apontar para a pasta que contem docker-compose.yml e docker-compose.app.yml no host.

### 1.6 Publicar imagem no Docker Hub

Se a operacao for pelo botao "Atualizar via Docker Hub", a nova versao precisa estar publicada no registry configurado em `CORE_IMAGE`.

1. Build da imagem local.
2. Tag conforme a estrategia adotada.
3. Push para o Docker Hub ou registry privado.
4. Atualizar `CORE_IMAGE` na release remota para apontar para `latest` quando quiser sempre consumir a versao mais recente, ou para uma tag fixa quando quiser travar uma release.

### 1.7 Subir containers com a nova imagem

No diretorio da release remota:

- docker compose -f docker-compose.yml -f docker-compose.app.yml up -d --remove-orphans web worker-ingest worker-ai

### 1.8 Validar servicos

1. Health da aplicacao:
   - http://localhost:3001/api/health
2. Esperado:
   - status 200
   - checks de database, redis e opensearch como true

### 1.9 Validar autenticacao e rota de update

1. Login de teste na API.
2. Verificar:
   - GET /api/auth/me retorna autenticado true.
   - GET /api/ops/update retorna 200.

---

## 2. Fluxo do Usuario Final

### 2.1 Abrir painel de atualizacao

1. Entrar no sistema com usuario ADMIN.
2. Acessar:
   - Settings
   - Updates

### 2.2 Configurar opcoes antes de executar

- Pular git pull:
  - Marcar em releases sem clone Git local.
  - Recomendado para ambiente de transferencia por imagem.
- Pular backup:
  - Deixar desmarcado para manter seguranca.
- Timeout health (s):
  - Usar 300 por padrao.
  - Aumentar se ambiente estiver lento.

### 2.2.1 Escolher o modo de atualizacao

- Atualizacao local/script:
   - Usa os scripts do repositorio.
   - Indicado para releases baseadas em arquivo local e processos controlados manualmente.
- Atualizacao via Docker Hub:
   - Usa o botao "Atualizar via Docker Hub".
   - Indicado quando `CORE_IMAGE` aponta para uma imagem publicada no registry.
   - Padrao recomendado: `CORE_IMAGE=...:latest`.

### 2.3 Executar atualizacao

1. Escolher o modo correto.
2. Clicar em Executar atualizacao ou Atualizar via Docker Hub.
3. Acompanhar o Console de atualizacao na propria tela.

### 2.4 Confirmar resultado

Verificar no painel:

- Status: Concluido com sucesso.
- Sem erro no final do log.
- Plataforma detectada exibida corretamente.

Verificacao adicional sugerida:

- Recarregar o sistema e confirmar funcionamento das telas principais.

---

## 3. Comportamento interno da rota de update

Ao clicar no botao, a API:

1. Valida sessao e perfil ADMIN.
2. Inicia processo de update.
3. Grava estado e log em storage/tmp/ops-update.
4. Executa script de atualizacao conforme plataforma detectada.

Resumo atual:

- Em ambiente Docker, a plataforma reportada tende a ser linux.
- O processo usa docker socket montado no container web para executar docker compose no host.

---

## 4. Solucao de problemas

### 4.1 Erro de autenticacao na rota de update

- Sintoma: login 200, mas /api/auth/me 401.
- Verificar se a versao implantada contem o ajuste de cookie de sessao para HTTP.

### 4.2 Botao de update sem efeito

Verificar:

1. COMPOSE_WORKDIR no .env remoto.
2. Montagem de /var/run/docker.sock no servico web.
3. Web container com docker cli e compose plugin.

### 4.3 Falha no git pull durante update

- Em release sem pasta .git, usar Pular git pull.
- Em release com clone git, manter desmarcado para atualizar codigo automaticamente.

---

## 5. Checklist rapido

### Desenvolvedor

- Codigo no GitHub atualizado.
- Imagem core-analytics:latest gerada ou tag fixa equivalente publicada no Docker Hub.
- Imagem transferida e carregada no remoto.
- COMPOSE_WORKDIR definido no .env remoto.
- Containers atualizados e health 200.

### Usuario final

- Login ADMIN.
- Settings > Updates.
- Opcoes corretas marcadas.
- Executar atualizacao.
- Conferir status final e log sem erro.
