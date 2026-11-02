/**
 * facade.ts -- ponto de entrada da ponte de e-mail.
 *
 * Contas (--conta, padrão pessoal):
 *   pessoal  -- caixa institucional do gestor -> 01-gestor/_entrada/pessoal/ (prefixo PESSOAL_ no .env)
 *   setor    -- caixa do setor, se houver     -> 01-gestor/_entrada/setor/   (prefixo SETOR_)
 *   As contas do gestor vêm de 01-gestor/fluxos/config.yaml (caixas).
 *
 * Operações:
 *   testar                                   -- confere login e mostra totais das pastas (leitura)
 *   varrer   [--dias N | --desde AAAA-MM-DD] [--limite N] [--forcar]
 *                                            -- Caixa de Entrada -> pasta de entrada da conta (leitura)
 *   enviadas [--dias N] [--limite N]         -- Itens Enviados -> <entrada>/_enviadas/ (leitura). Rode antes
 *                                               do varrer: a varredura cruza por conversa e lista as mensagens
 *                                               que a caixa já respondeu (ja_respondidas_pela_caixa)
 *   rascunho --entrada <arquivo.md> --corpo <arquivo.txt> --aprovado-por <nome> [--todos]
 *                                            -- salva rascunho de resposta na pasta Rascunhos (NÃO envia)
 *   novo --mensagem <arquivo.json> --aprovado-por <nome>
 *                                            -- salva rascunho de mensagem NOVA na pasta Rascunhos (NÃO envia).
 *                                               JSON: { para: [], cc: [], assunto, corpo, anexos: [caminhos da raiz] }
 *
 * Rode a partir da raiz do assistente:
 *   bun run _pontes/email/facade.ts varrer --dias 7
 *   bun run _pontes/email/facade.ts varrer --conta setor --dias 3
 *
 * Nada aqui envia, move, marca como lido ou apaga mensagem. Os únicos writes são
 * `rascunho` e `novo`, chamados só depois do HITL do operador (aprovação no chat), e o
 * envio continua sendo humano, pelo webmail.
 */

import { mkdir, readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { EwsClient, type Mensagem, type Pasta } from "./ews-client.ts";

const RAIZ = resolve(import.meta.dir, "..", "..");

type Args = Record<string, string | true>;

interface Conta {
  conta: string;
  prefixo: string;
  entrada: string; // pasta de destino da captura
  ledgers: string[]; // pastas com registros YAML: mensagem já citada lá não é recapturada
}

/** Resolve a conta pelo nome em 01-gestor/fluxos/config.yaml (caixas). */
async function resolverConta(nome: string): Promise<Conta> {
  const cfg = Bun.YAML.parse(await Bun.file(join(RAIZ, "01-gestor", "fluxos", "config.yaml")).text()) as {
    caixas?: { conta: string; prefixo_env: string; destino: string }[];
  };
  const c = cfg.caixas?.find((x) => x.conta === nome);
  if (!c) throw new Error(`Conta "${nome}" não está em 01-gestor/fluxos/config.yaml (caixas).`);
  return { conta: c.conta, prefixo: c.prefixo_env, entrada: join(RAIZ, c.destino), ledgers: [join(RAIZ, "operacoes", "registro")] };
}

function parseArgs(argv: string[]): { operacao: string; args: Args } {
  const [operacao, ...resto] = argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < resto.length; i++) {
    if (!resto[i].startsWith("--")) continue;
    const chave = resto[i].slice(2);
    const valor = resto[i + 1];
    if (valor === undefined || valor.startsWith("--")) args[chave] = true;
    else {
      args[chave] = valor;
      i++;
    }
  }
  return { operacao: operacao ?? "", args };
}

