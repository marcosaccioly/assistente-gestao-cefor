# _pontes/email/ -- webmail do Ifes (Exchange, via EWS)

Lê a Caixa de Entrada e os Itens Enviados e salva rascunhos. **Nunca envia, move, marca como lido ou apaga mensagem.** O envio é sempre seu, pelo webmail.

## Configurar

No `.env` (o `/configurar` guia): `PESSOAL_EMAIL`, `PESSOAL_USUARIO` e `PESSOAL_SENHA`, com o mesmo login do webmail. `PESSOAL_EWS_URL` e `PESSOAL_DOMINIO` já vêm preenchidos para o Ifes. Para a caixa do setor, o mesmo com `SETOR_`, e ative a conta em `01-gestor/fluxos/config.yaml`.

Teste:

```
bun run _pontes/email/facade.ts testar --conta pessoal
```

Deu `401`? Confira usuário e senha no `.env` e **não tente de novo em sequência**: várias recusas seguidas bloqueiam a conta no Ifes.

## Operações

| Comando | O que faz |
|---|---|
| `testar --conta <c>` | Confere o login e mostra os totais das pastas |
| `varrer --conta <c> --dias N` | Caixa de Entrada → `01-gestor/_entrada/<c>/` (só leitura) |
| `enviadas --conta <c> --dias N` | Itens Enviados → `01-gestor/_entrada/<c>/_enviadas/` (só leitura) |
| `rascunho ...` / `novo ...` | Salvam rascunho na pasta Rascunhos. Só o `/executar` chama, depois da sua aprovação |

## Assinatura

Ponha o HTML da sua assinatura em `assinaturas/<conta>.html` (ex.: `assinaturas/pessoal.html`). A ponte acrescenta no fim de todo rascunho daquela conta. Há um ponto de partida em `assinaturas/modelo.html`.
