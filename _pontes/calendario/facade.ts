/**
 * facade.ts -- ponto de entrada da ponte de agenda (Google Calendar).
 *
 * Lê as agendas de 01-gestor/fluxos/config.yaml (agendas.lista) pela conta Google
 * CALENDARIO_CONTA do .env, com OAuth guardado no .env.
 *
 * Operações:
 *   autorizar               -- abre o consentimento do Google, confere a conta e grava
 *                              CALENDARIO_REFRESH_TOKEN no .env (uma vez por máquina/conta)
 *   testar                  -- confere a conta do token e o acesso a cada agenda do config.yaml
 *   listar [--dias N] [--desde AAAA-MM-DD]
 *                           -- eventos de cada agenda, de hoje (ou --desde) até N dias à frente
 *                              (padrão agendas.dias_a_frente); cada evento traz o id
 *   criar --mensagem <arquivo.json> --aprovado-por <nome>
 *                           -- cria um evento numa agenda do config.yaml
 *   alterar --mensagem <arquivo.json> --aprovado-por <nome>
 *                           -- muda título, local, descrição, início ou fim de um evento
 *
 * Rode a partir da raiz do assistente:
 *   bun run _pontes/calendario/facade.ts listar
 *
 * Escrita (28/10/2026): criar e alterar são chamados pela fila do /executar (tipos agenda.criar e
 * agenda.alterar), depois de o gestor aprovar a linha na sessão. Só em agendas do config.yaml.
 * Nada aqui apaga evento.
 *
 * Mensagem (JSON): { agenda: <id ou nome do config.yaml>, evento?: <id, só no alterar>,
 *   titulo?, local?, descricao?, inicio?, fim? }. Dia inteiro: inicio e fim "AAAA-MM-DD", fim é
 *   o último dia ocupado. Com hora: "AAAA-MM-DDTHH:MM" (America/Sao_Paulo).
 */

import { join, resolve } from "node:path";
import { CalendarClient, ErroApi, credenciaisDoEnv, pkce, trocarCodigo, urlAutorizacao, type Credenciais, type Evento, type EventoEscrita } from "./google-client.ts";

const RAIZ = resolve(import.meta.dir, "..", "..");
const FUSO = "America/Sao_Paulo";

type Args = Record<string, string | true>;

