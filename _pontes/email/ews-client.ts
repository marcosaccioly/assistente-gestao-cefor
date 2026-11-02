/**
 * ews-client.ts -- cliente EWS (Exchange Web Services) para as caixas do Ifes
 * lidas pelo assistente (a caixa institucional do gestor e, se houver, a do setor).
 *
 * O webmail do Ifes é Exchange 2019 on-premise (OWA). O EWS aceita Basic auth,
 * então basta fetch + SOAP -- sem biblioteca.
 *
 * Configuração via .env, por prefixo de conta (PESSOAL, SETOR...):
 *   <P>_EWS_URL  -- https://webmail.ifes.edu.br/EWS/Exchange.asmx (se ausente, usa CSO_EWS_URL)
 *   <P>_EMAIL    -- endereço da caixa
 *   <P>_DOMINIO  -- domínio Windows (UPD1); vira DOMINIO\usuario no Basic auth (se ausente, usa CSO_DOMINIO)
 *   <P>_USUARIO  -- login do webmail
 *   <P>_SENHA    -- senha do webmail
 *
 * Única escrita suportada: salvar rascunho (resposta ou mensagem nova) com CreateItem SaveOnly.
 * Não há envio, movimentação, marcação nem exclusão -- de propósito.
 */

import { children, escapeXml, find, findAll, parseXml, textOf, type XmlNode } from "./xml.ts";

export type Pasta = "inbox" | "sentitems" | "drafts";

export interface Pessoa {
  nome: string;
  email: string;
}

export interface Mensagem {
  itemId: string;
  changeKey: string;
  internetMessageId: string;
  conversaId: string;
  assunto: string;
  recebidoEm: string; // ISO
  de: Pessoa | null;
  para: Pessoa[];
  cc: Pessoa[];
  anexos: string[];
  lida: boolean;
  corpo: string; // texto; UniqueBody (sem histórico citado) quando o servidor devolve
  corpoCompleto: string;
}

export interface ResumoPasta {
  pasta: Pasta;
  total: number;
  naoLidas: number;
}

export class EwsClient {
  private readonly url: string;
  readonly caixa: string;
  private readonly auth: string;

  private readonly prefixo: string;

  constructor(prefixo = "PESSOAL") {
    const env = (k: string) => process.env[`${prefixo}_${k}`];
    const url = env("EWS_URL") ?? process.env.CSO_EWS_URL;
    const caixa = env("EMAIL");
    const usuario = env("USUARIO");
    const senha = env("SENHA");
    if (!url || !caixa || !usuario || !senha) {
      throw new Error(`Configuracao da caixa ausente. Defina ${prefixo}_EMAIL, ${prefixo}_USUARIO e ${prefixo}_SENHA (e ${prefixo}_EWS_URL, ${prefixo}_DOMINIO) em .env.`);
    }
    this.prefixo = prefixo;
    // Basic auth no EWS exige DOMINIO\usuario (o login do OWA aceita só o usuário
    // porque tem domínio padrão configurado; o EWS não). Domínio do Ifes: UPD1.
    const dominio = env("DOMINIO") ?? process.env.CSO_DOMINIO;
    const login = dominio && !usuario.includes("\\") && !usuario.includes("@") ? `${dominio}\\${usuario}` : usuario;
    this.url = url;
    this.caixa = caixa;
    this.auth = Buffer.from(`${login}:${senha}`, "utf8").toString("base64");
  }

  private pasta(id: Pasta): string {
    return `<t:DistinguishedFolderId Id="${id}"><t:Mailbox><t:EmailAddress>${escapeXml(this.caixa)}</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>`;
  }