/** Bun só carrega o .env do diretório atual; garante o da raiz do cérebro. */
async function carregarEnvDaRaiz(): Promise<void> {
  const arquivo = Bun.file(join(RAIZ, ".env"));
  if (!(await arquivo.exists())) return;
  for (const linha of (await arquivo.text()).split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}

function desdeDe(args: Args, diasPadrao: number): Date {
  if (typeof args.desde === "string") return new Date(`${args.desde}T00:00:00-03:00`);
  const dias = typeof args.dias === "string" ? Number.parseInt(args.dias, 10) : diasPadrao;
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
}

function limiteDe(args: Args, padrao: number): number {
  return typeof args.limite === "string" ? Number.parseInt(args.limite, 10) : padrao;
}

/** Data/hora local (America/Sao_Paulo) no formato AAAA-MM-DD e HHMM. */
function dataLocal(iso: string): { dia: string; hora: string } {
  const partes = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  const [dia, hora] = partes.split(" ");
  return { dia, hora: hora.replace(":", "") };
}

function chave(internetMessageId: string): string {
  return Bun.hash(internetMessageId).toString(16).slice(0, 8);
}

function pessoaStr(p: { nome: string; email: string } | null): string {
  if (!p) return "";
  return p.nome && p.nome !== p.email ? `${p.nome} <${p.email}>` : p.email;
}

function limparCorpo(texto: string): string {
  return texto
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function paraMarkdown(m: Mensagem, fonte: string, extra: Record<string, unknown> = {}): string {
  const { dia } = dataLocal(m.recebidoEm);
  const fm: Record<string, unknown> = {
    mensagem_id: m.internetMessageId,
    conversa_id: m.conversaId,
    ews_item_id: m.itemId,
    recebido_em: m.recebidoEm,
    dia,
    remetente: pessoaStr(m.de),
    para: m.para.map(pessoaStr),
    cc: m.cc.map(pessoaStr),
    assunto: m.assunto,
    anexos: m.anexos,
    lida_na_caixa: m.lida,
    capturado_em: new Date().toISOString(),
    fonte,
    ...extra,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const citado = limparCorpo(m.corpoCompleto).slice(limparCorpo(m.corpo).length).trim();
  const partes = [`---\n${yaml}\n---`, "", limparCorpo(m.corpo)];
  if (fonte === "ews-enviadas" && citado) {
    partes.push("", "### Mensagem respondida (trecho)", "", citado.slice(0, 1500));
  }
  return partes.join("\n") + "\n";
}

/** Frontmatter dos .md gravados por paraMarkdown (uma chave por linha, valor em JSON) e o corpo. */
function lerCaptura(texto: string): { fm: Record<string, unknown>; corpo: string } {
  const m = texto.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, corpo: texto };
  const fm: Record<string, unknown> = {};
  for (const linha of m[1].split("\n")) {
    const p = linha.match(/^([a-z_]+):\s*(.*)$/);
    if (!p) continue;
    try {
      fm[p[1]] = JSON.parse(p[2]);
    } catch {
      fm[p[1]] = p[2];
    }
  }
  return { fm, corpo: m[2].trim() };
}

export interface Enviada {
  arquivo: string; // caminho a partir da raiz, com /
  enviada_em: string;
  para: string[];
  assunto: string;
  trecho: string; // só o que a caixa escreveu, sem a mensagem respondida
}

/** Respostas capturadas em <entrada>/_enviadas/, agrupadas por conversa_id, mais recente primeiro. */
export async function enviadasPorConversa(entrada: string): Promise<Map<string, Enviada[]>> {
  const pasta = join(entrada, "_enviadas");
  const mapa = new Map<string, Enviada[]>();
  let nomes: string[] = [];
  try {
    nomes = (await readdir(pasta)).filter((f) => f.endsWith(".md"));
  } catch {
    return mapa;
  }
  for (const f of nomes) {
    const { fm, corpo } = lerCaptura(await Bun.file(join(pasta, f)).text());
    const conversa = String(fm.conversa_id ?? "");
    if (!conversa) continue;
    const lista = mapa.get(conversa) ?? [];
    lista.push({
      arquivo: relative(RAIZ, join(pasta, f)).replaceAll("\\", "/"),
      enviada_em: String(fm.recebido_em ?? ""),
      para: (fm.para as string[]) ?? [],
      assunto: String(fm.assunto ?? ""),
      trecho: corpo.split("### Mensagem respondida")[0].trim().slice(0, 600),
    });
    mapa.set(conversa, lista);
  }
  for (const l of mapa.values()) l.sort((a, b) => b.enviada_em.localeCompare(a.enviada_em));
  return mapa;
}

async function jaTriados(ledgers: string[]): Promise<string> {
  const textos: string[] = [];
  for (const pasta of ledgers) {
    try {
      const arquivos = (await readdir(pasta)).filter((f) => f.endsWith(".yaml"));
      textos.push(...(await Promise.all(arquivos.map((f) => Bun.file(join(pasta, f)).text()))));
    } catch {
      // pasta ainda não existe: nada triado
    }
  }
  return textos.join("\n");
}

async function jaCapturados(pasta: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(pasta)).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "").split("_").pop() ?? ""));
  } catch {
    return new Set();
  }
}

