/**
 * WTE — Authorization & Scope Guard (Sections 17, 49, 50, 64).
 * No agent may touch a target outside the declared authorization scope.
 * The default stance is DENY: an empty allowlist blocks everything.
 */
import type { AuthorizationContext } from './types.js';

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  return false;
}

export class ScopeGuard {
  constructor(private readonly auth: AuthorizationContext) {}

  /** True when the URL's host is inside the declared scope. */
  isHostAllowed(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    return this.auth.allowedHosts.some((pattern) => hostMatches(host, pattern));
  }

  /** Throws AuthorizationError when out of scope. */
  assertUrlAllowed(url: string): void {
    if (!this.auth.allowPassive && !this.auth.allowActive) {
      throw new AuthorizationError('Authorization context permits no testing activity at all.');
    }
    if (!this.isHostAllowed(url)) {
      let host = '<unparseable>';
      try {
        host = new URL(url).hostname;
      } catch {
        /* keep default */
      }
      throw new AuthorizationError(
        `Target host "${host}" is NOT in the authorized scope [${this.auth.allowedHosts.join(', ') || '(empty)'}]. ` +
          'WTE never tests targets without explicit authorization (spec §64).',
      );
    }
  }

  /** Active testing (anything beyond passive GET/HEAD) needs explicit opt-in. */
  assertActiveAllowed(what: string): void {
    if (!this.auth.allowActive) {
      throw new AuthorizationError(
        `Active testing is not authorized in this context; "${what}" requires allowActive=true (spec §17/49).`,
      );
    }
  }

  describe(): string {
    return `hosts=[${this.auth.allowedHosts.join(', ')}] passive=${this.auth.allowPassive} active=${this.auth.allowActive}`;
  }
}
