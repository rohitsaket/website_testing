/**
 * WTE — http.probe / api.request tools (Sections 11, 28, 59).
 * Outbound HTTP is permission-gated and scope-checked before ANY byte leaves.
 * Authorization denials are hard failures; network faults become structured
 * error observations (agents still get evidence, not crashes).
 */
import { BaseTool, type ToolContext } from './tool.js';

export interface HttpProbeInput {
  url: string;
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface HttpProbeOutput {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText: string;
  bodyBytes: number;
  truncated: boolean;
  timing: { startMs: number; ttfbMs: number; totalMs: number };
  redirected: boolean;
  redirectChain: string[];
  ok: boolean;
  error?: string;
}

export interface ApiRequestOutput extends HttpProbeOutput {
  json?: unknown;
  jsonValid: boolean;
  contentType: string;
}

function emptyOutput(url: string, error: string): HttpProbeOutput {
  return {
    url,
    finalUrl: url,
    status: 0,
    statusText: '',
    headers: {},
    bodyText: '',
    bodyBytes: 0,
    truncated: false,
    timing: { startMs: 0, ttfbMs: 0, totalMs: 0 },
    redirected: false,
    redirectChain: [url],
    ok: false,
    error,
  };
}

async function rawProbe(input: HttpProbeInput): Promise<HttpProbeOutput> {
  const method = input.method ?? 'GET';
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  const maxBody = input.maxBodyBytes ?? 512 * 1024;

  try {
    const res = await fetch(input.url, {
      method,
      headers: { 'user-agent': 'WTE-Probe/0.1 (+quality-engineering; authorized-testing-only)', ...input.headers },
      body: method === 'POST' ? input.body : undefined,
      redirect: 'follow',
      signal: controller.signal,
    });
    const ttfb = performance.now() - started;
    const reader = res.body?.getReader();
    let received = 0;
    let truncated = false;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBody) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
      }
    }
    const total = performance.now() - started;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return {
      url: input.url,
      finalUrl: res.url,
      status: res.status,
      statusText: res.statusText,
      headers,
      bodyText: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBody)),
      bodyBytes: received,
      truncated,
      timing: {
        startMs: Math.round(started),
        ttfbMs: Math.max(0, Math.round(ttfb)),
        totalMs: Math.max(0, Math.round(total)),
      },
      redirected: res.redirected,
      redirectChain: res.redirected ? [input.url, res.url] : [input.url],
      ok: res.ok,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Shared policy core: scope-check FIRST (hard failure on denial), then probe,
 * converting network faults into structured error output.
 */
export async function probeStructured(input: HttpProbeInput, ctx: ToolContext): Promise<HttpProbeOutput> {
  const method = input.method ?? 'GET';
  try {
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.scope.assertActiveAllowed(`${method} ${input.url}`); // non-idempotent methods = active testing
    }
    ctx.scope.assertUrlAllowed(input.url);
  } catch (err) {
    ctx.bus.emit('authorization.denied', ctx.executionId, {
      target: input.url,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err; // hard stop — a denial is never response data
  }
  try {
    return await rawProbe(input);
  } catch (err) {
    return emptyOutput(input.url, err instanceof Error ? err.message : String(err));
  }
}

function validateInput(input: HttpProbeInput): string[] {
  const errors: string[] = [];
  try {
    const u = new URL(input.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push('only http/https URLs are permitted');
  } catch {
    errors.push('url is not parseable');
  }
  if (input.method && !['GET', 'HEAD', 'POST'].includes(input.method)) errors.push('method must be GET, HEAD or POST');
  return errors;
}

export class HttpProbeTool extends BaseTool<HttpProbeInput, HttpProbeOutput> {
  readonly id = 'http.probe';
  readonly version = '1.0.0';
  readonly description = 'Performs a scope-checked HTTP probe of a URL and captures status, headers, timing and capped body.';
  readonly permissions = ['network:outbound'];
  readonly timeoutMs = 20_000;

  validate(input: HttpProbeInput): string[] {
    return validateInput(input);
  }

  protected async execute(input: HttpProbeInput, ctx: ToolContext): Promise<HttpProbeOutput> {
    return probeStructured(input, ctx);
  }
}

export class ApiRequestTool extends BaseTool<HttpProbeInput, ApiRequestOutput> {
  readonly id = 'api.request';
  readonly version = '1.0.0';
  readonly description = 'Performs a scope-checked API request and parses JSON payloads.';
  readonly permissions = ['network:outbound'];
  readonly timeoutMs = 20_000;

  validate(input: HttpProbeInput): string[] {
    return validateInput(input);
  }

  protected async execute(input: HttpProbeInput, ctx: ToolContext): Promise<ApiRequestOutput> {
    const raw = await probeStructured(input, ctx);
    const contentType = raw.headers['content-type'] ?? '';
    let json: unknown = undefined;
    let jsonValid = false;
    if (raw.bodyText.length > 0) {
      try {
        json = JSON.parse(raw.bodyText);
        jsonValid = true;
      } catch {
        jsonValid = false;
      }
    }
    return { ...raw, json, jsonValid, contentType };
  }
}
