/**
 * WTE — HTTP API + real-time dashboard (Sections 52/53/54/63).
 * Zero-dependency server: REST-ish JSON API, SSE event stream, embedded SPA.
 * Binds 0.0.0.0 so the platform preview proxy can reach it.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { AuthorizationContext, TestObjective } from '../core/types.js';
import { renderPage } from './dashboard.js';

export interface WteServerOptions {
  port: number;
  host?: string;
  orchestrator: Orchestrator;
  /** Hosts the UI/API will always allow scanning (platform self-test targets). */
  defaultAllowedHosts?: string[];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseHostList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string').slice(0, 50);
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
  return [];
}

export function startWteServer(opts: WteServerOptions): Server {
  const { orchestrator } = opts;
  const host = opts.host ?? '0.0.0.0';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      // --- Dashboard + report artifacts (GET) ---
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderPage());
        return;
      }
      if (req.method === 'GET' && path.startsWith('/artifacts/')) {
        const rel = path.slice('/artifacts/'.length);
        if (rel.includes('..')) {
          json(res, 400, { error: 'invalid path' });
          return;
        }
        const full = `${opts.orchestrator.artifactsDir}/${rel}`;
        if (!existsSync(full)) {
          json(res, 404, { error: 'artifact not found' });
          return;
        }
        const content = await readFile(full);
        const ctype = rel.endsWith('.html') ? 'text/html; charset=utf-8' : rel.endsWith('.json') ? 'application/json' : rel.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': ctype });
        res.end(content);
        return;
      }

      // --- API ---
      if (req.method === 'GET' && path === '/api/health') {
        json(res, 200, { status: 'ok', workerId: orchestrator.workerId, time: new Date().toISOString() });
        return;
      }
      if (req.method === 'GET' && path === '/api/tools') {
        json(res, 200, { tools: orchestrator.tools.manifest() });
        return;
      }
      if (req.method === 'GET' && path === '/api/executions') {
        json(res, 200, {
          executions: orchestrator.listExecutions().map((e) => ({
            id: e.id,
            target: e.objective.target,
            state: e.state,
            mode: e.mode,
            createdAt: e.createdAt,
            findings: e.findings.length,
            score: e.score?.overall ?? null,
            readiness: e.release?.readiness ?? null,
            summary: e.summary ?? null,
          })),
        });
        return;
      }
      if (req.method === 'GET' && path.startsWith('/api/executions/')) {
        const id = decodeURIComponent(path.slice('/api/executions/'.length));
        const exec = orchestrator.getExecution(id);
        if (!exec) {
          json(res, 404, { error: 'execution not found' });
          return;
        }
        json(res, 200, { execution: exec });
        return;
      }
      if (req.method === 'GET' && path === '/api/quality') {
        const latest = orchestrator.listExecutions()[0];
        json(res, 200, { latest: latest ? { id: latest.id, score: latest.score, release: latest.release } : null });
        return;
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');
        for (const e of orchestrator.bus.history()) {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        const unsubscribe = orchestrator.bus.on((e) => {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        });
        req.on('close', unsubscribe);
        return;
      }
      if (req.method === 'POST' && path === '/api/scans') {
        const body = JSON.parse(await readBody(req)) as {
          target?: string;
          endpoints?: unknown;
          allow?: unknown;
          active?: unknown;
          statement?: string;
        };
        if (typeof body.target !== 'string' || !body.target.startsWith('http')) {
          json(res, 400, { error: 'target must be an http(s) URL' });
          return;
        }
        const authorization: AuthorizationContext = {
          allowedHosts: [...new Set([...parseHostList(body.allow), ...(opts.defaultAllowedHosts ?? [])])],
          allowPassive: true,
          allowActive: body.active === true,
          statement: body.statement ?? 'Authorized via WTE dashboard scan request',
        };
        const objective: Omit<TestObjective, 'id'> = {
          kind: 'url-scan',
          target: body.target,
          authorization,
          options: {
            endpoints: Array.isArray(body.endpoints) ? (body.endpoints as unknown[]).filter((e): e is string => typeof e === 'string') : [],
          },
        };
        const result = await orchestrator.scan(objective);
        json(res, 200, {
          executionId: result.execution.id,
          state: result.execution.state,
          findings: result.execution.findings.length,
          score: result.execution.score,
          readiness: result.execution.release?.readiness,
          degraded: result.degraded,
          degradationNotes: result.degradationNotes,
          reportPaths: result.execution.reportPaths,
        });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const denied = err instanceof Error && err.name === 'AuthorizationError';
      json(res, denied ? 403 : 500, { error: message });
    }
  });

  server.listen(opts.port, host);
  return server;
}
