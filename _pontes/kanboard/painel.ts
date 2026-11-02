/**
 * painel.ts -- leitura dos boards para o bom-dia do gestor. SOMENTE LEITURA.
 *
 * Para cada board em 01-gestor/fluxos/config.yaml (boards):
 *   - em aprovação, atrasados, vencendo em 7 dias, parados, sem dono, sem categoria, sem prazo
 *   - carga aberta por pessoa
 *   - o que mudou desde a leitura anterior (cards novos, movidos, concluídos, dono ou prazo trocados),
 *     inclusive o que a equipe ou o gestor mexeram direto no Kanboard
 *
 * Nomes de coluna, categoria e pessoa vêm da própria API (getColumns, getAllCategories,
 * getProjectUsers) -- sem mapa de IDs copiado.
 *
 * Saída: JSON no stdout. Efeito colateral: grava o retrato atual em
 * operacoes/painel/retrato-board.json (o próximo painel compara com ele).
 *
 * Uso (da raiz do assistente):
 *   bun run _pontes/kanboard/painel.ts
 *   bun run _pontes/kanboard/painel.ts --sem-gravar           (não atualiza o retrato)
 *   bun run _pontes/kanboard/painel.ts --fixture <arq.json>   (lê dados de teste em vez da API)
 */

import { join, resolve } from "node:path";
import { JsonRpcClient } from "./jsonrpc-client.ts";

const RAIZ = resolve(import.meta.dir, "..", "..");
const RETRATO = join(RAIZ, "operacoes", "painel", "retrato-board.json");
const DIA = 24 * 3600;

interface TarefaApi {
  id: number | string;
  title: string;
  project_id: number | string;
  column_id: number | string;
  category_id: number | string;
  owner_id: number | string;
  date_due: number | string;
  date_creation: number | string;
  date_modification: number | string;
  date_moved?: number | string;
}

interface ProjetoDados {
  id: number;
  nome: string;
  colunas: Record<string, string>;
  categorias: Record<string, string>;
  usuarios: Record<string, string>;
  tarefas: TarefaApi[];
}

interface Card {
  id: number;
  projeto: number;
  titulo: string;
  coluna: string;
  categoria: string | null;
  dono: string | null;
  prazo: string | null; // AAAA-MM-DD
  criado: string;
  ultimo_movimento: string;
  dias_parado: number;
  url: string;
}

interface Retrato {
  lido_em: string;
  cards: Record<string, Pick<Card, "projeto" | "titulo" | "coluna" | "dono" | "prazo">>;
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const iso = (unix: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : null);

function parseArgs(argv: string[]): Record<string, string | true> {
  const a: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) a[argv[i].slice(2)] = true;
    else a[argv[i].slice(2)] = v, i++;
  }
  return a;
}

async function carregarEnvDaRaiz(): Promise<void> {
  const arquivo = Bun.file(join(RAIZ, ".env"));
  if (!(await arquivo.exists())) return;
  for (const linha of (await arquivo.text()).split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}

async function lerConfig(): Promise<{ boards: { id: number; nome: string; opcional?: boolean }[]; parado_dias: number }> {
  const cfg = Bun.YAML.parse(await Bun.file(join(RAIZ, "01-gestor", "fluxos", "config.yaml")).text()) as {
    boards: { id: number; nome: string; opcional?: boolean }[];
    painel?: { parado_dias?: number };
  };
  return { boards: cfg.boards, parado_dias: cfg.painel?.parado_dias ?? 10 };
}

async function lerDaApi(client: JsonRpcClient, id: number, nome: string): Promise<ProjetoDados> {
  const [tarefas, colunas, categorias, usuarios] = await Promise.all([
    client.call<TarefaApi[]>("getAllTasks", { project_id: id, status_id: 1 }),
    client.call<{ id: number | string; title: string }[]>("getColumns", { project_id: id }),
    client.call<{ id: number | string; name: string }[]>("getAllCategories", { project_id: id }),
    client.call<Record<string, string>>("getProjectUsers", { project_id: id }),
  ]);
  return {
    id,
    nome,
    tarefas,
    colunas: Object.fromEntries(colunas.map((c) => [String(c.id), c.title])),
    categorias: Object.fromEntries(categorias.map((c) => [String(c.id), c.name.trim()])),
    usuarios,
  };
}

/** Corte de data por projeto (`ignorar_antes_de` em projetos.yaml). */
async function cortes(): Promise<Record<number, number>> {
  const mapa = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "projetos.yaml")).text()) as {
    projetos: { id: number | null; ignorar_antes_de?: string }[];
  };
  const out: Record<number, number> = {};
  for (const p of mapa.projetos) {
    if (p.id && p.ignorar_antes_de) out[p.id] = Math.floor(new Date(`${p.ignorar_antes_de}T00:00:00-03:00`).getTime() / 1000);
  }
  return out;
}

