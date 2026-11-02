/**
 * jsonrpc-client.ts -- cliente JSON-RPC para o Kanboard institucional.
 *
 * V0: usado direto pelo facade.
 * V1+: pode ser substituido por mcp-client.ts quando issue upstream #11 fixar.
 *
 * Configuração via .env:
 *   KANBOARD_API_URL    -- ex: https://board.cefor.ifes.edu.br/jsonrpc.php
 *   KANBOARD_API_USER   -- seu usuário do Kanboard
 *   KANBOARD_API_TOKEN  -- token gerado no painel admin do Kanboard
 */

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class JsonRpcClient {
  private readonly url: string;
  private readonly user: string;
  private readonly token: string;
  private requestId = 1;

  constructor() {
    const url = process.env.KANBOARD_API_URL;
    const user = process.env.KANBOARD_API_USER;
    const token = process.env.KANBOARD_API_TOKEN;

    if (!url || !user || !token) {
      throw new Error(
        "Configuracao Kanboard ausente. Defina KANBOARD_API_URL, KANBOARD_API_USER e KANBOARD_API_TOKEN em .env."
      );
    }

    this.url = url;
    this.user = user;
    this.token = token;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> | unknown[] = {}): Promise<T> {
    const body = {
      jsonrpc: "2.0",
      id: this.requestId++,
      method,
      params,
    };

    const auth = btoa(`${this.user}:${this.token}`);
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
        // Kanboard aceita o mesmo par em X-API-Auth, para servidores que descartam o Authorization.
        "X-API-Auth": auth,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as JsonRpcResponse<T>;

    if (data.error) {
      throw new Error(`Kanboard API erro ${data.error.code}: ${data.error.message}`);
    }

    if (data.result === undefined) {
      throw new Error("Resposta do Kanboard sem campo `result`.");
    }

    return data.result;
  }
}
