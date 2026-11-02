# restrito/

Espaço para o que só quem gere pode ver: a situação de uma pessoa da equipe (saúde, desempenho, conflito, afastamento), conversas com a chefia sobre alguém, combinados que não podem ir para o board.

**Por que existe.** Quem substitui você numa ausência precisa saber que "isso foi conversado com a direção no dia tal". Sem um lugar, isso se perde no e-mail ou na memória.

**O que não é.** Não é cofre. É uma pasta no seu computador, fora do git (`.gitignore`): só este README é versionado. É restrito à gestão, não secreto.

## Como usar

- Um arquivo por pessoa ou por caso: `AAAA-pessoa-ou-assunto.md`. Entradas datadas, a mais nova no topo.
- Escreva o fato e o combinado, não opinião: "08/10 -- conversado com a direção sobre X; combinado Y; rever em Z".
- O registro (`operacoes/registro/`) guarda só a data e `destino: restrito`. O conteúdo fica aqui.
- O conteúdo daqui não alimenta painel, relatório nem resumo para a equipe.
- O assistente marca `sensivel: true` quando um item fala da situação de uma pessoa e propõe trazer para cá. Você confirma ou reclassifica.