function urlCard(id: number, projeto: number): string {
  const base = (process.env.KANBOARD_API_URL ?? "https://board.cefor.ifes.edu.br/jsonrpc.php").replace(/jsonrpc\.php$/, "");
  return `${base}?controller=TaskViewController&action=show&task_id=${id}&project_id=${projeto}`;
}

function paraCards(p: ProjetoDados, corte: number | undefined, agora: number): Card[] {
  return p.tarefas
    .filter((t) => !corte || num(t.date_creation) >= corte)
    .map((t) => {
      const mov = Math.max(num(t.date_moved), num(t.date_modification), num(t.date_creation));
      const owner = String(num(t.owner_id));
      const cat = String(num(t.category_id));
      return {
        id: num(t.id),
        projeto: p.id,
        titulo: t.title,
        coluna: p.colunas[String(num(t.column_id))] ?? `coluna#${t.column_id}`,
        categoria: cat === "0" ? null : (p.categorias[cat] ?? `categoria#${cat}`),
        dono: owner === "0" ? null : (p.usuarios[owner] ?? `usuario#${owner}`),
        prazo: iso(num(t.date_due)),
        criado: iso(num(t.date_creation)) ?? "",
        ultimo_movimento: iso(mov) ?? "",
        dias_parado: Math.floor((agora - mov) / DIA),
        url: urlCard(num(t.id), p.id),
      };
    });
}

const ehAprovacao = (c: Card) => /aprova/i.test(c.coluna);
const ehBau = (c: Card) => /ba[uú]|backlog|solicitad/i.test(c.coluna);
const ehCongelado = (c: Card) => /congel/i.test(c.coluna);
const ehFinal = (c: Card) => /finaliz|conclu|publicad/i.test(c.coluna);
const resumo = (c: Card) => ({ id: c.id, projeto: c.projeto, titulo: c.titulo, coluna: c.coluna, dono: c.dono, prazo: c.prazo, dias_parado: c.dias_parado, url: c.url });

function analisar(cards: Card[], hoje: string, paradoDias: number) {
  const em7 = new Date(Date.parse(hoje) + 7 * DIA * 1000).toISOString().slice(0, 10);
  const ativos = cards.filter((c) => !ehCongelado(c) && !ehFinal(c));
  const carga: Record<string, { em_andamento: number; vence_7d: number; atrasados: number; total: number }> = {};
  for (const c of ativos) {
    if (!c.dono || ehBau(c)) continue;
    const k = c.dono;
    carga[k] ??= { em_andamento: 0, vence_7d: 0, atrasados: 0, total: 0 };
    carga[k].total++;
    if (/andamento|execu/i.test(c.coluna)) carga[k].em_andamento++;
    if (c.prazo && c.prazo < hoje) carga[k].atrasados++;
    else if (c.prazo && c.prazo <= em7) carga[k].vence_7d++;
  }
  return {
    em_aprovacao: cards.filter(ehAprovacao).map(resumo),
    atrasados: ativos.filter((c) => c.prazo && c.prazo < hoje).map(resumo),
    vence_7d: ativos.filter((c) => c.prazo && c.prazo >= hoje && c.prazo <= em7).map(resumo),
    parados: ativos.filter((c) => !ehBau(c) && c.dias_parado > paradoDias).sort((a, b) => b.dias_parado - a.dias_parado).map(resumo),
    sem_dono: ativos.filter((c) => !c.dono && !ehBau(c)).map(resumo),
    finalizados_abertos: cards.filter(ehFinal).length,
    fora_do_padrao: {
      sem_categoria: ativos.filter((c) => !c.categoria).length,
      sem_prazo_fora_do_bau: ativos.filter((c) => !c.prazo && !ehBau(c)).length,
    },
    carga_por_pessoa: carga,
  };
}

