/**
 * xml.ts -- parser XML mínimo para as respostas SOAP do EWS.
 *
 * Por que não uma lib: a ponte roda com `bun run` puro, sem package.json nem
 * `bun install` (mesmo padrão de _pontes/kanboard/). As respostas do Exchange
 * são XML bem-formado e sem CDATA, então um parser por pilha basta.
 *
 * Prefixos de namespace são descartados: `t:Subject` vira `Subject`.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTIDADES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, ent: string) => {
    if (ent.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ent.slice(2), 16));
    if (ent.startsWith("#")) return String.fromCodePoint(Number.parseInt(ent.slice(1), 10));
    return ENTIDADES[ent] ?? m;
  });
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i === -1 ? qname : qname.slice(i + 1);
}

export function parseXml(xml: string): XmlNode {
  const limpo = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const raiz: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const pilha: XmlNode[] = [raiz];

  for (const token of limpo.match(/<[^>]+>|[^<]+/g) ?? []) {
    const topo = pilha[pilha.length - 1];
    if (!token.startsWith("<")) {
      topo.text += decodeEntities(token);
      continue;
    }
    if (token.startsWith("</")) {
      if (pilha.length > 1) pilha.pop();
      continue;
    }
    const autoFechada = token.endsWith("/>");
    const corpo = token.slice(1, autoFechada ? -2 : -1).trim();
    const nomeFim = corpo.search(/\s/);
    const nome = nomeFim === -1 ? corpo : corpo.slice(0, nomeFim);
    const attrs: Record<string, string> = {};
    for (const m of corpo.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? "");
    }
    const no: XmlNode = { name: localName(nome), attrs, children: [], text: "" };
    topo.children.push(no);
    if (!autoFechada) pilha.push(no);
  }
  return raiz;
}

/** Primeiro descendente com o nome dado (busca em profundidade). */
export function find(no: XmlNode | undefined, nome: string): XmlNode | undefined {
  if (!no) return undefined;
  for (const filho of no.children) {
    if (filho.name === nome) return filho;
    const achado = find(filho, nome);
    if (achado) return achado;
  }
  return undefined;
}

/** Todos os descendentes com o nome dado. */
export function findAll(no: XmlNode | undefined, nome: string, acc: XmlNode[] = []): XmlNode[] {
  if (!no) return acc;
  for (const filho of no.children) {
    if (filho.name === nome) acc.push(filho);
    findAll(filho, nome, acc);
  }
  return acc;
}

/** Filhos diretos com o nome dado. */
export function children(no: XmlNode | undefined, nome: string): XmlNode[] {
  return no ? no.children.filter((c) => c.name === nome) : [];
}

/** Texto do primeiro descendente com o nome dado (string vazia se não houver). */
export function textOf(no: XmlNode | undefined, nome: string): string {
  return find(no, nome)?.text.trim() ?? "";
}
