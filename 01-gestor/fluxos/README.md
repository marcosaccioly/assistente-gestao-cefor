# fluxos/ -- modo de edição do assistente de gestão

O que o assistente faz com cada coisa que chega está escrito aqui, em arquivos que se leem sem IA. Mudar o comportamento do assistente é mudar um destes arquivos.

| Arquivo | O que define | Quem lê |
|---|---|---|
| `config.yaml` | Seu nome e setor, caixas lidas, boards lidos, agendas, janelas padrão, onde nascem os cards | `bom-dia`, `ferramentas/fila.ts`, pontes |
| `contatos.yaml` | Como se pede a cada pessoa ou setor: apelido, canal, e-mail, id no board | `sessao`, `ferramentas/fila.ts` |
| `catalogo-acoes.yaml` | Cada decisão (delegar, responder, perguntar...) e as operações que ela gera | `sessao` |
| `acoes-recorrentes.yaml` | Obrigações recorrentes (PGD, ponto, férias) e seus alarmes | `ferramentas/gestor.ts insumos` |
| `ruido.yaml` | O que é ruído em cada caixa: não vira questão de gestão, só entra na contagem | `ferramentas/gestor.ts insumos` |
| `respostas-padrao.md` | Modelos de rascunho de e-mail ("recebemos", "encaminhado", "pronto"...) | `sessao` |

## Como editar

- **Durante o uso.** No `/bom-dia` ou na `/sessao`, diga "isso é ruído", "isso é recorrente todo mês", "quando chegar X, faça Y". O assistente propõe a mudança, mostra o diff e grava depois do seu ok.
- **À mão.** Os arquivos são YAML comentado. Edite e salve.
- **Nunca sozinho.** Nenhum comando altera `fluxos/` sem você ver o diff.
