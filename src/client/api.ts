import type { SimulationRequest, SimulationResult, SimulationTrace } from "../domain/types.js";
import type { SearchRequest, SearchResult } from "../search/types.js";

export interface ApiErrorPayload {
  error: { code: string; message: string; issues?: Array<{ path: string; message: string }>; requestId?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly payload: ApiErrorPayload | undefined;

  constructor(status: number, message: string, payload?: ApiErrorPayload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export interface RuleRiotApi {
  health(): Promise<Record<string, unknown>>;
  rules(): Promise<Record<string, unknown>>;
  simulate(request: SimulationRequest): Promise<SimulationResult>;
  search(request: SearchRequest): Promise<SearchResult>;
  verify(trace: SimulationTrace | unknown): Promise<Record<string, unknown>>;
}

export function createApiClient(fetcher: typeof fetch = fetch, baseUrl = ""): RuleRiotApi {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) as unknown : undefined;
    } catch {
      throw new ApiError(response.status, "The API returned invalid JSON");
    }
    if (!response.ok) {
      const errorPayload = payload as ApiErrorPayload | undefined;
      throw new ApiError(response.status, errorPayload?.error.message ?? `Request failed with status ${response.status}`, errorPayload);
    }
    return payload as T;
  }
  return {
    health: () => request<Record<string, unknown>>("/api/v1/health"),
    rules: () => request<Record<string, unknown>>("/api/v1/rules"),
    simulate: (input) => request<SimulationResult>("/api/v1/simulate", { method: "POST", body: JSON.stringify(input) }),
    search: (input) => request<SearchResult>("/api/v1/search", { method: "POST", body: JSON.stringify(input) }),
    verify: (input) => request<Record<string, unknown>>("/api/v1/verify", { method: "POST", body: JSON.stringify(input) }),
  };
}