interface AgendaCfg {
  id: string;
  nome: string;
  papel: string;
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

/** Grava (ou troca) uma variável no .env da raiz, mantendo o resto e o fim de linha do arquivo. */
async function gravarNoEnv(chave: string, valor: string): Promise<void> {
  const arquivo = Bun.file(join(RAIZ, ".env"));
  const texto = (await arquivo.exists()) ? await arquivo.text() : "";
  const eol = texto.includes("\r\n") ? "\r\n" : "\n";
  const linhas = texto ? texto.replace(/(\r?\n)+$/, "").split(/\r?\n/) : [];
  const i = linhas.findIndex((l) => l.startsWith(`${chave}=`));
  if (i >= 0) linhas[i] = `${chave}=${valor}`;
  else linhas.push(`${chave}=${valor}`);
  await Bun.write(arquivo, linhas.join(eol) + eol);
}

export async function lerConfig(): Promise<{ dias: number; lista: AgendaCfg[] }> {
  const cfg = Bun.YAML.parse(await Bun.file(join(RAIZ, "01-gestor", "fluxos", "config.yaml")).text()) as {
    agendas?: { dias_a_frente?: number; lista?: AgendaCfg[] };
  };
  return { dias: cfg.agendas?.dias_a_frente ?? 14, lista: cfg.agendas?.lista ?? [] };
}

/** Data e hora locais (America/Sao_Paulo): AAAA-MM-DD e HH:MM. */
function local(iso: string): { dia: string; hora: string } {
  const [dia, hora] = new Intl.DateTimeFormat("sv-SE", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .split(" ");
  return { dia, hora };
}

function diaAnterior(dia: string): string {
  return somarDias(dia, -1);
}

function somarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const norm = (v: unknown) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

/** Agenda do config.yaml por id ou nome (igual, começo ou trecho do nome, sem acento). Fora do config, recusa. */
export async function resolverAgenda(v: unknown): Promise<AgendaCfg> {
  const { lista } = await lerConfig();
  const porId = lista.find((a) => a.id === v);
  if (porId) return porId;
  const n = norm(v);
  if (!n) throw new Error("falta a agenda (id ou nome do config.yaml)");
  const iguais = lista.filter((a) => norm(a.nome) === n);
  const achadas = iguais.length ? iguais : lista.filter((a) => norm(a.nome).includes(n));
  if (achadas.length === 1) return achadas[0];
  if (!achadas.length) throw new Error(`agenda "${v}" não está em agendas.lista do config.yaml. Opções: ${lista.map((a) => a.nome).join(" · ")}`);
  throw new Error(`agenda "${v}" é ambígua: ${achadas.map((a) => a.nome).join(" · ")}`);
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Início e fim no formato da API. Dia inteiro: o fim do Google é exclusivo (último dia + 1). */
export function periodo(inicio: unknown, fim: unknown): Pick<EventoEscrita, "start" | "end"> {
  const i = String(inicio ?? "");
  const f = String(fim ?? inicio ?? "");
  if (DIA.test(i) && DIA.test(f)) {
    if (f < i) throw new Error(`fim (${f}) antes do início (${i})`);
    return { start: { date: i }, end: { date: somarDias(f, 1) } };
  }
  if (DIA_HORA.test(i) && DIA_HORA.test(f)) {
    if (f <= i) throw new Error(`fim (${f}) não é depois do início (${i})`);
    return { start: { dateTime: `${i}:00`, timeZone: FUSO }, end: { dateTime: `${f}:00`, timeZone: FUSO } };
  }
  throw new Error('inicio e fim: os dois "AAAA-MM-DD" (dia inteiro) ou os dois "AAAA-MM-DDTHH:MM"');
}

/** Corpo da escrita a partir da mensagem. No alterar, só os campos presentes. */
export function corpoEvento(m: Record<string, unknown>, parcial: boolean): Partial<EventoEscrita> {
  const corpo: Partial<EventoEscrita> = {};
  if (m.titulo !== undefined) corpo.summary = String(m.titulo);
  if (m.local !== undefined) corpo.location = String(m.local);
  if (m.descricao !== undefined) corpo.description = String(m.descricao);
  if (m.inicio !== undefined || m.fim !== undefined) {
    if (m.inicio === undefined || m.fim === undefined) throw new Error("para mudar a data, passe inicio e fim juntos");
    Object.assign(corpo, periodo(m.inicio, m.fim));
  }
  if (!parcial && (!corpo.summary || !corpo.start)) throw new Error("criar exige titulo, inicio e fim");
  if (parcial && !Object.keys(corpo).length) throw new Error("alterar exige ao menos um campo: titulo, local, descricao ou inicio+fim");
  return corpo;
}

/** Evento em formato curto (dia, hora, título), para mostrar o antes e o depois. */
export function resumoEvento(e: Evento) {
  return { id: e.id, ...evento(e), titulo: e.summary ?? null };
}

function janela(args: Args, diasPadrao: number): { de: Date; ate: Date } {
  const inicio = typeof args.desde === "string" ? args.desde : local(new Date().toISOString()).dia;
  const dias = typeof args.dias === "string" ? Number.parseInt(args.dias, 10) : diasPadrao;
  const de = new Date(`${inicio}T00:00:00-03:00`);
  return { de, ate: new Date(de.getTime() + dias * 24 * 60 * 60 * 1000) };
}

function evento(e: Evento) {
  if (e.start?.date) {
    // dia inteiro: o Google dá o fim exclusivo; aqui vai o último dia ocupado
    return { dia: e.start.date, hora: null, fim_dia: diaAnterior(e.end?.date ?? e.start.date), fim_hora: null, dia_inteiro: true };
  }
  const ini = local(e.start?.dateTime ?? "");
  const fim = local(e.end?.dateTime ?? e.start?.dateTime ?? "");
  return { dia: ini.dia, hora: ini.hora, fim_dia: fim.dia, fim_hora: fim.hora, dia_inteiro: false };
}

/** Conecta e confere que o token é mesmo da conta configurada. */
export async function conectar(c: Credenciais = credenciaisDoEnv()): Promise<CalendarClient> {
  const cliente = await CalendarClient.conectar(c);
  const conta = (await cliente.contaConectada()).toLowerCase();
  if (conta !== c.conta.toLowerCase()) {
    throw new Error(`O token do .env é da conta ${conta}, não de ${c.conta}. Rode \`autorizar\` de novo com a conta certa.`);
  }
  return cliente;
}

function abrirNavegador(url: string): void {
  const cmd =
    process.platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // sem navegador (VPS): o link impresso basta
  }
}

async function autorizar(): Promise<void> {
  const c = credenciaisDoEnv(false);
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();

  let receber!: (code: string) => void;
  let falhar!: (e: Error) => void;
  const codigo = new Promise<string>((ok, erro) => {
    receber = ok;
    falhar = erro;
  });
  const servidor = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/") return new Response("", { status: 404 });
      const erro = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (erro || !code || u.searchParams.get("state") !== state) {
        falhar(new Error(`Consentimento não concluído: ${erro ?? "resposta inválida"}`));
        return new Response("Autorização não concluída. Pode fechar esta aba.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      receber(code);
      return new Response("Agenda autorizada (leitura e escrita). Pode fechar esta aba e voltar ao terminal.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    },
  });
  const redirectUri = `http://127.0.0.1:${servidor.port}`;
  const url = urlAutorizacao(c, redirectUri, challenge, state);
  console.error(`Abra no navegador e entre com ${c.conta}:\n\n${url}\n\nAguardando o consentimento (5 min)...`);
  abrirNavegador(url);

  const limite = setTimeout(() => falhar(new Error("Tempo esgotado esperando o consentimento.")), 5 * 60 * 1000);
  try {
    const tokens = await trocarCodigo(c, await codigo, redirectUri, verifier);
    if (!tokens.refresh_token) throw new Error("O Google não devolveu refresh token. Rode `autorizar` de novo.");
    const conta = (await CalendarClient.comToken(tokens.access_token).contaConectada()).toLowerCase();
    if (conta !== c.conta.toLowerCase()) {
      throw new Error(`Você entrou com ${conta}, mas CALENDARIO_CONTA é ${c.conta}. Nada foi gravado.`);
    }
    await gravarNoEnv("CALENDARIO_REFRESH_TOKEN", tokens.refresh_token);
    const escrita = tokens.scope.split(" ").includes("https://www.googleapis.com/auth/calendar.events");
    console.log(JSON.stringify({ autorizado: true, conta, escrita: escrita ? "sim" : "não (a caixa de escrita ficou desmarcada no consentimento)", gravado: ".env (CALENDARIO_REFRESH_TOKEN)" }, null, 2));
  } finally {
    clearTimeout(limite);
    servidor.stop(true);
  }
}

async function testar(): Promise<void> {
  const c = credenciaisDoEnv();
  const cliente = await conectar(c);
  const { lista } = await lerConfig();
  const naLista = new Map((await cliente.listaDeAgendas()).map((a) => [a.id, a.accessRole]));
  const agora = new Date();
  const agendas = await Promise.all(
    lista.map(async (a) => {
      if (naLista.has(a.id)) return { id: a.id, nome: a.nome, acesso: naLista.get(a.id) };
      try {
        await cliente.eventos(a.id, agora, new Date(agora.getTime() + 864e5), 1);
        return { id: a.id, nome: a.nome, acesso: "fora da lista da conta, leitura ok" };
      } catch (e) {
        return { id: a.id, nome: a.nome, acesso: null, erro: (e as Error).message };
      }
    }),
  );
  console.log(JSON.stringify({ conta: c.conta, login_ok: true, escrita: cliente.podeEscrever ? "autorizada" : "não (token só de leitura: rode autorizar)", agendas }, null, 2));
}

async function listar(args: Args): Promise<void> {
  const c = credenciaisDoEnv();
  const cliente = await conectar(c);
  const { dias, lista } = await lerConfig();
  const { de, ate } = janela(args, dias);
  const papeis = new Map((await cliente.listaDeAgendas()).map((a) => [a.id, a.accessRole]));

  const agendas = await Promise.all(
    lista.map(async (a) => {
      const base = { id: a.id, nome: a.nome, papel: a.papel };
      try {
        const eventos = (await cliente.eventos(a.id, de, ate))
          .filter((e) => e.status !== "cancelled" && e.eventType !== "workingLocation")
          .map((e) => ({
            id: e.id,
            ...evento(e),
            titulo: e.summary ?? null,
            ...(e.location ? { local: e.location } : {}),
            ...(e.eventType && e.eventType !== "default" ? { tipo: e.eventType } : {}),
          }));
        const acesso = papeis.get(a.id) === "freeBusyReader" ? "livre_ocupado" : "detalhes";
        return { ...base, acesso, eventos };
      } catch (e) {
        if (!(e instanceof ErroApi) || (e.status !== 403 && e.status !== 404)) return { ...base, acesso: null, eventos: [], erro: (e as Error).message };
        // sem leitura de eventos: tenta só livre/ocupado
        try {
          const blocos = await cliente.ocupado(a.id, de, ate);
          const eventos = blocos.map((b) => {
            const ini = local(b.start);
            const fim = local(b.end);
            return { dia: ini.dia, hora: ini.hora, fim_dia: fim.dia, fim_hora: fim.hora, dia_inteiro: false, titulo: null };
          });
          return { ...base, acesso: "livre_ocupado", eventos };
        } catch (e2) {
          return { ...base, acesso: null, eventos: [], erro: `sem acesso pela conta ${c.conta}: ${(e2 as Error).message}` };
        }
      }
    }),
  );

  const pendencias = agendas.filter((a) => "erro" in a).map((a) => `agenda "${a.nome}" não lida: ${(a as { erro: string }).erro}`);
  console.log(
    JSON.stringify({ conta: c.conta, de: local(de.toISOString()).dia, ate: diaAnterior(local(ate.toISOString()).dia), agendas, pendencias }, null, 2),
  );
}

async function lerMensagem(args: Args, op: string): Promise<Record<string, unknown>> {
  const arq = typeof args.mensagem === "string" ? args.mensagem : "";
  const aprovadoPor = typeof args["aprovado-por"] === "string" ? args["aprovado-por"] : "";
  if (!arq || !aprovadoPor) throw new Error(`${op} exige --mensagem <arquivo.json> --aprovado-por <nome> (a escrita na agenda só sai depois de aprovada)`);
  return JSON.parse(await Bun.file(resolve(RAIZ, arq)).text()) as Record<string, unknown>;
}

async function criar(args: Args): Promise<void> {
  const m = await lerMensagem(args, "criar");
  const agenda = await resolverAgenda(m.agenda);
  const corpo = corpoEvento(m, false) as EventoEscrita;
  const cliente = await conectar();
  const e = await cliente.criarEvento(agenda.id, corpo);
  console.log(JSON.stringify({ criado: true, agenda: agenda.nome, evento: resumoEvento(e), link: e.htmlLink ?? null }, null, 2));
}

async function alterar(args: Args): Promise<void> {
  const m = await lerMensagem(args, "alterar");
  if (!m.evento) throw new Error("alterar exige evento (id, do listar)");
  const agenda = await resolverAgenda(m.agenda);
  const corpo = corpoEvento(m, true);
  const cliente = await conectar();
  const antes = await cliente.eventoPorId(agenda.id, String(m.evento));
  const depois = await cliente.alterarEvento(agenda.id, String(m.evento), corpo);
  console.log(JSON.stringify({ alterado: true, agenda: agenda.nome, antes: resumoEvento(antes), depois: resumoEvento(depois), link: depois.htmlLink ?? null }, null, 2));
}

async function main() {
  const { operacao, args } = parseArgs(process.argv);
  await carregarEnvDaRaiz();
  switch (operacao) {
    case "autorizar":
      await autorizar();
      break;
    case "testar":
      await testar();
      break;
    case "listar":
      await listar(args);
      break;
    case "criar":
      await criar(args);
      break;
    case "alterar":
      await alterar(args);
      break;
    default:
      console.error("Uso: bun run _pontes/calendario/facade.ts <autorizar | testar | listar | criar | alterar> [--dias N] [--desde AAAA-MM-DD] [--mensagem <arq.json> --aprovado-por <nome>]");
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