  async soap(corpo: string): Promise<XmlNode> {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>
  <soap:Body>${corpo}</soap:Body>
</soap:Envelope>`;

    const resposta = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", Authorization: `Basic ${this.auth}` },
      body: envelope,
    });

    if (resposta.status === 401) {
      throw new Error(`EWS 401: usuario/senha recusados. Confira ${this.prefixo}_USUARIO e ${this.prefixo}_SENHA em .env (a senha pode ter sido trocada). Nao tente outras combinacoes: a conta bloqueia.`);
    }
    const xml = await resposta.text();
    const doc = parseXml(xml);

    const falha = find(doc, "Fault");
    if (falha || !resposta.ok) {
      throw new Error(`EWS HTTP ${resposta.status}: ${textOf(falha, "faultstring") || xml.slice(0, 300)}`);
    }
    for (const msg of this.mensagensDeResposta(doc)) {
      if (msg.attrs.ResponseClass === "Error") {
        throw new Error(`EWS ${textOf(msg, "ResponseCode")}: ${textOf(msg, "MessageText")}`);
      }
    }
    return doc;
  }

  private mensagensDeResposta(doc: XmlNode): XmlNode[] {
    const acc: XmlNode[] = [];
    const visitar = (no: XmlNode) => {
      if (no.name.endsWith("ResponseMessage")) acc.push(no);
      for (const f of no.children) visitar(f);
    };
    visitar(doc);
    return acc;
  }

  async resumoPasta(id: Pasta): Promise<ResumoPasta> {
    const doc = await this.soap(`<m:GetFolder>
  <m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>
  <m:FolderIds>${this.pasta(id)}</m:FolderIds>
</m:GetFolder>`);
    return {
      pasta: id,
      total: Number(textOf(doc, "TotalCount") || 0),
      naoLidas: Number(textOf(doc, "UnreadCount") || 0),
    };
  }

  /** Ids das mensagens de uma pasta recebidas desde `desde`, mais antigas primeiro. */
  async listarIds(id: Pasta, desde: Date, limite: number): Promise<{ itemId: string; changeKey: string }[]> {
    const ids: { itemId: string; changeKey: string }[] = [];
    const campoData = id === "sentitems" ? "item:DateTimeSent" : "item:DateTimeReceived";
    let offset = 0;
    while (ids.length < limite) {
      const lote = Math.min(50, limite - ids.length);
      const doc = await this.soap(`<m:FindItem Traversal="Shallow">
  <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
  <m:IndexedPageItemView MaxEntriesReturned="${lote}" Offset="${offset}" BasePoint="Beginning"/>
  <m:Restriction>
    <t:IsGreaterThanOrEqualTo>
      <t:FieldURI FieldURI="${campoData}"/>
      <t:FieldURIOrConstant><t:Constant Value="${desde.toISOString()}"/></t:FieldURIOrConstant>
    </t:IsGreaterThanOrEqualTo>
  </m:Restriction>
  <m:SortOrder><t:FieldOrder Order="Ascending"><t:FieldURI FieldURI="${campoData}"/></t:FieldOrder></m:SortOrder>
  <m:ParentFolderIds>${this.pasta(id)}</m:ParentFolderIds>
</m:FindItem>`);
      const itens = findAll(doc, "ItemId").map((n) => ({ itemId: n.attrs.Id, changeKey: n.attrs.ChangeKey }));
      ids.push(...itens);
      const raizPag = find(doc, "RootFolder");
      if (!itens.length || raizPag?.attrs.IncludesLastItemInRange === "true") break;
      offset += itens.length;
    }
    return ids;
  }

  /** Mensagens completas (corpo em texto). Busca em lotes de 20. */
  async obter(itemIds: string[]): Promise<Mensagem[]> {
    const saida: Mensagem[] = [];
    for (let i = 0; i < itemIds.length; i += 20) {
      const lote = itemIds.slice(i, i + 20);
      const doc = await this.soap(`<m:GetItem>
  <m:ItemShape>
    <t:BaseShape>Default</t:BaseShape>
    <t:BodyType>Text</t:BodyType>
    <t:UniqueBodyType>Text</t:UniqueBodyType>
    <t:AdditionalProperties>
      <t:FieldURI FieldURI="item:Body"/>
      <t:FieldURI FieldURI="item:UniqueBody"/>
      <t:FieldURI FieldURI="item:Attachments"/>
      <t:FieldURI FieldURI="item:DateTimeReceived"/>
      <t:FieldURI FieldURI="item:ConversationId"/>
      <t:FieldURI FieldURI="message:InternetMessageId"/>
      <t:FieldURI FieldURI="message:From"/>
      <t:FieldURI FieldURI="message:ToRecipients"/>
      <t:FieldURI FieldURI="message:CcRecipients"/>
      <t:FieldURI FieldURI="message:IsRead"/>
    </t:AdditionalProperties>
  </m:ItemShape>
  <m:ItemIds>${lote.map((id) => `<t:ItemId Id="${escapeXml(id)}"/>`).join("")}</m:ItemIds>
</m:GetItem>`);
      for (const item of findAll(doc, "Items").flatMap((n) => n.children)) {
        saida.push(this.paraMensagem(item));
      }
    }
    return saida;
  }

  private paraMensagem(item: XmlNode): Mensagem {
    const idNo = children(item, "ItemId")[0];
    const pessoa = (no: XmlNode | undefined): Pessoa => ({ nome: textOf(no, "Name"), email: textOf(no, "EmailAddress") });
    const lista = (nome: string) => findAll(children(item, nome)[0], "Mailbox").map(pessoa);
    const deNo = find(children(item, "From")[0], "Mailbox");
    const corpoCompleto = children(item, "Body")[0]?.text.trim() ?? "";
    const unico = children(item, "UniqueBody")[0]?.text.trim() ?? "";
    return {
      itemId: idNo?.attrs.Id ?? "",
      changeKey: idNo?.attrs.ChangeKey ?? "",
      internetMessageId: children(item, "InternetMessageId")[0]?.text.trim() ?? "",
      conversaId: children(item, "ConversationId")[0]?.attrs.Id ?? "",
      assunto: children(item, "Subject")[0]?.text.trim() ?? "",
      recebidoEm: children(item, "DateTimeReceived")[0]?.text.trim() ?? "",
      de: deNo ? pessoa(deNo) : null,
      para: lista("ToRecipients"),
      cc: lista("CcRecipients"),
      anexos: findAll(children(item, "Attachments")[0], "Name").map((n) => n.text.trim()),
      lida: children(item, "IsRead")[0]?.text.trim() === "true",
      corpo: unico || corpoCompleto,
      corpoCompleto,
    };
  }

  /**
   * Salva um rascunho de RESPOSTA na pasta Rascunhos da caixa. Não envia.
   * O Exchange monta a resposta como o OWA faz (assunto "RE:", destinatário,
   * histórico citado); `corpoHtml` é o texto novo acima do histórico.
   */
  async salvarRascunhoResposta(itemId: string, corpoHtml: string, responderATodos = false): Promise<{ itemId: string }> {
    const atual = (await this.obter([itemId]))[0];
    if (!atual?.itemId) throw new Error("Mensagem original não encontrada na caixa (foi movida ou apagada?).");
    const tipo = responderATodos ? "ReplyAllToItem" : "ReplyToItem";
    const doc = await this.soap(`<m:CreateItem MessageDisposition="SaveOnly">
  <m:SavedItemFolderId>${this.pasta("drafts")}</m:SavedItemFolderId>
  <m:Items>
    <t:${tipo}>
      <t:ReferenceItemId Id="${escapeXml(atual.itemId)}" ChangeKey="${escapeXml(atual.changeKey)}"/>
      <t:NewBodyContent BodyType="HTML">${escapeXml(corpoHtml)}</t:NewBodyContent>
    </t:${tipo}>
  </m:Items>
</m:CreateItem>`);
    return { itemId: find(doc, "ItemId")?.attrs.Id ?? "" };
  }

  /**
   * Salva uma mensagem NOVA (não é resposta) na pasta Rascunhos, com anexos. Não envia.
   * Anexo vai num segundo passo (CreateAttachment): se ele falhar, o rascunho já existe,
   * então o erro volta em `anexosNaoIncluidos` em vez de exceção (repetir duplicaria o rascunho).
   */
  async salvarRascunhoNovo(m: {
    para: string[];
    cc: string[];
    assunto: string;
    corpoHtml: string;
    anexos: { nome: string; tipo: string; base64: string }[];
  }): Promise<{ itemId: string; anexosNaoIncluidos: string | null }> {
    const caixas = (xs: string[]) => xs.map((e) => `<t:Mailbox><t:EmailAddress>${escapeXml(e)}</t:EmailAddress></t:Mailbox>`).join("");
    const doc = await this.soap(`<m:CreateItem MessageDisposition="SaveOnly">
  <m:SavedItemFolderId>${this.pasta("drafts")}</m:SavedItemFolderId>
  <m:Items>
    <t:Message>
      <t:Subject>${escapeXml(m.assunto)}</t:Subject>
      <t:Body BodyType="HTML">${escapeXml(m.corpoHtml)}</t:Body>
      <t:ToRecipients>${caixas(m.para)}</t:ToRecipients>
      ${m.cc.length ? `<t:CcRecipients>${caixas(m.cc)}</t:CcRecipients>` : ""}
    </t:Message>
  </m:Items>
</m:CreateItem>`);
    const id = find(doc, "ItemId");
    if (!id?.attrs.Id) throw new Error("CreateItem não devolveu o rascunho criado");
    if (!m.anexos.length) return { itemId: id.attrs.Id, anexosNaoIncluidos: null };
    try {
      await this.soap(`<m:CreateAttachment>
  <m:ParentItemId Id="${escapeXml(id.attrs.Id)}" ChangeKey="${escapeXml(id.attrs.ChangeKey)}"/>
  <m:Attachments>${m.anexos
    .map((a) => `<t:FileAttachment><t:Name>${escapeXml(a.nome)}</t:Name><t:ContentType>${escapeXml(a.tipo)}</t:ContentType><t:Content>${a.base64}</t:Content></t:FileAttachment>`)
    .join("")}</m:Attachments>
</m:CreateAttachment>`);
      return { itemId: id.attrs.Id, anexosNaoIncluidos: null };
    } catch (e) {
      return { itemId: id.attrs.Id, anexosNaoIncluidos: (e as Error).message };
    }
  }
}
