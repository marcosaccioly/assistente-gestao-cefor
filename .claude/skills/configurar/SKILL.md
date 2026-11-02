---
name: configurar
description: Configuração guiada do assistente de gestão na primeira vez (ou para refazer uma parte). Confere o Bun, cria o .env, testa o e-mail, liga o Kanboard e a agenda se o gestor quiser, e preenche config, equipe, voz, assinatura e recorrências com ele. Use quando o usuário digitar /configurar, disser "configurar", "instalar", "primeira vez", ou quando o config.yaml ainda tiver NOME_DO_GESTOR.
argument-hint: "[parte: email | kanboard | agenda | equipe | voz | assinatura | recorrencias]"
---

# /configurar

Você conduz a configuração com o gestor, **uma pergunta por vez**, em linguagem simples. Leva de 20 a 40 minutos na primeira vez. Se `$ARGUMENTS` nomear uma parte, faça só ela.

**Regra que não muda:** senha e token nunca passam pelo chat. Quando chegar a vez de uma credencial, peça ao gestor para abrir o arquivo `.env` no editor, preencher a linha e salvar; depois diga "me avise quando salvar". Se ele colar uma senha no chat, não repita, não grave, e peça para trocar a senha depois.

Cada mudança em `01-gestor/fluxos/`, `_configuracao/voz/` ou `_pontes/` você mostra antes (o trecho novo) e grava só com o ok.

## 0. Conferir o ambiente

- `bun --version`. Precisa de 1.3 ou mais. Sem Bun, mostre o comando de instalação do sistema dele (Windows, no PowerShell: `powershell -c "irm bun.sh/install.ps1 | iex"`; macOS e Linux: `curl -fsSL https://bun.sh/install | bash`) e peça para fechar e abrir o VS Code depois.
- Se não existe `.env` na raiz, copie `.env.example` para `.env` (é o único arquivo com credencial; está no `.gitignore`).

## 1. Quem é você

Pergunte o nome (como assina) e o setor. Grave em `gestor` no `01-gestor/fluxos/config.yaml`.

## 2. E-mail (obrigatório)

1. Peça para preencher no `.env`: `PESSOAL_EMAIL` (o endereço institucional), `PESSOAL_USUARIO` (o login do webmail) e `PESSOAL_SENHA`. URL e domínio já vêm prontos.
2. Teste: `bun run _pontes/email/facade.ts testar --conta pessoal`. Deu certo: mostre os totais das pastas.
3. Deu `401`: peça para conferir usuário e senha no `.env`. **Não teste mais de duas vezes seguidas**: recusas em sequência bloqueiam a conta no Ifes.
4. Pergunte se o setor tem caixa própria e se ele tem o login dela. Se sim: `SETOR_*` no `.env`, descomente a conta `setor` no `config.yaml` e teste com `--conta setor`.

## 3. Kanboard (opcional)

Pergunte se ele usa o board.cefor. Se não, pule.

1. Ele gera um token pessoal no Kanboard (perfil → API) e preenche `KANBOARD_API_USER` e `KANBOARD_API_TOKEN` no `.env`.
2. `bun run _pontes/kanboard/mapear.ts`: mostre o id dele e os boards. Pergunte quais o assistente deve ler.
3. `bun run _pontes/kanboard/mapear.ts --projetos <ids>`: grava `projetos.yaml` e `usuarios.yaml`.
4. No `config.yaml`: `boards` com os escolhidos; em `kanboard`, `projeto_padrao` (onde nascem os cards delegados), `coluna_padrao` (mostre as colunas de `projetos.yaml` e pergunte em qual o card nasce) e `autor_id` (o id dele).
5. Em `usuarios.yaml`, pergunte se há conta de grupo ou de sistema na lista; marque `papel: grupo` ou `sistema` (não recebem card).

## 4. Equipe

Peça a lista da equipe: nome, como ele chama a pessoa, e-mail, se prefere board, WhatsApp ou conversa presencial. Monte `pessoas` em `contatos.yaml`, ligando o `kanboard_user_id` de `usuarios.yaml` pelo nome. Pergunte se há um grupo de WhatsApp da equipe (vai em `grupos`). Nada sobre saúde, desempenho ou afastamento aqui.

## 5. Voz

Peça duas coisas: um recado que ele mandou para a equipe e uma resposta que o setor mandou para alguém de fora (sem dados de terceiros; ele pode trocar nomes). Pergunte também o que ele nunca escreveria. Preencha `_configuracao/voz/gestor.md` e `setor.md` a partir disso, com as palavras dele, e mostre.

## 6. Assinatura

Pergunte nome, cargo, setor e telefone como aparecem na assinatura dele. Gere `_pontes/email/assinaturas/pessoal.html` a partir de `modelo.html` e mostre. Se houver caixa do setor, ofereça `setor.html`.

## 7. Recorrências

Mostre a lista de `01-gestor/fluxos/acoes-recorrentes.yaml` (PGD, ponto, férias) com as datas. Para cada uma: vale para ele? A data confere? Confirmada: `confirmado: true`. Não vale: apague. Pergunte se há outra obrigação mensal ou anual do setor e acrescente.

## 8. Agenda (opcional, avançado)

Pergunte se quer ligar a agenda Google agora. Na maioria das vezes, deixe para depois: aponte `_pontes/calendario/README.md` e siga.

## 9. Primeiro uso

Resuma em até cinco linhas o que ficou ligado e o que ficou pendente. Sugira `/bom-dia 7d` (na primeira vez, uma semana de e-mails) e, depois dele, uma `/sessao` curta.

## Invariantes

- Senha e token só no `.env`, preenchidos pelo próprio gestor. Nunca leia o `.env` em voz alta, nunca mostre o conteúdo dele.
- Teste de credencial no máximo duas vezes seguidas.
- Uma pergunta por vez; mostre cada mudança antes de gravar.
