# Assistente de gestão -- Cefor/Ifes

Um assistente para o gestor não virar gargalo. Ele lê o que chega no e-mail, no Kanboard e na agenda, transforma tudo em **questões de gestão** e ajuda você a decidir cada uma em uma frase. Depois ele faz o trabalho braçal (card no board, rascunho de resposta, mensagem para a equipe), sempre com a sua aprovação.

Roda no seu computador, com o [Claude Code](https://claude.com/claude-code), sobre esta pasta. Não há servidor: o que o assistente sabe está em arquivos que você pode abrir e ler.

**Guia completo, passo a passo:** _link da página de referência_

## O dia com o assistente

1. **`/bom-dia`** de manhã: ele lê as caixas, os boards, as agendas e as obrigações recorrentes (PGD, ponto, férias) e monta o painel do que não pode passar hoje.
2. **`/capturar`** durante o dia: um recado no corredor, um print do WhatsApp, um e-mail de outra caixa. Vira questão de gestão sem você decidir nada na hora.
3. **`/sessao`** uma vez por dia, um pomodoro: o assistente mostra uma questão por vez e você diz o que fazer ("delega pra Ana, prazo sexta", "responde que recebemos"). Ele monta as ações e mostra a tabela para você aprovar.
4. **`/executar`**: com uma confirmação, ele cria os cards, salva os rascunhos na sua caixa e entrega as mensagens prontas para você enviar.

## O que você precisa

- Computador com Windows, macOS ou Linux.
- [VS Code](https://code.visualstudio.com/) com a extensão do Claude Code, ou o Claude Code no terminal. Precisa de um plano pago do Claude (Pro ou superior).
- [Bun](https://bun.sh/) 1.3 ou mais novo (roda os scripts).
- Seu login do webmail do Ifes. Opcional: token do Kanboard (board.cefor) e uma conta Google para a agenda.

## Começar

1. Baixe este repositório (botão **Code → Download ZIP**) e extraia a pasta.
2. Abra a pasta no VS Code e o painel do Claude Code.
3. Digite `/configurar` e siga as perguntas. As senhas você mesmo escreve no arquivo `.env`; nunca cole senha no chat.
4. Rode `/bom-dia`.

## Privacidade

- Credenciais ficam só no `.env`, que não sai da sua máquina.
- E-mails brutos (`01-gestor/_entrada/`) e notas sobre pessoas (`01-gestor/restrito/`) ficam fora do git.
- O registro de questões (`operacoes/`) tem resumos de e-mails de terceiros. Se você versionar esta pasta, use um repositório **privado**.
- O conteúdo que o assistente lê passa pelo Claude (Anthropic) para ser resumido. Siga as orientações do Ifes sobre o uso de IA com dados institucionais.

## Melhorias

Cada comando deixa uma linha em `99-automelhoria/_entrada/` com o que faltou. Leve essas notas para quem mantém o modelo: é assim que o assistente melhora para todos.

Feito na Coordenadoria Geral de Tecnologias Educacionais do Cefor/Ifes, com o Claude Code e revisão humana.
