/**
 * fila.ts -- fila de ações do assistente de gestão (F2). Determinístico, sem IA.
 *
 * Uma ação (AC) é o que o gestor decidiu fazer com uma questão de gestão (QG) e que SAI do
 * repositório: card no Kanboard, rascunho de e-mail, mensagem pronta para ele enviar.
 * O que é só do repositório (nota, lembrete, restrito, estado da QG) não passa pela fila:
 * a sessão grava direto com gestor.ts.
 *
 * Subcomandos (rode da raiz do assistente):
 *
 *   nova --qg QG-AAAA-NNNN --tipo <tipo> (--payload '<json>' | --payload-arquivo <arq.json>)
 *        --aprovado-por <nome> [--qg-apos concluida|aguardando|em_execucao]
 *       Valida o payload, resolve nomes (dono, coluna, categoria) para os IDs do board e põe a
 *       ação na fila. Só é chamado DEPOIS de o gestor aprovar a linha na sessão.
 *
 *   listar
 *       Ações pendentes, com tentativas e último erro.
 *
 *   cancelar --id AC-AAAA-NNNN --motivo <texto>
 *       Tira da fila (vai para executadas/ com o motivo). Não toca em nada fora do repositório.
 *
 *   executar [--ids AC-1,AC-2]
 *       Simula: mostra o lote que vai rodar. Não toca em nada.
 *
 *   executar --confirmado-por <nome> [--ids AC-1,AC-2]
 *       Roda o lote. Cada ação bem-sucedida vai para operacoes/fila/executadas/AAAA-MM.yaml e
 *       atualiza a QG; a que falha fica na fila com o erro. Se o Kanboard ou o e-mail recusar a
 *       autenticação, as ações seguintes daquele sistema nem são tentadas (401 em sequência
 *       bloqueia o usuário).
 *
 * Tipos: kanboard.criar | kanboard.mover | kanboard.comentar | kanboard.prazo | kanboard.dono |
 *        kanboard.subtarefa | kanboard.descricao | kanboard.categoria | email.rascunho | email.novo | aviso.pessoa |
 *        agenda.criar | agenda.alterar | agenda.cancelar
 *        (payloads em fluxos/catalogo-acoes.yaml)
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { conectar as conectarAgenda, corpoEvento, resolverAgenda, resumoEvento } from "../../_pontes/calendario/facade.ts";
import { conferirAnexos, enderecoDe } from "../../_pontes/email/facade.ts";
import { JsonRpcClient } from "../../_pontes/kanboard/jsonrpc-client.ts";
import { type Args, type QG, carregarRegistro, lerYaml, parseArgs, relogio, salvarMes, str, todas } from "./gestor.ts";

const RAIZ = resolve(import.meta.dir, "..", "..");
const FLUXOS = join(RAIZ, "01-gestor", "fluxos");
const FILA_DIR = join(RAIZ, "operacoes", "fila");
const FILA = join(FILA_DIR, "acoes.yaml");
const EXECUTADAS = join(FILA_DIR, "executadas");
const KANBOARD = join(RAIZ, "_pontes", "kanboard");
const FECHADOS = new Set(["concluida", "descartada"]);
const ESTADOS_APOS = new Set(["concluida", "aguardando", "em_execucao"]);

const CABECALHO_FILA = `# Fila de ações -- decididas e aprovadas na sessão, aguardando o executar.
# Escrito por 01-gestor/ferramentas/fila.ts. Executadas e canceladas saem daqui para executadas/AAAA-MM.yaml.
# Nunca entra aqui conteúdo sensível sobre pessoas (isso vai para 01-gestor/restrito/, fora da fila).
`;
const CABECALHO_EXEC = `# Ações executadas ou canceladas -- rastro de quem aprovou, quem confirmou o lote, quando e o resultado.
`;

type Payload = Record<string, unknown>;

interface Acao {
  id: string;
  qg: string;
  tipo: string;
  resumo: string;
  payload: Payload;
  qg_apos: string;
  criada_em: string;
  aprovado_por: string;
  aprovado_em: string;
  tentativas?: number;
  ultimo_erro?: string | null;
  lote_confirmado_por?: string;
  executado_em?: string;
  resultado?: Payload;
}

// ---------------------------------------------------------------- arquivos

async function lerFila(): Promise<Acao[]> {
  return (await lerYaml<Acao[] | null>(FILA, [])) ?? [];
}

async function salvarFila(fila: Acao[]): Promise<void> {
  await mkdir(FILA_DIR, { recursive: true });
  await Bun.write(FILA, CABECALHO_FILA + "\n" + (fila.length ? Bun.YAML.stringify(fila, null, 2) : "[]") + "\n");
}

async function arquivarExecutada(a: Acao, quando: string): Promise<void> {
  await mkdir(EXECUTADAS, { recursive: true });
  const arq = join(EXECUTADAS, `${quando.slice(0, 7)}.yaml`);
  const lista = (await lerYaml<Acao[] | null>(arq, [])) ?? [];
  lista.push(a);
  await Bun.write(arq, CABECALHO_EXEC + "\n" + Bun.YAML.stringify(lista, null, 2) + "\n");
}

async function proximoId(ano: string): Promise<string> {
  const ids = (await lerFila()).map((a) => a.id);
  try {
    for (const f of (await readdir(EXECUTADAS)).filter((x) => x.endsWith(".yaml"))) {
      ids.push(...((await lerYaml<Acao[] | null>(join(EXECUTADAS, f), [])) ?? []).map((a) => a.id));
    }
  } catch {
    // ainda não há executadas
  }
  const max = ids.map((i) => i.match(new RegExp(`^AC-${ano}-(\\d+)$`))).reduce((m, r) => (r ? Math.max(m, Number(r[1])) : m), 0);
  return `AC-${ano}-${String(max + 1).padStart(4, "0")}`;
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

// ---------------------------------------------------------------- nomes -> IDs do board

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

interface Usuario {
  kanboard_user_id: number | null;
  username?: string;
  nome_completo: string;
  papel: string;
  equipeCGTE?: boolean;
}
interface Item {
  id: number;
  nome: string;
  legado?: boolean;
}
interface Projeto {
  id: number;
  nome: string | null;
  colunas?: Item[];
  categorias?: Item[];
}
interface Pessoa {
  nome: string;
  kanboard_user_id?: number | null;
  apelidos?: string[];
  canal_padrao?: string;
  canal_direto?: string;
  presencial?: boolean;
  externo?: boolean;
  email?: string;
}

interface Mapa {
  projetos: Projeto[];
  usuarios: Usuario[];
  pessoas: Pessoa[];
  config: { kanboard?: { projeto_padrao?: number; coluna_padrao?: string; autor_id?: number }; caixas?: { conta: string; destino: string }[] };
}

async function carregarMapa(): Promise<Mapa> {
  return {
    projetos: (await lerYaml<{ projetos?: Projeto[] }>(join(KANBOARD, "projetos.yaml"), {})).projetos ?? [],
    usuarios: (await lerYaml<{ usuarios?: Usuario[] }>(join(KANBOARD, "usuarios.yaml"), {})).usuarios ?? [],
    pessoas: (await lerYaml<{ pessoas?: Pessoa[] }>(join(FLUXOS, "contatos.yaml"), {})).pessoas ?? [],
    config: await lerYaml(join(FLUXOS, "config.yaml"), {}),
  };
}

/** Dono por id, username, primeiro nome, nome completo ou apelido de contatos.yaml. Ambíguo = erro. */
function resolverUsuario(m: Mapa, v: unknown): { id: number; nome: string } {
  const validos = m.usuarios.filter((u) => u.kanboard_user_id && !["grupo", "sistema"].includes(u.papel));
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const u = validos.find((x) => x.kanboard_user_id === Number(v));
    if (!u) throw new Error(`usuário ${v} não está em usuarios.yaml (ou é conta de grupo/sistema)`);
    return { id: u.kanboard_user_id!, nome: u.nome_completo };
  }
  const n = norm(v);
  if (!n) throw new Error("dono vazio");
  const porApelido = m.pessoas.filter((p) => p.kanboard_user_id && [p.nome, ...(p.apelidos ?? [])].some((x) => norm(x) === n)).map((p) => p.kanboard_user_id);
  const exatos = validos.filter((u) => porApelido.includes(u.kanboard_user_id) || norm(u.username) === n || norm(u.nome_completo) === n || norm(u.nome_completo).split(" ")[0] === n);
  const candidatos = exatos.length ? exatos : validos.filter((u) => norm(u.nome_completo).split(" ").some((w) => w.startsWith(n)));
  if (candidatos.length === 1) return { id: candidatos[0].kanboard_user_id!, nome: candidatos[0].nome_completo };
  if (!candidatos.length) throw new Error(`ninguém em usuarios.yaml casa com "${v}"`);
  throw new Error(`"${v}" é ambíguo: ${candidatos.map((u) => `${u.nome_completo} (${u.kanboard_user_id})`).join(", ")}`);
}

