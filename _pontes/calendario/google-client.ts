/**
 * google-client.ts -- OAuth (app para computador, loopback + PKCE) e chamadas de leitura
 * à API do Google Calendar. Só `fetch`, sem biblioteca, sem `bun install`.
 *
 * Escopos pedidos (28/10/2026): calendar.readonly (lista de agendas, eventos, livre/ocupado) e
 * calendar.events (criar e alterar evento, cancelar ocorrência de série). A escrita só é chamada
 * pela fila do /executar, com aprovação do gestor. Evento avulso e série inteira nunca são apagados.
 */

export const ESCOPO_LEITURA = "https://www.googleapis.com/auth/calendar.readonly";
export const ESCOPO_ESCRITA = "https://www.googleapis.com/auth/calendar.events";
export const ESCOPO = `${ESCOPO_LEITURA} ${ESCOPO_ESCRITA}`;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

/** Contas permitidas: as institucionais listadas no .env (CALENDARIO_CONTAS_PERMITIDAS, separadas por vírgula,
 *  ou só CALENDARIO_CONTA). Nunca a conta pessoal. */
export const CONTAS_PERMITIDAS = (process.env.CALENDARIO_CONTAS_PERMITIDAS ?? process.env.CALENDARIO_CONTA ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export class ErroApi extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

export interface Credenciais {
  conta: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function credenciaisDoEnv(exigirToken = true): Credenciais {
  const c = {
    conta: process.env.CALENDARIO_CONTA ?? "",
    clientId: process.env.CALENDARIO_CLIENT_ID ?? "",
    clientSecret: process.env.CALENDARIO_CLIENT_SECRET ?? "",
    refreshToken: process.env.CALENDARIO_REFRESH_TOKEN ?? "",
  };
  if (!c.conta) throw new Error("Falta CALENDARIO_CONTA no .env (sua conta institucional do Google).");
  if (!CONTAS_PERMITIDAS.includes(c.conta)) {
    throw new Error(`CALENDARIO_CONTA=${c.conta} não é permitida. Use ${CONTAS_PERMITIDAS.join(" ou ")}.`);
  }
  if (!c.clientId || !c.clientSecret) throw new Error("Faltam CALENDARIO_CLIENT_ID e CALENDARIO_CLIENT_SECRET no .env.");
  if (exigirToken && !c.refreshToken) {
    throw new Error("Falta CALENDARIO_REFRESH_TOKEN no .env: rode `bun run _pontes/calendario/facade.ts autorizar`.");
  }
  return c;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(hash) };
}

export function urlAutorizacao(c: Credenciais, redirectUri: string, challenge: string, state: string): string {
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ESCOPO,
    access_type: "offline",
    prompt: "consent",
    login_hint: c.conta,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function postToken(corpo: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; scope: string }> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(corpo),
  });
  const json = (await r.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!r.ok || !json.access_token) {
    // invalid_grant = token revogado ou expirado (app em modo "Teste" expira em 7 dias): rodar `autorizar` de novo.
    throw new ErroApi(r.status, `OAuth ${r.status}: ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token, scope: json.scope ?? "" };
}

export function trocarCodigo(c: Credenciais, code: string, redirectUri: string, verifier: string) {
  return postToken({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
}

export interface Evento {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  eventType?: string;
  recurringEventId?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
}

/** Campos que a ponte escreve: título, local, descrição, início e fim. */
export type EventoEscrita = Pick<Evento, "summary" | "location" | "description" | "start" | "end">;

export class CalendarClient {
  private constructor(
    private readonly token: string,
    /** Escopos que o token tem; vazio quando desconhecido. */
    readonly escopos: string = "",
  ) {}

  static async conectar(c: Credenciais): Promise<CalendarClient> {
    const { access_token, scope } = await postToken({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    });
    return CalendarClient.comToken(access_token, scope);
  }

  static comToken(accessToken: string, escopos = ""): CalendarClient {
    return new CalendarClient(accessToken, escopos);
  }

  /** O token foi autorizado com escrita (calendar.events ou calendar)? */
  get podeEscrever(): boolean {
    return this.escopos.split(" ").some((e) => e === ESCOPO_ESCRITA || e === "https://www.googleapis.com/auth/calendar");
  }

  private async enviar<T>(metodo: "POST" | "PATCH", caminho: string, corpo: unknown): Promise<T> {
    if (!this.podeEscrever) {
      throw new ErroApi(403, "O token do .env só tem leitura: rode `bun run _pontes/calendario/facade.ts autorizar` para dar a permissão de escrita.");
    }
    const r = await fetch(`${API}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    if (!r.ok) throw new ErroApi(r.status, `Calendar ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  }

  private async get<T>(caminho: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${API}${caminho}${qs ? `?${qs}` : ""}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new ErroApi(r.status, `Calendar ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  }

  /** E-mail da conta dona do token (id da agenda principal). */
  async contaConectada(): Promise<string> {
    return (await this.get<{ id: string }>("/calendars/primary")).id;
  }

  /** Agendas na lista da conta, com o papel de acesso de cada uma. */
  async listaDeAgendas(): Promise<{ id: string; summary: string; accessRole: string }[]> {
    const itens: { id: string; summary: string; accessRole: string }[] = [];
    let pageToken = "";
    do {
      const r = await this.get<{ items?: typeof itens; nextPageToken?: string }>("/users/me/calendarList", {
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      });
      itens.push(...(r.items ?? []));
      pageToken = r.nextPageToken ?? "";
    } while (pageToken);
    return itens;
  }

  async eventos(agenda: string, de: Date, ate: Date, limite = 250): Promise<Evento[]> {
    const itens: Evento[] = [];
    let pageToken = "";
    do {
      const r = await this.get<{ items?: Evento[]; nextPageToken?: string }>(`/calendars/${encodeURIComponent(agenda)}/events`, {
        timeMin: de.toISOString(),
        timeMax: ate.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(Math.min(limite, 250)),
        ...(pageToken ? { pageToken } : {}),
      });
      itens.push(...(r.items ?? []));
      pageToken = itens.length < limite ? (r.nextPageToken ?? "") : "";
    } while (pageToken);
    return itens;
  }

  async eventoPorId(agenda: string, id: string): Promise<Evento> {
    return this.get<Evento>(`/calendars/${encodeURIComponent(agenda)}/events/${encodeURIComponent(id)}`);
  }

  /** Cria um evento. Só pela fila do /executar, depois da aprovação do gestor. */
  async criarEvento(agenda: string, e: EventoEscrita): Promise<Evento> {
    return this.enviar<Evento>("POST", `/calendars/${encodeURIComponent(agenda)}/events`, e);
  }

  /** Altera só os campos passados (PATCH). Só pela fila do /executar, depois da aprovação do gestor. */
  async alterarEvento(agenda: string, id: string, e: Partial<EventoEscrita>): Promise<Evento> {
    return this.enviar<Evento>("PATCH", `/calendars/${encodeURIComponent(agenda)}/events/${encodeURIComponent(id)}`, e);
  }

  /**
   * Cancela UMA ocorrência de um evento que se repete (a série continua). Recusa evento avulso e
   * a série inteira. Ocorrência já cancelada conta como feita (repetir a ação não dá erro).
   */
  async cancelarOcorrencia(agenda: string, id: string): Promise<{ id: string; ja_estava: boolean; inicio: Evento["start"] }> {
    const e = await this.eventoPorId(agenda, id);
    if (!e.recurringEventId) throw new ErroApi(400, `${id} não é ocorrência de uma série: a ponte não apaga evento avulso nem a série inteira`);
    if (e.status === "cancelled") return { id, ja_estava: true, inicio: e.start };
    await this.enviar<Evento>("PATCH", `/calendars/${encodeURIComponent(agenda)}/events/${encodeURIComponent(id)}`, { status: "cancelled" });
    return { id, ja_estava: false, inicio: e.start };
  }

  /** Blocos ocupados, para agenda compartilhada só como livre/ocupado. */
  async ocupado(agenda: string, de: Date, ate: Date): Promise<{ start: string; end: string }[]> {
    const r = await fetch(`${API}/freeBusy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: de.toISOString(), timeMax: ate.toISOString(), items: [{ id: agenda }] }),
    });
    if (!r.ok) throw new ErroApi(r.status, `freeBusy ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const json = (await r.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> };
    const cal = json.calendars?.[agenda];
    if (cal?.errors?.length) throw new ErroApi(404, `freeBusy: ${cal.errors.map((e) => e.reason).join(", ")}`);
    return cal?.busy ?? [];
  }
}