function compararRetratos(antes: Retrato | null, agora: Retrato) {
  if (!antes) return { desde: null, novos: [], movidos: [], saiu_dos_abertos: [], dono_trocado: [], prazo_trocado: [] };
  const novos = [], movidos = [], saiu = [], dono = [], prazo = [];
  for (const [id, c] of Object.entries(agora.cards)) {
    const a = antes.cards[id];
    if (!a) { novos.push({ id: Number(id), ...c }); continue; }
    if (a.coluna !== c.coluna) movidos.push({ id: Number(id), titulo: c.titulo, projeto: c.projeto, de: a.coluna, para: c.coluna });
    if (a.dono !== c.dono) dono.push({ id: Number(id), titulo: c.titulo, de: a.dono, para: c.dono });
    if (a.prazo !== c.prazo) prazo.push({ id: Number(id), titulo: c.titulo, de: a.prazo, para: c.prazo });
  }
  for (const [id, a] of Object.entries(antes.cards)) {
    // Saiu da lista de abertos: foi fechado, apagado ou movido para um board que o painel não lê.
    if (!agora.cards[id]) saiu.push({ id: Number(id), titulo: a.titulo, projeto: a.projeto, ultima_coluna: a.coluna });
  }
  return { desde: antes.lido_em, novos, movidos, saiu_dos_abertos: saiu, dono_trocado: dono, prazo_trocado: prazo };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await carregarEnvDaRaiz();
  const { boards, parado_dias } = await lerConfig();
  const corte = await cortes();
  const agora = typeof args.agora === "string" ? Math.floor(Date.parse(args.agora) / 1000) : Math.floor(Date.now() / 1000);
  const hoje = new Date((agora - 3 * 3600) * 1000).toISOString().slice(0, 10); // America/Sao_Paulo

  const projetos: ProjetoDados[] = [];
  const erros: { board: number; erro: string }[] = [];
  if (typeof args.fixture === "string") {
    projetos.push(...((await Bun.file(resolve(RAIZ, args.fixture)).json()) as { projetos: ProjetoDados[] }).projetos);
  } else {
    const client = new JsonRpcClient();
    // Uma chamada só antes de tudo: falhas repetidas de autenticação bloqueiam o usuário da API no Kanboard.
    try {
      await client.call("getVersion");
    } catch (e) {
      console.log(JSON.stringify({ erros: [{ board: null, erro: `autenticação recusada; nenhuma outra chamada feita: ${(e as Error).message.slice(0, 120)}` }] }, null, 2));
      process.exit(1);
    }
    for (const b of boards) {
      try {
        projetos.push(await lerDaApi(client, b.id, b.nome));
      } catch (e) {
        erros.push({ board: b.id, erro: (e as Error).message.slice(0, 200) });
        if (!b.opcional && /401|Unauthorized/.test((e as Error).message)) break; // token recusado: não insistir
      }
    }
  }

  const cards = projetos.flatMap((p) => paraCards(p, corte[p.id], agora));
  const retratoAgora: Retrato = {
    lido_em: new Date(agora * 1000).toISOString(),
    cards: Object.fromEntries(cards.map((c) => [String(c.id), { projeto: c.projeto, titulo: c.titulo, coluna: c.coluna, dono: c.dono, prazo: c.prazo }])),
  };
  const arq = Bun.file(RETRATO);
  const anterior = (await arq.exists()) ? ((await arq.json()) as Retrato) : null;
  // Retrato parcial (board falhou) não substitui o anterior, para não fabricar "saiu dos abertos".
  const completo = projetos.length > 0 && erros.every((e) => boards.find((b) => b.id === e.board)?.opcional);
  const mudancas = projetos.length ? compararRetratos(anterior, retratoAgora) : null;
  if (completo && !args["sem-gravar"] && typeof args.fixture !== "string") await Bun.write(RETRATO, JSON.stringify(retratoAgora, null, 1));

  console.log(
    JSON.stringify(
      {
        lido_em: retratoAgora.lido_em,
        hoje,
        boards_lidos: projetos.map((p) => ({ id: p.id, nome: p.nome, abertos: cards.filter((c) => c.projeto === p.id).length })),
        erros,
        por_board: Object.fromEntries(projetos.map((p) => [p.id, analisar(cards.filter((c) => c.projeto === p.id), hoje, parado_dias)])),
        mudou_desde_a_ultima_leitura: mudancas,
        retrato_gravado: completo && !args["sem-gravar"] && typeof args.fixture !== "string",
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.log(JSON.stringify({ erros: [{ board: null, erro: (e as Error).message }] }, null, 2));
    process.exit(1);
  }
}

export { analisar, compararRetratos, paraCards };