async function capturar(cliente: EwsClient, conta: Conta, pasta: Pasta, destino: string, fonte: string, args: Args, diasPadrao: number) {
  const desde = desdeDe(args, diasPadrao);
  const limite = limiteDe(args, 30);
  await mkdir(destino, { recursive: true });

  const ids = await cliente.listarIds(pasta, desde, limite);
  const mensagens = await cliente.obter(ids.map((i) => i.itemId));
  const triados = pasta === "inbox" ? await jaTriados(conta.ledgers) : "";
  const capturados = await jaCapturados(destino);

  const novos: string[] = [];
  let jaTriado = 0;
  let jaCapturado = 0;
  for (const m of mensagens) {
    const k = chave(m.internetMessageId || m.itemId);
    if (!args.forcar && m.internetMessageId && triados.includes(m.internetMessageId)) {
      jaTriado++;
      continue;
    }
    if (!args.forcar && capturados.has(k)) {
      jaCapturado++;
      continue;
    }
    const { dia, hora } = dataLocal(m.recebidoEm);
    const nome = `${dia}_${hora}_${k}.md`;
    await Bun.write(join(destino, nome), paraMarkdown(m, fonte, { conta: conta.conta }));
    novos.push(nome);
  }

  console.log(
    JSON.stringify(
      {
        conta: conta.conta,
        caixa: cliente.caixa,
        pasta,
        desde: desde.toISOString(),
        encontradas: ids.length,
        limite_atingido: ids.length >= limite,
        novas_capturadas: novos.length,
        ja_triadas: jaTriado,
        ja_capturadas: jaCapturado,
        destino: destino.replace(RAIZ, "").replace(/^[\\/]/, ""),
        arquivos: novos,
        ...(pasta === "inbox" ? await jaRespondidas(destino, triados) : {}),
      },
      null,
      2,
    ),
  );
}

/**
 * Mensagens capturadas e ainda não triadas cuja conversa tem resposta da própria caixa DEPOIS delas
 * (quem respondeu pelo webmail, sem passar pelo cérebro). Depende de `enviadas` ter rodado antes.
 */
async function jaRespondidas(destino: string, triados: string) {
  const enviadas = await enviadasPorConversa(destino);
  const out: { arquivo: string; assunto: string; recebida_em: string; respondida_em: string; para: string[] }[] = [];
  for (const f of (await readdir(destino)).filter((x) => x.endsWith(".md")).sort()) {
    const { fm } = lerCaptura(await Bun.file(join(destino, f)).text());
    const mid = String(fm.mensagem_id ?? "");
    if ((mid && triados.includes(mid)) || triados.includes(f)) continue; // o registro de gestão liga às vezes só pelo arquivo
    const resposta = enviadas.get(String(fm.conversa_id ?? ""))?.[0];
    if (!resposta || resposta.enviada_em <= String(fm.recebido_em ?? "")) continue;
    out.push({ arquivo: f, assunto: String(fm.assunto ?? ""), recebida_em: String(fm.recebido_em), respondida_em: resposta.enviada_em, para: resposta.para });
  }
  return { respostas_conhecidas: [...enviadas.values()].flat().length, ja_respondidas_pela_caixa: out };
}

