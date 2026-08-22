/**
 * WTE — filesystem.read / filesystem.write tools (Section 59).
 * All paths are sandboxed to the workspace root; secrets directories are read-denied.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { BaseTool } from './tool.js';

const DENIED_READ_SEGMENTS = ['.git' + sep + 'config', '.git-credentials', '.netrc', '.ssh'];

function sandboxPath(repoRoot: string, relPath: string): string {
  const abs = resolve(repoRoot, relPath);
  if (!abs.startsWith(repoRoot + sep) && abs !== repoRoot) {
    throw new Error(`path escape attempt denied: ${relPath}`);
  }
  return abs;
}

export class FilesystemReadTool extends BaseTool<{ path: string; maxBytes?: number }, { path: string; content: string; bytes: number; truncated: boolean }> {
  readonly id = 'filesystem.read';
  readonly version = '1.0.0';
  readonly description = 'Reads a file inside the workspace sandbox.';
  readonly permissions = ['fs:read'];
  readonly timeoutMs = 10_000;

  constructor(private readonly repoRoot: string) {
    super();
  }

  validate(input: { path: string }): string[] {
    return typeof input?.path === 'string' && input.path.length > 0 ? [] : ['path is required'];
  }

  protected async execute(input: { path: string; maxBytes?: number }): Promise<{ path: string; content: string; bytes: number; truncated: boolean }> {
    const abs = sandboxPath(this.repoRoot, input.path);
    for (const seg of DENIED_READ_SEGMENTS) {
      if (abs.includes(seg)) throw new Error('read denied: path may contain credentials (spec §63 secrets management)');
    }
    const buf = await readFile(abs);
    const maxBytes = input.maxBytes ?? 512 * 1024;
    return {
      path: input.path,
      content: buf.subarray(0, maxBytes).toString('utf8'),
      bytes: buf.byteLength,
      truncated: buf.byteLength > maxBytes,
    };
  }
}

export class FilesystemWriteTool extends BaseTool<{ path: string; content: string }, { path: string; bytes: number }> {
  readonly id = 'filesystem.write';
  readonly version = '1.0.0';
  readonly description = 'Writes a file inside the workspace sandbox (creates parent directories).';
  readonly permissions = ['fs:write'];
  readonly timeoutMs = 10_000;

  constructor(private readonly repoRoot: string) {
    super();
  }

  validate(input: { path: string; content: string }): string[] {
    if (typeof input?.path !== 'string' || input.path.length === 0) return ['path is required'];
    if (typeof input?.content !== 'string') return ['content must be a string'];
    if (input.content.length > 2 * 1024 * 1024) return ['content exceeds 2MB limit'];
    return [];
  }

  protected async execute(input: { path: string; content: string }): Promise<{ path: string; bytes: number }> {
    const abs = sandboxPath(this.repoRoot, input.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.content, 'utf8');
    return { path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') };
  }
}
