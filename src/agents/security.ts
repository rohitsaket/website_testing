/**
 * WTE — Security Validation Agent (Section 17/64). PASSIVE validation only:
 * response headers, cookie flags, transport security, information disclosure,
 * mixed content. No exploitation, no active probes beyond authorized GETs.
 */
import { BaseAgent, type AgentRunContext } from './base.js';
import type { StepResult, Finding } from '../core/types.js';
import type { HttpProbeOutput } from '../tools/http.js';
import type { ParsedPage } from '../core/htmllite.js';
import { createFinding } from '../findings/findings.js';

const SECURITY_HEADERS: { header: string; severity: Finding['severity']; why: string; expect: string }[] = [
  { header: 'content-security-policy', severity: 'high', why: 'Without CSP, injected scripts execute with page privileges (XSS blast radius).', expect: 'A restrictive Content-Security-Policy header' },
  { header: 'strict-transport-security', severity: 'medium', why: 'Without HSTS, users can be downgraded to plain HTTP and intercepted.', expect: 'Strict-Transport-Security with a long max-age (HTTPS sites)' },
  { header: 'x-content-type-options', severity: 'medium', why: 'Without nosniff, browsers may MIME-sniff responses into executable content.', expect: 'X-Content-Type-Options: nosniff' },
  { header: 'x-frame-options', severity: 'medium', why: 'Without frame controls, pages can be framed for clickjacking.', expect: 'X-Frame-Options or CSP frame-ancestors' },
  { header: 'referrer-policy', severity: 'low', why: 'A loose Referrer-Policy can leak URLs (tokens, IDs) to third parties.', expect: 'Referrer-Policy: strict-origin-when-cross-origin or stricter' },
  { header: 'permissions-policy', severity: 'low', why: 'Permissions-Policy limits ambient access to camera/mic/geolocation.', expect: 'A scoping Permissions-Policy header' },
];

export class SecurityAgent extends BaseAgent {
  readonly id = 'security-agent';
  readonly name = 'Passive Security Validation Agent';
  readonly requiredTools = [];

  protected async execute(run: AgentRunContext): Promise<StepResult> {
    const probe = run.shared.get('rootProbe') as HttpProbeOutput | undefined;
    const page = run.shared.get('parsedPage') as ParsedPage | undefined;
    if (!probe || probe.error) {
      return this.ok({ status: 'degraded', logs: ['no root probe available — skipping security validation'] });
    }

    const findings: Finding[] = [];
    const isHttps = new URL(probe.finalUrl).protocol === 'https:';

    for (const spec of SECURITY_HEADERS) {
      if (spec.header === 'strict-transport-security' && !isHttps) continue; // HSTS only meaningful over HTTPS
      const value = probe.headers[spec.header];
      if (!value) {
        findings.push(
          createFinding({
            category: 'security',
            severity: spec.severity,
            title: `Missing security header: ${spec.header}`,
            description: spec.why,
            expected: spec.expect,
            actual: `Header absent on ${probe.finalUrl}`,
            url: probe.finalUrl,
            component: 'http-response',
          }),
        );
      }
    }

    const csp = probe.headers['content-security-policy'];
    if (csp && /unsafe-inline/.test(csp) && !/nonce-|sha256-/.test(csp)) {
      findings.push(
        createFinding({
          category: 'security',
          severity: 'medium',
          title: "CSP allows 'unsafe-inline' without nonces/hashes",
          description: 'An unsafe-inline CSP without nonces provides weak XSS resistance.',
          expected: "CSP without 'unsafe-inline', or with nonce/hash-based allowances",
          actual: csp.slice(0, 200),
          url: probe.finalUrl,
          component: 'http-response',
        }),
      );
    }

    const server = probe.headers['server'];
    const poweredBy = probe.headers['x-powered-by'];
    if (server && /\d/.test(server)) {
      findings.push(
        createFinding({
          category: 'security',
          severity: 'low',
          title: 'Server version disclosed',
          description: 'Version disclosure aids targeted attacks against known vulnerabilities.',
          expected: 'Server banner without precise version',
          actual: `Server: ${server}`,
          url: probe.finalUrl,
          component: 'http-response',
        }),
      );
    }
    if (poweredBy) {
      findings.push(
        createFinding({
          category: 'security',
          severity: 'low',
          title: 'X-Powered-By header disclosed',
          description: 'Technology fingerprinting information exposed to any observer.',
          expected: 'X-Powered-By removed',
          actual: `X-Powered-By: ${poweredBy}`,
          url: probe.finalUrl,
          component: 'http-response',
        }),
      );
    }

    const setCookie = probe.headers['set-cookie'];
    if (setCookie) {
      for (const cookie of setCookie.split(/,(?=[^;]+=)/)) {
        const name = cookie.split('=')[0]?.trim() ?? 'unknown';
        if (!/httponly/i.test(cookie)) {
          findings.push(
            createFinding({
              category: 'security',
              severity: 'medium',
              title: `Cookie "${name}" missing HttpOnly`,
              description: 'Cookies readable from JavaScript are exfiltratable via XSS.',
              expected: 'HttpOnly attribute on session cookies',
              actual: cookie.slice(0, 160),
              url: probe.finalUrl,
              component: 'cookies',
            }),
          );
        }
        if (isHttps && !/\bsecure\b/i.test(cookie)) {
          findings.push(
            createFinding({
              category: 'security',
              severity: 'medium',
              title: `Cookie "${name}" missing Secure`,
              description: 'Cookie can be transmitted over plain HTTP.',
              expected: 'Secure attribute on cookies over HTTPS',
              actual: cookie.slice(0, 160),
              url: probe.finalUrl,
              component: 'cookies',
            }),
          );
        }
        if (!/samesite=/i.test(cookie)) {
          findings.push(
            createFinding({
              category: 'security',
              severity: 'low',
              title: `Cookie "${name}" missing SameSite`,
              description: 'No CSRF-related cookie guidance for the browser.',
              expected: 'SameSite=Lax or Strict',
              actual: cookie.slice(0, 160),
              url: probe.finalUrl,
              component: 'cookies',
            }),
          );
        }
      }
    }

    if (isHttps && page) {
      const insecure = page.links.filter((l) => l.href.startsWith('http://')).length + page.images.filter((i) => i.src.startsWith('http://')).length;
      if (insecure > 0) {
        findings.push(
          createFinding({
            category: 'security',
            severity: 'low',
            title: `Mixed content references on HTTPS page (${insecure})`,
            description: 'HTTP subresources on an HTTPS page weaken transport guarantees.',
            expected: 'All subresources over HTTPS',
            actual: `${insecure} http:// references in markup`,
            url: probe.finalUrl,
            component: 'document',
          }),
        );
      }
    }

    return this.ok({
      status: 'passed',
      findings,
      logs: [`security validation: ${findings.length} finding(s); transport=${isHttps ? 'https' : 'http'}`],
      metrics: { 'security.findings': findings.length, 'security.https': isHttps ? 1 : 0 },
    });
  }
}