const TIPOS_ANEXO: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
};
const ANEXOS_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Confere os anexos de um e-mail novo: caminho a partir da raiz, dentro do cérebro, existente,
 * fora de 01-gestor/restrito/ e do .env, e no total até 15 MB. Usado também pela fila (fila.ts).
 */
export async function conferirAnexos(caminhos: string[]): Promise<{ caminho: string; nome: string; bytes: number }[]> {
  const out: { caminho: string; nome: string; bytes: number }[] = [];
  for (const c of caminhos) {
    const abs = resolve(RAIZ, c);
    const r = relative(RAIZ, abs).replaceAll("\\", "/");
    if (r.startsWith("..") || isAbsolute(r)) throw new Error(`anexo fora do repositório: ${c}`);
    if (r.startsWith("01-gestor/restrito/") || basename(r).startsWith(".env")) throw new Error(`anexo não permitido (restrito ou credencial): ${r}`);
    const f = Bun.file(abs);
    if (!(await f.exists())) throw new Error(`anexo não existe nesta máquina: ${r}`);
    out.push({ caminho: r, nome: basename(r), bytes: f.size });
  }
  const total = out.reduce((s, a) => s + a.bytes, 0);
  if (total > ANEXOS_MAX_BYTES) throw new Error(`anexos somam ${(total / 1048576).toFixed(1)} MB (máximo 15 MB): mande link em vez de anexo`);
  return out;
}

