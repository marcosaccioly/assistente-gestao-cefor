/**
 * mapear.ts -- lê do Kanboard os seus boards e grava os mapas que o assistente usa.
 *
 * Só lê o board. Escreve dois arquivos aqui na pasta:
 *   projetos.yaml  -- colunas e categorias de cada board (nomes -> ids, para a fila criar e mover cards)
 *   usuarios.yaml  -- quem está em cada board (nome -> id, para delegar)
 *
 * Uso (da raiz do assistente; o Bun lê o .env sozinho):
 *   bun run _pontes/kanboard/mapear.ts                  -- mostra seu id e os boards de que você participa
 *   bun run _pontes/kanboard/mapear.ts --projetos 12,15 -- grava os mapas desses boards (sobrescreve)
 *
 * Rode de novo quando uma coluna, categoria ou pessoa mudar no board.
 */

import { join } from "node:path";
import { JsonRpcClient } from "./jsonrpc-client.ts";

interface Coluna { id: number | string; title: string; position: number | string }
interface Categoria { id: number | string; name: string }

function projetosDoArg(): number[] {
  const i = process.argv.indexOf("--projetos");
  if (i < 0) return [];
  return String(process.argv[i + 1] ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

async function main() {
  const kb = new JsonRpcClient();
  const eu = await kb.call<{ id: number | string; username: string; name?: string }>("getMe");
  const ids = projetosDoArg();

  if (!ids.length) {
    const meus = await kb.call<{ id: number | string; name: string }[]>("getMyProjects");
    console.log(`Você: ${eu.name || eu.username} (id ${eu.id}) -- use este id em kanboard.autor_id do config.yaml`);
    console.log("\nSeus boards:");
    for (const p of meus) console.log(`  ${p.id}  ${p.name}`);
    console.log("\nGrave os mapas dos boards que o assistente vai usar:\n  bun run _pontes/kanboard/mapear.ts --projetos <id>,<id>");
    return;
  }

  const projetos: unknown[] = [];
  const usuarios = new Map<number, { kanboard_user_id: number; nome_completo: string; papel: string }>();
  for (const id of ids) {
    const [proj, colunas, categorias, membros] = await Promise.all([
      kb.call<{ id: number | string; name: string }>("getProjectById", { project_id: id }),
      kb.call<Coluna[]>("getColumns", { project_id: id }),
      kb.call<Categoria[]>("getAllCategories", { project_id: id }),
      kb.call<Record<string, string>>("getProjectUsers", { project_id: id }),
    ]);
    projetos.push({
      id,
      nome: proj.name,
      colunas: [...colunas].sort((a, b) => Number(a.position) - Number(b.position)).map((c) => ({ id: Number(c.id), nome: c.title })),
      categorias: categorias.map((c) => ({ id: Number(c.id), nome: c.name.trim() })),
    });
    for (const [uid, nome] of Object.entries(membros)) {
      const n = Number(uid);
      usuarios.set(n, { kanboard_user_id: n, nome_completo: nome, papel: n === Number(eu.id) ? "gestor" : "servidor" });
    }
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const cab = (o: string) => `# ${o} -- gerado por _pontes/kanboard/mapear.ts em ${hoje}. Rode de novo quando o board mudar.\n`;
  await Bun.write(join(import.meta.dir, "projetos.yaml"), cab("projetos.yaml") + Bun.YAML.stringify({ projetos }, null, 2));
  await Bun.write(
    join(import.meta.dir, "usuarios.yaml"),
    cab("usuarios.yaml") +
      "# papel: gestor | servidor | bolsista | estagiario | externo | grupo | sistema (grupo e sistema não recebem card)\n" +
      Bun.YAML.stringify({ usuarios: [...usuarios.values()] }, null, 2),
  );
  console.log(`ok: ${projetos.length} board(s) e ${usuarios.size} pessoa(s) gravados em _pontes/kanboard/`);
  console.log(`Seu id (kanboard.autor_id no config.yaml): ${eu.id}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`ERRO: ${(e as Error).message}`);
    process.exit(1);
  }
}
