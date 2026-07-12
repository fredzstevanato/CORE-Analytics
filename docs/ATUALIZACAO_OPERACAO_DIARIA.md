# Atualizacao Diario - CORE Analytics

## Quando usar este guia
Use este roteiro para atualizacoes operacionais no dia a dia, sem entrar em detalhes tecnicos de build.

---

## Passo rapido (operacao)

1. Entrar no sistema com perfil ADMIN.
2. Abrir Settings > Updates.
3. Configurar opcoes:
   - Pular git pull: marcar em ambiente de release por imagem.
   - Pular backup: manter desmarcado (recomendado).
   - Timeout health: 300 segundos (aumentar se necessario).
   - Se usar Docker Hub, o padrao recomendado e `CORE_IMAGE=...:latest`.
4. Clicar em Executar atualizacao.
5. Acompanhar o Console de atualizacao na tela ate finalizar.

---

## Resultado esperado

- Status final: Concluido com sucesso.
- Sem erro no final do log.
- Sistema acessivel normalmente apos a conclusao.

---

## Validacao minima apos atualizar

1. Recarregar a aplicacao.
2. Testar login de usuario.
3. Abrir telas principais (Dashboard, Cases, Settings).
4. Confirmar que nao ha erro visual ou falha de carregamento.

---

## Se der erro

1. Copiar as ultimas linhas do Console de atualizacao.
2. Informar o horario da tentativa.
3. Acionar o desenvolvedor com:
   - mensagem de erro
   - etapa em que falhou (backup, build, start, health)

---

## Regras praticas

- Nao marcar Pular backup em atualizacao de rotina.
- Em ambiente sem repositorio Git local, manter Pular git pull marcado.
- Evitar executar nova atualizacao enquanto uma anterior estiver em andamento.