/** "Nome <x@y>" ou "x@y" -> "x@y"; null se não houver endereço. */
export function enderecoDe(s: string): string | null {
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/) ?? s.trim().match(/^([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/);
  return m ? m[1] : null;
}

async function novo(cliente: EwsClient, conta: string, args: Args) {
  const arq = typeof args.mensagem === "string" ? resolve(RAIZ, args.mensagem) : "";
  const aprovadoPor = typeof args["aprovado-por"] === "string" ? args["aprovado-por"] : "";
  if (!arq || !aprovadoPor) {
    console.error("novo exige --mensagem <arquivo.json> --aprovado-por <nome>");
    process.exit(2);
  }
  const m = JSON.parse(await Bun.file(arq).text()) as { para?: string[]; cc?: string[]; assunto?: string; corpo?: string; anexos?: string[] };
  const enderecos = (xs: string[] | undefined) =>
    (xs ?? []).map((x) => {
      const e = enderecoDe(x);
      if (!e) throw new Error(`sem endereço de e-mail: "${x}"`);
      return e;
    });
  const para = enderecos(m.para);
  if (!para.length || !m.assunto || !m.corpo) throw new Error("a mensagem precisa de para, assunto e corpo");
  const anexos = await conferirAnexos(m.anexos ?? []);
  const r = await cliente.salvarRascunhoNovo({
    para,
    cc: enderecos(m.cc),
    assunto: m.assunto,
    corpoHtml: await textoParaHtml(m.corpo, conta),
    anexos: await Promise.all(
      anexos.map(async (a) => ({
        nome: a.nome,
        tipo: TIPOS_ANEXO[extname(a.nome).toLowerCase()] ?? "application/octet-stream",
        base64: Buffer.from(await Bun.file(join(RAIZ, a.caminho)).arrayBuffer()).toString("base64"),
      })),
    ),
  });
  console.log(
    JSON.stringify(
      {
        rascunho_salvo: true,
        caixa: cliente.caixa,
        pasta: "Rascunhos",
        rascunho_item_id: r.itemId,
        para,
        assunto: m.assunto,
        anexos: anexos.map((a) => a.nome),
        anexos_nao_incluidos: r.anexosNaoIncluidos,
        aprovado_por: aprovadoPor,
        salvo_em: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * Texto -> HTML no formato que o OWA usa ao compor: uma <div> por linha e <div><br></div> na
 * linha em branco (<p> sai sem margem no OWA e os parágrafos ficam colados). **x** vira negrito.
 * Se existir _pontes/email/assinaturas/<conta>.html, ela entra no fim, como faz o webmail
 * (o EWS não aplica a assinatura da caixa).
 */
export async function textoParaHtml(texto: string, conta: string): Promise<string> {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linhas = texto
    .trim()
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => (l.trim() ? `<div>${esc(l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}</div>` : "<div><br></div>"));
  const assinatura = Bun.file(join(import.meta.dir, "assinaturas", `${conta}.html`));
  if (await assinatura.exists()) linhas.push("<div><br></div>", (await assinatura.text()).trim());
  return `<div style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11pt;color:#000000;">\n${linhas.join("\n")}\n</div>`;
}

async function rascunho(cliente: EwsClient, conta: string, args: Args) {
  const entrada = typeof args.entrada === "string" ? resolve(RAIZ, args.entrada) : "";
  const corpoArq = typeof args.corpo === "string" ? resolve(RAIZ, args.corpo) : "";
  const aprovadoPor = typeof args["aprovado-por"] === "string" ? args["aprovado-por"] : "";
  if (!entrada || !corpoArq || !aprovadoPor) {
    console.error("rascunho exige --entrada <arquivo.md> --corpo <arquivo.txt> --aprovado-por <nome>");
    process.exit(2);
  }
  const fm = (await Bun.file(entrada).text()).match(/^ews_item_id:\s*(.+)$/m);
  if (!fm) {
    console.error(`ews_item_id não encontrado em ${entrada}`);
    process.exit(2);
  }
  const itemId = JSON.parse(fm[1]) as string;
  const corpo = await Bun.file(corpoArq).text();
  const r = await cliente.salvarRascunhoResposta(itemId, await textoParaHtml(corpo, conta), args.todos === true);
  console.log(
    JSON.stringify(
      { rascunho_salvo: true, caixa: cliente.caixa, pasta: "Rascunhos", rascunho_item_id: r.itemId, aprovado_por: aprovadoPor, salvo_em: new Date().toISOString() },
      null,
      2,
    ),
  );
}

async function main() {
  const { operacao, args } = parseArgs(process.argv);
  await carregarEnvDaRaiz();
  const conta = await resolverConta(typeof args.conta === "string" ? args.conta : "pessoal");
  const cliente = new EwsClient(conta.prefixo);

  switch (operacao) {
    case "testar": {
      const pastas = await Promise.all((["inbox", "sentitems", "drafts"] as Pasta[]).map((p) => cliente.resumoPasta(p)));
      console.log(JSON.stringify({ conta: conta.conta, caixa: cliente.caixa, login_ok: true, pastas }, null, 2));
      break;
    }
    case "varrer":
      await capturar(cliente, conta, "inbox", conta.entrada, "ews-inbox", args, 7);
      break;
    case "enviadas":
      await capturar(cliente, conta, "sentitems", join(conta.entrada, "_enviadas"), "ews-enviadas", args, 90);
      break;
    case "rascunho":
      await rascunho(cliente, conta.conta, args);
      break;
    case "novo":
      await novo(cliente, conta.conta, args);
      break;
    default:
      console.error("Uso: bun run _pontes/email/facade.ts <testar | varrer | enviadas | rascunho | novo> [--conta pessoal|setor] [opcoes]");
      process.exit(2);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`ERRO: ${(e as Error).message}`);
    process.exit(1);
  }
}
