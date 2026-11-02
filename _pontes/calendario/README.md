# _pontes/calendario/ -- Google Agenda (opcional, avançado)

Lê as agendas da equipe (férias, teletrabalho, compromissos, feriados) para o painel e a sessão, e cria ou altera eventos quando você aprova na sessão. Nunca apaga evento.

**É a conexão mais trabalhosa de configurar**: precisa de um cliente OAuth do Google ("App para computador"). Se não for agora, deixe para depois: o `/bom-dia` escreve "agendas: não lidas" e segue.

## Configurar

1. Consiga o `CALENDARIO_CLIENT_ID` e o `CALENDARIO_CLIENT_SECRET` (um cliente OAuth do Google Cloud do tipo "App para computador", com a API Google Calendar ativada). Na dúvida, combine com quem mantém o modelo.
2. No `.env`: `CALENDARIO_CONTA` (sua conta **institucional**; nunca a pessoal), o client id e o secret.
3. Autorize uma vez nesta máquina: `bun run _pontes/calendario/facade.ts autorizar` (abre o navegador e grava `CALENDARIO_REFRESH_TOKEN` no `.env`).
4. Em `01-gestor/fluxos/config.yaml`, liste as agendas em `agendas.lista` (id, nome, papel). Cada uma precisa estar compartilhada com a conta do passo 2.
5. Teste: `bun run _pontes/calendario/facade.ts testar`

## Operações

`listar [--dias N]` · `testar` · `autorizar` · `criar` e `alterar` (só pelo `/executar`).
