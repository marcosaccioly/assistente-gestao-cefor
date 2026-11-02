# _pontes/kanboard/ -- board.cefor (Kanboard)

O `/bom-dia` lê os boards (`painel.ts`); o `/executar` cria e ajusta cards (`fila.ts`), sempre depois da sua aprovação. Opcional: sem Kanboard, o painel só não tem o bloco do board e a sessão não delega por card.

## Configurar

1. No Kanboard, abra o seu perfil e gere um token pessoal na seção **API**.
2. No `.env`: `KANBOARD_API_USER` (seu usuário do board) e `KANBOARD_API_TOKEN`.
3. Veja seu id e seus boards: `bun run _pontes/kanboard/mapear.ts`
4. Grave os mapas dos boards que você usa: `bun run _pontes/kanboard/mapear.ts --projetos <id>,<id>`
5. Em `01-gestor/fluxos/config.yaml`: os boards em `boards`, e em `kanboard` o `projeto_padrao`, a `coluna_padrao` e o `autor_id` (seu id).

O `/configurar` faz os passos 3 a 5 com você.

## Arquivos

| Arquivo | O que é |
|---|---|
| `painel.ts` | Lê os boards de `config.yaml` e o que mudou desde a última leitura |
| `jsonrpc-client.ts` | Cliente da API do Kanboard |
| `mapear.ts` | Grava `projetos.yaml` e `usuarios.yaml` a partir do board (só lê o board) |
| `projetos.yaml` | Colunas e categorias de cada board, nome → id |
| `usuarios.yaml` | Pessoas dos boards, nome → id. Ajuste o `papel` de quem não recebe card (`grupo`, `sistema`) |

Os comentários e cards saem no seu nome: o token é seu.
