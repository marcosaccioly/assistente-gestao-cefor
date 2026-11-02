---
name: executar
description: Executa em lote a fila de ações do assistente de gestão (cards e ajustes no Kanboard, rascunhos de e-mail, mensagens prontas, eventos de agenda), depois de uma confirmação do gestor, e reporta o resultado de cada ação. Use quando o usuário digitar /executar, ou disser "executa", "roda a fila", "manda ver no lote".
argument-hint: "[AC-ids específicas, ou vazio para a fila inteira]"
---

# /executar

O `/executar` roda o que já foi aprovado item a item na `/sessao`. Ele pede **uma** confirmação do lote e não decide nada.

## 1. Mostrar o lote

`bun run 01-gestor/ferramentas/fila.ts executar [--ids AC-...,AC-...]` (simulação: não toca em nada).

Mostre o lote no chat como veio, uma linha por ação. Se alguma ação já falhou antes, destaque o erro. Se a fila estiver vazia, diga isso e pare.

Pergunte: **"Confirma o lote de N ações?"** Só siga com um sim explícito ("sim", "confirma", "pode rodar"). Se o gestor quiser tirar uma ação: `fila.ts cancelar --id AC-... --motivo "<motivo>"`; se quiser mudar uma, cancele e volte à `/sessao` para aquela QG (ação mudada precisa de nova aprovação).

## 2. Rodar

`bun run 01-gestor/ferramentas/fila.ts executar --confirmado-por <nome de quem confirmou> [--ids ...]`

O script grava o rastro de cada ação (`operacoes/fila/executadas/AAAA-MM.yaml`), atualiza a QG (nota, destino `card:<board>#<id>` ou `rascunho:<conta>`, estado) e deixa na fila o que falhou, com o erro.

## 3. Reportar

- Uma linha por ação: ok ou falha, com o link do card quando houver.
- **Mensagens para você enviar:** o texto de cada `aviso.pessoa`, pronto para copiar, e o link do WhatsApp. O assistente não envia mensagem.
- **Rascunhos:** "N rascunhos na pasta Rascunhos da caixa <conta>; o envio é seu, pelo webmail." Se um `email.novo` voltar com `anexos_nao_incluidos`, o rascunho existe sem o anexo: diga qual arquivo anexar à mão e nunca repita a ação (duplicaria o rascunho).
- **Falhas:** o que deu errado, em uma linha. Falha de rede: a ação continua na fila e pode ir no próximo `/executar`. **Recusa de autenticação (401/403) ou `.env` sem configuração:** não rode de novo; anote em "pendências de setup" no painel e diga o que conferir no `.env` (recusas seguidas bloqueiam a conta).
- Card criado com subtarefa que não entrou (`subtarefas_nao_criadas`): o card existe; proponha na próxima sessão um `kanboard.subtarefa` só com as que faltaram. Nunca repita o `kanboard.criar`.

Depois, atualize o cabeçalho de `operacoes/painel/hoje.md` com `· fila executada <HH:MM>: <n> ok, <n> falha(s)` e acrescente uma linha em `99-automelhoria/_entrada/<AAAA-MM-DD>.md` (hora + o que falhou ou "ok").

## Invariantes

- Só roda o que está na fila (aprovado na sessão, com `aprovado_por`). Nunca monte ação nova aqui.
- Uma confirmação do lote; nunca rode sem ela.
- Nada é enviado: e-mail vira rascunho, mensagem vira texto para o gestor.
- Credenciais só no `.env`; nunca mostre token ou senha.