function projetoDe(m: Mapa, v: unknown): Projeto {
  const id = Number(v ?? m.config.kanboard?.projeto_padrao);
  if (!id) throw new Error("sem projeto: passe projeto ou defina kanboard.projeto_padrao em 01-gestor/fluxos/config.yaml");
  return m.projetos.find((p) => p.id === id) ?? { id, nome: null };
}

/** Coluna ou categoria por id ou nome (igual ou começo do nome, sem acento). */
function resolverItem(lista: Item[] | undefined, v: unknown, oque: string, projeto: number): Item {
  const itens = (lista ?? []).filter((i) => !i.legado);
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const i = itens.find((x) => x.id === Number(v));
    if (i || !itens.length) return i ?? { id: Number(v), nome: `#${v}` };
    throw new Error(`${oque} ${v} não existe no projeto ${projeto}`);
  }
  if (!itens.length) throw new Error(`o projeto ${projeto} não tem ${oque}s mapeadas em projetos.yaml: passe o id numérico`);
  const n = norm(v);
  const achados = itens.filter((i) => norm(i.nome) === n);
  const parciais = achados.length ? achados : itens.filter((i) => norm(i.nome).startsWith(n));
  if (parciais.length === 1) return { id: parciais[0].id, nome: parciais[0].nome.trim() };
  if (!parciais.length) throw new Error(`${oque} "${v}" não existe no projeto ${projeto}. Opções: ${itens.map((i) => i.nome.trim()).join(" · ")}`);
  throw new Error(`${oque} "${v}" é ambígua: ${parciais.map((i) => i.nome.trim()).join(" · ")}`);
}

