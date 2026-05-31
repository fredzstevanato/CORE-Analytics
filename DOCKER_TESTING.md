# Teste em Docker

Esta configuracao empacota a aplicacao compilada e suas dependencias em uma imagem Linux, executavel em Linux e em Windows via Docker Desktop.

Ela nao copia o banco local nem inclui dumps. O Postgres do teste usa um volume Docker separado e vazio.

## Subir ambiente limpo

```bash
docker compose -f docker-compose.test.yml up --build
```

Servicos publicados no host:

- Web: http://localhost:3001
- Postgres de teste: localhost:15432
- Redis de teste: localhost:16379
- OpenSearch de teste: http://localhost:19200
- MinIO de teste: http://localhost:19001

## Parar sem apagar dados do teste

```bash
docker compose -f docker-compose.test.yml down
```

## Apagar somente dados do teste

```bash
docker compose -f docker-compose.test.yml down -v
```

Isso remove apenas os volumes `core-analytics-test_*` criados pelo Compose. Nao toca no Postgres local, no `.env` local nem no diretorio `storage` local.

## Rodar como centralizador

```bash
APP_NODE_ROLE=CENTRALIZER SYNC_NODE_ID=centralizador-01 docker compose -f docker-compose.test.yml up --build
```

No PowerShell:

```powershell
$env:APP_NODE_ROLE="CENTRALIZER"
$env:SYNC_NODE_ID="centralizador-01"
docker compose -f docker-compose.test.yml up --build
```

## Build multiplataforma

Para gerar uma imagem Linux que roda em hosts Linux e Windows com Docker Desktop:

```bash
docker build -t core-analytics:test .
```

Para publicar uma imagem multi-arch:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t sua-org/core-analytics:test --push .
```

Windows deve usar Docker Desktop em modo Linux containers. Windows containers exigiriam outra imagem base e outro conjunto de dependencias nativas.

## Instalar em outra maquina Linux

### 1. Preparar o host Ubuntu

```bash
sudo apt update
sudo apt install -y ca-certificates curl git

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

Se quiser usar Docker sem `sudo`:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker run --rm hello-world
```

OpenSearch precisa deste limite de memoria virtual:

```bash
sudo sysctl -w vm.max_map_count=262144
echo "vm.max_map_count=262144" | sudo tee /etc/sysctl.d/99-core-analytics.conf
```

### 2A. Instalar compilando no Linux

```bash
git clone <URL_DO_REPOSITORIO> CORE-Analytics
cd CORE-Analytics
docker compose -f docker-compose.test.yml up -d --build
docker compose -f docker-compose.test.yml ps
curl -fsS http://localhost:3001/api/health
```

Para centralizador:

```bash
APP_NODE_ROLE=CENTRALIZER \
SYNC_NODE_ID=centralizador-01 \
SYNC_NODE_NAME="Centralizador 01" \
SYNC_API_TOKEN="<troque-este-token>" \
docker compose -f docker-compose.test.yml up -d --build
```

### 2B. Instalar levando a imagem pronta desta maquina

Na maquina Windows onde a imagem foi criada:

```powershell
docker save core-analytics:test -o core-analytics-test.tar
```

Copie para o Linux:

```powershell
ssh usuario@IP_DO_LINUX 'sudo mkdir -p /opt/core-analytics && sudo chown $USER:$USER /opt/core-analytics'
scp .\core-analytics-test.tar usuario@IP_DO_LINUX:/opt/core-analytics/
scp .\docker-compose.test.yml usuario@IP_DO_LINUX:/opt/core-analytics/
```

No Linux:

```bash
cd /opt/core-analytics
docker load -i core-analytics-test.tar
docker compose -f docker-compose.test.yml up -d --no-build
docker compose -f docker-compose.test.yml exec web npm run --workspace @core/db prisma:seed
docker compose -f docker-compose.test.yml ps
curl -fsS http://localhost:3001/api/health
```

Para publicar em uma porta diferente:

```bash
CORE_TEST_WEB_PORT=3002 docker compose -f docker-compose.test.yml up -d --no-build
curl -fsS http://localhost:3002/api/health
```

Em uma instalacao real, troque `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `SYNC_API_TOKEN` e as senhas do Postgres/OpenSearch antes de expor a maquina na rede.

## Variaveis principais

- `APP_NODE_ROLE=STANDALONE|NODE|CENTRALIZER`
- `SYNC_NODE_ID`
- `SYNC_NODE_NAME`
- `CENTRALIZER_URL`
- `SYNC_API_TOKEN`
- `AI_TRANSCRIPTION_WORKER_CONCURRENCY`
- `UFDR_AUDIO_RECOVERY_WORKER_CONCURRENCY`

## Observacoes

- A imagem instala `ffmpeg`, `7z`, `tesseract` e `chromium`.
- O Whisper local nao e instalado por padrao porque adiciona uma dependencia pesada de Python/modelos. Para testes de transcricao, prefira configurar OpenAI/AssemblyAI ou instalar Whisper em uma imagem derivada.
- O banco de teste e criado por migrations no startup do servico `web`.
- O usuario inicial e criado pelo seed: `analista@core.local` / `Admin@123`. Troque a senha antes de uso real.