const ehData = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dataBr = (iso: string) => iso.split("-").reverse().join("/");
function exigir(p: Payload, campos: string[], tipo: string): void {
  const faltam = campos.filter((c) => p[c] === undefined || p[c] === null || p[c] === "");
  if (faltam.length) throw new Error(`${tipo} exige: ${faltam.join(", ")}`);
}
function cardId(p: Payload): number {
  const n = Number(String(p.card ?? "").replace(/^#/, ""));
  if (!n) throw new Error("payload exige card (número do card no Kanboard)");
  return n;
}

/** Valida e resolve o payload. Devolve o payload pronto para a API e a linha da tabela. */
async function montar(m: Mapa, tipo: string, p: Payload, qg: QG): Promise<{ payload: Payload; resumo: string }> {
  switch (tipo) {
    case "kanboard.criar": {
      exigir(p, ["titulo"], tipo);
      const proj = projetoDe(m, p.projeto);
      const col = resolverItem(proj.colunas, p.coluna ?? m.config.kanboard?.coluna_padrao ?? "Início autorizado", "coluna", proj.id);
      // Dono e prazo são obrigatórios fora do Baú de tarefas.
      const foraDoBau = !norm(col.nome).startsWith("bau");
      if (foraDoBau) exigir(p, ["dono", "prazo"], `card na coluna "${col.nome}"`);
      if (p.prazo !== undefined && !ehData(p.prazo)) throw new Error("prazo no formato AAAA-MM-DD");
      const cat = p.categoria ? resolverItem(proj.categorias, p.categoria, "categoria", proj.id) : null;
      const dono = p.dono ? resolverUsuario(m, p.dono) : null;
      const linhas = [
        p.solicitante ? `**Solicitante:** ${p.solicitante}` : null,
        p.contato ? `**Contato:** ${p.contato}` : null,
        `**Origem:** ${p.origem ? `${p.origem} · ` : ""}${qg.id} (registro de gestão)`,
        p.pronto ? `**O que é "pronto":** ${p.pronto}` : null,
        p.proximo_passo ? `**Próximo passo:** ${p.proximo_passo}` : null,
      ].filter(Boolean);
      const descricao = [linhas.join("\n"), p.descricao ? String(p.descricao) : null].filter(Boolean).join("\n\n");
      const subtarefas = Array.isArray(p.subtarefas) ? p.subtarefas.map(String) : [];
      return {
        payload: {
          project_id: proj.id,
          title: String(p.titulo),
          description: descricao,
          column_id: col.id,
          coluna: col.nome,
          ...(cat ? { category_id: cat.id, categoria: cat.nome } : {}),
          ...(dono ? { owner_id: dono.id, dono: dono.nome } : {}),
          ...(p.prazo ? { date_due: p.prazo } : {}),
          ...(subtarefas.length ? { subtarefas } : {}),
        },
        resumo: `card no ${proj.id}: "${p.titulo}" → ${dono?.nome.split(" ")[0] ?? "sem dono"}${p.prazo ? `, prazo ${dataBr(String(p.prazo))}` : ""}${cat ? `, ${cat.nome}` : ""}, coluna "${col.nome}"${subtarefas.length ? `, ${subtarefas.length} subtarefa(s)` : ""}`,
      };
    }
    case "kanboard.mover": {
      exigir(p, ["coluna"], tipo);
      const proj = projetoDe(m, p.projeto);
      const col = resolverItem(proj.colunas, p.coluna, "coluna", proj.id);
      const id = cardId(p);
      return { payload: { task_id: id, project_id: proj.id, column_id: col.id, coluna: col.nome }, resumo: `mover #${id} para "${col.nome}"` };
    }
    case "kanboard.comentar": {
      exigir(p, ["texto"], tipo);
      const id = cardId(p);
      return { payload: { task_id: id, content: String(p.texto) }, resumo: `comentar em #${id}: "${String(p.texto).slice(0, 70)}${String(p.texto).length > 70 ? "…" : ""}"` };
    }
    case "kanboard.prazo": {
      if (!ehData(p.prazo)) throw new Error("kanboard.prazo exige prazo AAAA-MM-DD");
      const id = cardId(p);
      return { payload: { task_id: id, date_due: p.prazo }, resumo: `prazo de #${id} para ${dataBr(String(p.prazo))}` };
    }
    case "kanboard.dono": {
      exigir(p, ["dono"], tipo);
      const id = cardId(p);
      const dono = resolverUsuario(m, p.dono);
      return { payload: { task_id: id, owner_id: dono.id, dono: dono.nome }, resumo: `dono de #${id} passa a ${dono.nome}` };
    }
    case "kanboard.descricao": {
      exigir(p, ["texto"], tipo);
      const id = cardId(p);
      return { payload: { task_id: id, description: String(p.texto) }, resumo: `nova descrição em #${id} (${String(p.texto).split("\n").length} linhas, substitui a atual)` };
    }
    case "kanboard.categoria": {
      exigir(p, ["categoria"], tipo);
      const proj = projetoDe(m, p.projeto);
      const cat = resolverItem(proj.categorias, p.categoria, "categoria", proj.id);
      const id = cardId(p);
      return { payload: { task_id: id, category_id: cat.id, categoria: cat.nome }, resumo: `categoria de #${id} para ${cat.nome}` };
    }
    case "kanboard.subtarefa": {
      const titulos = Array.isArray(p.titulos) ? p.titulos.map(String) : p.titulo ? [String(p.titulo)] : [];
      if (!titulos.length) throw new Error("kanboard.subtarefa exige titulo ou titulos");
      const id = cardId(p);
      const dono = p.dono ? resolverUsuario(m, p.dono) : null;
      return {
        payload: { task_id: id, titulos, ...(dono ? { user_id: dono.id, dono: dono.nome } : {}) },
        resumo: `${titulos.length} subtarefa(s) em #${id}${dono ? ` para ${dono.nome.split(" ")[0]}` : ""}: ${titulos.join(" · ").slice(0, 80)}`,
      };
    }
    case "email.rascunho": {
      exigir(p, ["corpo"], tipo);
      const conta = String(p.conta ?? "pessoal");
      const destino = m.config.caixas?.find((c) => c.conta === conta)?.destino;
      if (!destino) throw new Error(`conta "${conta}" não está em fluxos/config.yaml (caixas)`);
      const arquivo = String(p.arquivo ?? (qg.arquivos ?? []).find((a) => a.startsWith(destino)) ?? "");
      if (!arquivo) throw new Error(`a ${qg.id} não tem e-mail da conta ${conta} ligado: passe arquivo`);
      const f = Bun.file(join(RAIZ, arquivo));
      if (!(await f.exists())) throw new Error(`${arquivo} não existe nesta máquina (rode a varredura da caixa ${conta})`);
      const texto = await f.text();
      if (!/^ews_item_id:/m.test(texto)) throw new Error(`${arquivo} não tem ews_item_id`);
      const assunto = texto.match(/^assunto:\s*(.+)$/m)?.[1]?.replace(/^"(.*)"$/, "$1") ?? "";
      const palavras = String(p.corpo).split(/\s+/).filter(Boolean).length;
      return {
        payload: { conta, arquivo, corpo: String(p.corpo), todos: p.todos === true },
        resumo: `rascunho de resposta${p.todos === true ? " a todos" : ""} (${conta}) a "${assunto.slice(0, 60)}", ${palavras} palavras`,
      };
    }
    case "email.novo": {
      exigir(p, ["para", "assunto", "corpo"], tipo);
      const conta = String(p.conta ?? "pessoal");
      if (!m.config.caixas?.some((c) => c.conta === conta)) throw new Error(`conta "${conta}" não está em fluxos/config.yaml (caixas)`);
      // nome ou apelido com email em contatos.yaml vira "Nome <endereço>"; o resto passa como veio
      const comEndereco = (s: string) => {
        if (enderecoDe(s)) return s;
        const pessoa = m.pessoas.find((x) => x.email && [x.nome, ...(x.apelidos ?? [])].some((n) => norm(n) === norm(s)));
        return pessoa ? `${pessoa.nome} <${pessoa.email}>` : s;
      };
      const lista = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? String(v).split(/[;,]/) : []).map((s) => s.trim()).filter(Boolean).map(comEndereco);
      const para = lista(p.para);
      const cc = lista(p.cc);
      const semEndereco = [...para, ...cc].filter((x) => !enderecoDe(x));
      if (semEndereco.length) throw new Error(`sem endereço de e-mail: ${semEndereco.join(", ")} (não tem email em contatos.yaml: passe "Nome <x@ifes.edu.br>")`);
      // anexos: lista de caminhos a partir da raiz (não divide por vírgula: nome de arquivo pode ter)
      const anexos = await conferirAnexos(Array.isArray(p.anexos) ? p.anexos.map(String) : p.anexos ? [String(p.anexos)] : []);
      const palavras = String(p.corpo).split(/\s+/).filter(Boolean).length;
      return {
        payload: { conta, para, cc, assunto: String(p.assunto), corpo: String(p.corpo), anexos: anexos.map((a) => a.caminho) },
        resumo: `e-mail novo (${conta}) para ${para.join(", ")}${cc.length ? ` · cc ${cc.join(", ")}` : ""}: "${String(p.assunto).slice(0, 60)}", ${palavras} palavras${anexos.length ? `, anexos: ${anexos.map((a) => a.nome).join(", ")}` : ""}`,
      };
    }
    case "aviso.pessoa": {
      exigir(p, ["para", "texto"], tipo);
      const pessoa = m.pessoas.find((x) => [x.nome, ...(x.apelidos ?? [])].some((n) => norm(n) === norm(p.para)));
      const canal = String(p.canal ?? pessoa?.canal_direto ?? "whatsapp");
      return { payload: { para: String(p.para), canal, texto: String(p.texto) }, resumo: `mensagem pronta para ${p.para} (${canal}), você envia` };
    }
    case "agenda.criar":
    case "agenda.alterar": {
      const alterar = tipo === "agenda.alterar";
      if (alterar) exigir(p, ["agenda", "evento"], tipo);
      else exigir(p, ["agenda", "titulo", "inicio", "fim"], tipo);
      const agenda = await resolverAgenda(p.agenda);
      const corpo = corpoEvento(p, alterar); // valida datas e campos
      const campos = Object.fromEntries(["titulo", "local", "descricao", "inicio", "fim"].filter((k) => p[k] !== undefined).map((k) => [k, String(p[k])]));
      const quando = (i: unknown, fim: unknown) => (i === fim ? fmt(i) : `${fmt(i)} a ${fmt(fim)}`);
      const fmt = (v: unknown) => String(v).replace(/^(\d{4})-(\d{2})-(\d{2})/, "$3/$2").replace("T", " ");
      if (!alterar) {
        return {
          payload: { agenda: agenda.id, agenda_nome: agenda.nome, ...campos },
          resumo: `evento novo em "${agenda.nome}": "${p.titulo}", ${quando(p.inicio, p.fim)}`,
        };
      }
      // Confere o evento na aprovação, para a tabela mostrar o antes e o depois.
      let antes = "";
      try {
        await carregarEnvDaRaiz();
        const e = resumoEvento(await (await conectarAgenda()).eventoPorId(agenda.id, String(p.evento)));
        antes = `${qg.sensivel ? "(título omitido: QG sensível)" : `"${e.titulo}"`}, ${quando(e.hora ? `${e.dia}T${e.hora}` : e.dia, e.fim_hora ? `${e.fim_dia}T${e.fim_hora}` : e.fim_dia)}`;
      } catch (e) {
        if (/\b404\b/.test((e as Error).message)) throw new Error(`evento ${p.evento} não existe em "${agenda.nome}" (pegue o id no listar da ponte)`);
        antes = `(não conferido: ${(e as Error).message.slice(0, 60)})`;
      }
      const mudancas = [
        corpo.summary !== undefined ? `título "${corpo.summary}"` : null,
        p.inicio !== undefined ? quando(p.inicio, p.fim) : null,
        corpo.location !== undefined ? `local "${corpo.location}"` : null,
        corpo.description !== undefined ? "descrição nova" : null,
      ].filter(Boolean);
      return {
        payload: { agenda: agenda.id, agenda_nome: agenda.nome, evento: String(p.evento), ...campos },
        resumo: `alterar evento em "${agenda.nome}": ${antes} → ${mudancas.join(", ")}`,
      };
    }
    case "agenda.cancelar": {
      exigir(p, ["agenda", "ocorrencias"], tipo);
      const agenda = await resolverAgenda(p.agenda);
      const ids = (Array.isArray(p.ocorrencias) ? p.ocorrencias : [p.ocorrencias]).map(String).filter(Boolean);
      if (!ids.length) throw new Error("agenda.cancelar exige ocorrencias (lista de ids do listar)");
      // Confere cada ocorrência na aprovação: tem de existir e ser de uma série.
      await carregarEnvDaRaiz();
      const cliente = await conectarAgenda();
      const dias: string[] = [];
      const series = new Set<string>();
      for (const id of ids) {
        const e = await cliente.eventoPorId(agenda.id, id).catch((err: Error) => {
          throw new Error(`ocorrência ${id} não encontrada em "${agenda.nome}": ${err.message.slice(0, 60)}`);
        });
        if (!e.recurringEventId) throw new Error(`${id} não é ocorrência de uma série: a fila não apaga evento avulso nem série inteira`);
        series.add(e.recurringEventId);
        dias.push((e.start?.date ?? e.start?.dateTime ?? "").slice(0, 10));
      }
      dias.sort();
      const br = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
      return {
        payload: { agenda: agenda.id, agenda_nome: agenda.nome, ocorrencias: ids },
        resumo: `cancelar ${ids.length} ocorrência(s) em "${agenda.nome}" (${series.size} série(s), que continuam): ${br(dias[0])} a ${br(dias[dias.length - 1])}`,
      };
    }
    default:
      throw new Error(`tipo desconhecido: ${tipo}. Veja fluxos/catalogo-acoes.yaml`);
  }
}

// ---------------------------------------------------------------- comandos

async function nova(args: Args) {
  const { agoraIso } = relogio(args);
  const qgId = str(args, "qg");
  const tipo = str(args, "tipo");
  const aprovadoPor = str(args, "aprovado-por");
  if (!qgId || !tipo || !aprovadoPor) throw new Error("nova exige --qg, --tipo e --aprovado-por (a ação só entra na fila depois de aprovada)");
  const bruto = str(args, "payload-arquivo") ? await Bun.file(resolve(RAIZ, str(args, "payload-arquivo")!)).text() : str(args, "payload");
  if (!bruto) throw new Error("nova exige --payload '<json>' ou --payload-arquivo <arq.json>");
  const payload = JSON.parse(bruto) as Payload;
  const qgApos = str(args, "qg-apos") ?? "concluida";
  if (!ESTADOS_APOS.has(qgApos)) throw new Error(`--qg-apos deve ser: ${[...ESTADOS_APOS].join(" | ")}`);

  const reg = await carregarRegistro();
  let mesQG = "";
  let qg: QG | undefined;
  for (const [mes, lista] of reg) {
    qg = lista.find((q) => q.id === qgId);
    if (qg) {
      mesQG = mes;
      break;
    }
  }
  if (!qg) throw new Error(`${qgId} não encontrada no registro`);
  if (FECHADOS.has(qg.estado)) throw new Error(`${qgId} está ${qg.estado}: reabra com gestor.ts qg-atualizar --estado decidida antes`);

  const montado = await montar(await carregarMapa(), tipo, payload, qg);
  const fila = await lerFila();
  const acao: Acao = {
    id: await proximoId(agoraIso.slice(0, 4)),
    qg: qgId,
    tipo,
    resumo: montado.resumo,
    payload: montado.payload,
    qg_apos: qgApos,
    criada_em: agoraIso,
    aprovado_por: aprovadoPor,
    aprovado_em: agoraIso,
  };
  fila.push(acao);
  await salvarFila(fila);

  qg.acoes = [...(qg.acoes ?? []), acao.id];
  if (qg.estado === "nova") qg.estado = "decidida";
  qg.atualizada_em = agoraIso;
  await salvarMes(mesQG, reg.get(mesQG)!);
  console.log(JSON.stringify({ na_fila: acao.id, qg: qgId, resumo: acao.resumo, payload: acao.payload }, null, 2));
}

function linha(a: Acao): string {
  const erro = a.ultimo_erro ? `  [${a.tentativas}x falhou: ${a.ultimo_erro.slice(0, 80)}]` : "";
  return `${a.id}  ${a.qg}  ${a.tipo.padEnd(18)} ${a.resumo}${erro}`;
}

async function listar() {
  const fila = await lerFila();
  for (const a of fila) console.log(linha(a));
  console.log(`${fila.length} ação(ões) na fila`);
}

async function cancelar(args: Args) {
  const { agoraIso } = relogio(args);
  const id = str(args, "id");
  const motivo = str(args, "motivo");
  if (!id || !motivo) throw new Error("cancelar exige --id e --motivo");
  const fila = await lerFila();
  const a = fila.find((x) => x.id === id);
  if (!a) throw new Error(`${id} não está na fila`);
  a.resultado = { cancelada: motivo };
  a.executado_em = agoraIso;
  await arquivarExecutada(a, agoraIso);
  await salvarFila(fila.filter((x) => x.id !== id));
  await atualizarQG(a, `${a.id} cancelada: ${motivo}`, null, agoraIso, fila.filter((x) => x.id !== id));
  console.log(JSON.stringify({ cancelada: id }));
}

/** Nota na QG; quando não sobra ação dela na fila, a QG vai para o estado combinado. */
async function atualizarQG(a: Acao, nota: string, destino: string | null, agoraIso: string, filaRestante: Acao[]) {
  const reg = await carregarRegistro();
  for (const [mes, lista] of reg) {
    const qg = lista.find((q) => q.id === a.qg);
    if (!qg) continue;
    qg.notas = [...(qg.notas ?? []), `${agoraIso.slice(0, 10)}: ${nota}`];
    if (destino) qg.destino = qg.destino && qg.destino !== destino ? `${qg.destino}, ${destino}` : destino;
    const sobrando = filaRestante.some((x) => x.qg === a.qg);
    if (!sobrando && !a.resultado?.cancelada) qg.estado = a.qg_apos;
    else if (sobrando && qg.estado === "decidida") qg.estado = "em_execucao";
    qg.atualizada_em = agoraIso;
    await salvarMes(mes, lista);
    return;
  }
}

const SISTEMA = (tipo: string) =>
  tipo.startsWith("kanboard.") ? "kanboard" : tipo.startsWith("email.") ? "email" : tipo.startsWith("agenda.") ? "agenda" : "local";
const ehRecusaDeAutenticacao = (msg: string) => /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(msg);

async function executar(args: Args) {
  const ids = str(args, "ids")?.split(",").map((s) => s.trim());
  const fila = await lerFila();
  const lote = fila.filter((a) => !ids || ids.includes(a.id));
  if (ids) for (const i of ids) if (!fila.some((a) => a.id === i)) throw new Error(`${i} não está na fila`);
  const confirmadoPor = str(args, "confirmado-por");

  if (!confirmadoPor) {
    console.log(`LOTE (${lote.length} ação(ões)) -- simulação, nada foi executado`);
    for (const a of lote) console.log(`  ${linha(a)}`);
    console.log(`\nPara rodar: bun run 01-gestor/ferramentas/fila.ts executar --confirmado-por <nome>${ids ? ` --ids ${ids.join(",")}` : ""}`);
    return;
  }

  await carregarEnvDaRaiz();
  const cfg = (await carregarMapa()).config;
  const autor = cfg.kanboard?.autor_id ?? 0; // 0 = falta kanboard.autor_id no config.yaml (o mapear.ts preenche)
  let kb: JsonRpcClient | null = null;
  const bloqueado = new Map<string, string>(); // sistema ou email:<conta> -> motivo
  const resultados: { id: string; ok: boolean; resumo: string; detalhe: string }[] = [];
  const mensagens: Payload[] = [];
  let restante = [...fila];

  for (const a of lote) {
    const { agoraIso } = relogio({});
    const chaveBloqueio = SISTEMA(a.tipo) === "email" ? `email:${a.payload.conta}` : SISTEMA(a.tipo);
    if (bloqueado.has(chaveBloqueio)) {
      a.ultimo_erro = `não tentada: ${bloqueado.get(chaveBloqueio)}`;
      resultados.push({ id: a.id, ok: false, resumo: a.resumo, detalhe: a.ultimo_erro });
      await salvarFila(restante);
      continue;
    }
    try {
      let resultado: Payload;
      let destino: string | null = null;
      let nota: string;
      const p = a.payload;
      if (SISTEMA(a.tipo) === "kanboard" && !kb) {
        try {
          kb = new JsonRpcClient();
        } catch (e) {
          bloqueado.set("kanboard", `Kanboard sem configuração no .env`);
          throw e;
        }
      }
      const base = (process.env.KANBOARD_API_URL ?? "").replace(/jsonrpc\.php$/, "");
      const url = (t: unknown) => `${base}?controller=TaskViewController&action=show&task_id=${t}`;

      switch (a.tipo) {
        case "kanboard.criar": {
          const params: Payload = { project_id: p.project_id, title: p.title, description: p.description, column_id: p.column_id };
          for (const k of ["category_id", "owner_id", "date_due"]) if (p[k] !== undefined) params[k] = p[k];
          const id = await kb!.call<number | false>("createTask", params);
          if (!id) throw new Error("createTask não criou o card (campos recusados pelo Kanboard)");
          // O card já existe: falha numa subtarefa vira aviso, não erro (repetir a ação duplicaria o card).
          const falhas: string[] = [];
          for (const t of (p.subtarefas as string[] | undefined) ?? []) {
            try {
              if (!(await kb!.call("createSubtask", { task_id: id, title: t, ...(p.owner_id ? { user_id: p.owner_id } : {}) }))) falhas.push(t);
            } catch (e) {
              falhas.push(`${t} (${(e as Error).message})`);
            }
          }
          resultado = { card_id: id, url: url(id), ...(falhas.length ? { subtarefas_nao_criadas: falhas } : {}) };
          destino = `card:${p.project_id}#${id}`;
          nota = `${a.id}: card #${id} criado (${p.title})${falhas.length ? `; ${falhas.length} subtarefa(s) não criada(s)` : ""}`;
          break;
        }
        case "kanboard.mover": {
          const t = await kb!.call<{ project_id: string; swimlane_id: string } | null>("getTask", { task_id: p.task_id });
          if (!t) throw new Error(`card #${p.task_id} não encontrado`);
          if (Number(t.project_id) !== Number(p.project_id)) throw new Error(`card #${p.task_id} é do projeto ${t.project_id}, não do ${p.project_id}`);
          const ok = await kb!.call("moveTaskPosition", { project_id: p.project_id, task_id: p.task_id, column_id: p.column_id, position: 1, swimlane_id: Number(t.swimlane_id) });
          if (!ok) throw new Error("moveTaskPosition recusado");
          resultado = { card_id: p.task_id, url: url(p.task_id), coluna: p.coluna };
          nota = `${a.id}: #${p.task_id} movido para "${p.coluna}"`;
          break;
        }
        case "kanboard.comentar": {
          // O autor no Kanboard é o usuário da API; a assinatura diz quem aprovou o comentário.
          const content = `${p.content}\n\n_${a.aprovado_por}_`;
          const id = await kb!.call<number | false>("createComment", { task_id: p.task_id, user_id: autor, content });
          if (!id) throw new Error("createComment recusado");
          resultado = { card_id: p.task_id, comentario_id: id, url: url(p.task_id) };
          nota = `${a.id}: comentário em #${p.task_id}`;
          break;
        }
        case "kanboard.prazo":
        case "kanboard.dono":
        case "kanboard.descricao":
        case "kanboard.categoria": {
          const campo =
            a.tipo === "kanboard.prazo" ? { date_due: p.date_due }
            : a.tipo === "kanboard.dono" ? { owner_id: p.owner_id }
            : a.tipo === "kanboard.descricao" ? { description: p.description }
            : { category_id: p.category_id };
          if (!(await kb!.call("updateTask", { id: p.task_id, ...campo }))) throw new Error("updateTask recusado");
          resultado = { card_id: p.task_id, url: url(p.task_id), ...(a.tipo === "kanboard.descricao" ? {} : campo) };
          nota =
            a.tipo === "kanboard.prazo" ? `${a.id}: prazo de #${p.task_id} → ${p.date_due}`
            : a.tipo === "kanboard.dono" ? `${a.id}: dono de #${p.task_id} → ${p.dono}`
            : a.tipo === "kanboard.descricao" ? `${a.id}: descrição de #${p.task_id} reescrita`
            : `${a.id}: categoria de #${p.task_id} → ${p.categoria}`;
          break;
        }
        case "kanboard.subtarefa": {
          const criadas: number[] = [];
          for (const t of p.titulos as string[]) {
            const id = await kb!.call<number | false>("createSubtask", { task_id: p.task_id, title: t, ...(p.user_id ? { user_id: p.user_id } : {}) });
            if (!id) throw new Error(`createSubtask recusado em "${t}"${criadas.length ? ` (${criadas.length} já criadas: não repita a ação inteira)` : ""}`);
            criadas.push(id);
          }
          resultado = { card_id: p.task_id, subtarefas: criadas, url: url(p.task_id) };
          nota = `${a.id}: ${criadas.length} subtarefa(s) em #${p.task_id}`;
          break;
        }
        case "email.rascunho": {
          const corpo = join(tmpdir(), `cerebro-${a.id}.txt`);
          await Bun.write(corpo, String(p.corpo));
          const cmd = [process.execPath, "run", join(RAIZ, "_pontes", "email", "facade.ts"), "rascunho", "--conta", String(p.conta), "--entrada", String(p.arquivo), "--corpo", corpo, "--aprovado-por", a.aprovado_por];
          if (p.todos) cmd.push("--todos");
          const proc = Bun.spawn(cmd, { cwd: RAIZ, stdout: "pipe", stderr: "pipe" });
          const [saida, erro, codigo] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text(), await proc.exited];
          await unlink(corpo).catch(() => {});
          if (codigo !== 0) throw new Error((erro || saida).trim().split("\n").pop() ?? `saída ${codigo}`);
          const r = JSON.parse(saida) as Payload;
          resultado = { rascunho_salvo: true, caixa: r.caixa, pasta: "Rascunhos" };
          destino = `rascunho:${p.conta}`;
          nota = `${a.id}: rascunho salvo na caixa ${p.conta} (envio é seu, pelo webmail)`;
          break;
        }
        case "email.novo": {
          const msg = join(tmpdir(), `cerebro-${a.id}.json`);
          await Bun.write(msg, JSON.stringify({ para: p.para, cc: p.cc, assunto: p.assunto, corpo: p.corpo, anexos: p.anexos }));
          const cmd = [process.execPath, "run", join(RAIZ, "_pontes", "email", "facade.ts"), "novo", "--conta", String(p.conta), "--mensagem", msg, "--aprovado-por", a.aprovado_por];
          const proc = Bun.spawn(cmd, { cwd: RAIZ, stdout: "pipe", stderr: "pipe" });
          const [saida, erro, codigo] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text(), await proc.exited];
          await unlink(msg).catch(() => {});
          if (codigo !== 0) throw new Error((erro || saida).trim().split("\n").pop() ?? `saída ${codigo}`);
          const r = JSON.parse(saida) as Payload;
          // O rascunho já existe: anexo que falhou vira aviso, não erro (repetir a ação duplicaria o rascunho).
          resultado = { rascunho_salvo: true, caixa: r.caixa, pasta: "Rascunhos", ...(r.anexos_nao_incluidos ? { anexos_nao_incluidos: r.anexos_nao_incluidos } : {}) };
          destino = `rascunho:${p.conta}`;
          nota = `${a.id}: rascunho novo salvo na caixa ${p.conta} para ${(p.para as string[]).join(", ")}${r.anexos_nao_incluidos ? "; ANEXOS NÃO ENTRARAM, anexe à mão" : ""} (envio é seu, pelo webmail)`;
          break;
        }
        case "aviso.pessoa": {
          const link = p.canal === "whatsapp" ? `https://wa.me/?text=${encodeURIComponent(String(p.texto))}` : null;
          resultado = { para: p.para, canal: p.canal, ...(link ? { link } : {}), entregue_ao_gestor: true };
          mensagens.push({ para: p.para, canal: p.canal, texto: p.texto, ...(link ? { link } : {}) });
          nota = `${a.id}: mensagem para ${p.para} (${p.canal}) entregue ao gestor para enviar`;
          break;
        }
        case "agenda.criar":
        case "agenda.alterar": {
          const cliente = await conectarAgenda();
          if (a.tipo === "agenda.criar") {
            const e = await cliente.criarEvento(String(p.agenda), corpoEvento(p, false) as Parameters<typeof cliente.criarEvento>[1]);
            resultado = { agenda: p.agenda_nome, evento: resumoEvento(e), url: e.htmlLink ?? null };
            nota = `${a.id}: evento "${e.summary}" criado em "${p.agenda_nome}"`;
          } else {
            // Sem título no rastro: o título pode ser de assunto sensível e o rastro vai para o git.
            const { titulo: _t1, ...antes } = resumoEvento(await cliente.eventoPorId(String(p.agenda), String(p.evento)));
            const { titulo: _t2, ...depois } = resumoEvento(await cliente.alterarEvento(String(p.agenda), String(p.evento), corpoEvento(p, true)));
            resultado = { agenda: p.agenda_nome, antes, depois };
            nota = `${a.id}: evento alterado em "${p.agenda_nome}" (${antes.dia}–${antes.fim_dia} → ${depois.dia}–${depois.fim_dia})`;
          }
          destino = `agenda:${p.agenda_nome}`;
          break;
        }
        case "agenda.cancelar": {
          const cliente = await conectarAgenda();
          const feitas: { id: string; ja_estava: boolean }[] = [];
          for (const id of p.ocorrencias as string[]) {
            try {
              const r = await cliente.cancelarOcorrencia(String(p.agenda), id);
              feitas.push({ id: r.id, ja_estava: r.ja_estava });
            } catch (e) {
              // Repetir a ação é seguro: as já canceladas contam como feitas.
              throw new Error(`${(e as Error).message} (${feitas.length} de ${(p.ocorrencias as string[]).length} já canceladas; pode repetir a ação)`);
            }
          }
          resultado = { agenda: p.agenda_nome, canceladas: feitas.filter((x) => !x.ja_estava).length, ja_estavam: feitas.filter((x) => x.ja_estava).length };
          destino = `agenda:${p.agenda_nome}`;
          nota = `${a.id}: ${feitas.length} ocorrência(s) canceladas em "${p.agenda_nome}" (as séries continuam)`;
          break;
        }
        default:
          throw new Error(`tipo desconhecido: ${a.tipo}`);
      }

      a.tentativas = (a.tentativas ?? 0) + 1;
      a.ultimo_erro = null;
      a.lote_confirmado_por = confirmadoPor;
      a.executado_em = agoraIso;
      a.resultado = resultado;
      restante = restante.filter((x) => x.id !== a.id);
      await arquivarExecutada(a, agoraIso);
      await salvarFila(restante);
      await atualizarQG(a, nota, destino, agoraIso, restante);
      resultados.push({ id: a.id, ok: true, resumo: a.resumo, detalhe: String(resultado.url ?? resultado.link ?? nota) });
    } catch (e) {
      const msg = (e as Error).message;
      a.tentativas = (a.tentativas ?? 0) + 1;
      a.ultimo_erro = msg;
      if (ehRecusaDeAutenticacao(msg)) bloqueado.set(chaveBloqueio, `${chaveBloqueio} recusou a autenticação nesta rodada (${msg.slice(0, 60)})`);
      await salvarFila(restante);
      resultados.push({ id: a.id, ok: false, resumo: a.resumo, detalhe: msg });
    }
  }

  const ok = resultados.filter((r) => r.ok).length;
  console.log(`EXECUTADO: ${ok} ok · ${resultados.length - ok} falha(s) · confirmado por ${confirmadoPor}`);
  for (const r of resultados) console.log(`  ${r.ok ? "ok   " : "FALHA"} ${r.id}  ${r.resumo}\n         ${r.detalhe}`);
  if (mensagens.length) {
    console.log("\nMENSAGENS PARA VOCÊ ENVIAR");
    for (const mm of mensagens) console.log(`  → ${mm.para} (${mm.canal})${mm.link ? `  ${mm.link}` : ""}\n    ${String(mm.texto).replace(/\n/g, "\n    ")}`);
  }
  if (bloqueado.size) console.log(`\nATENÇÃO: ${[...bloqueado.values()].join("; ")}. Não rode de novo antes de conferir a credencial.`);
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "nova":
      return nova(args);
    case "listar":
      return listar();
    case "cancelar":
      return cancelar(args);
    case "executar":
      return executar(args);
    default:
      console.error("Uso: bun run 01-gestor/ferramentas/fila.ts <nova | listar | cancelar | executar> [opções]");
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
