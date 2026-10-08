import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../report.js';
import type { CheckReport } from '../types.js';
import { VERSION } from '../version.js';
import { newerInstalled } from './installed.js';
import { PAGE_HTML } from './page.generated.js';

export interface UiServer {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function withNonce(html: string, nonce: string): string {
  return html
    .replace(/<style data-berth-inline>/g, `<style nonce="${nonce}" data-berth-inline>`)
    .replace(
      /<script type="module" data-berth-inline>/g,
      `<script type="module" nonce="${nonce}" data-berth-inline>`,
    );
}

function csp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com data:',
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function sameOrigin(req: http.IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host ?? '';
    return origin === `http://${host}`;
  }
  return true;
}

/** How long a "newer berth installed" answer is reused: a couple of package.json reads a minute. */
const INSTALLED_TTL_MS = 60_000;

/**
 * The default upgrade check: only a bundled berth (dist/berth.js) knows where it was installed
 * from; a source run (tests, tsx) has no install to compare against.
 */
function defaultInstalledFn(): () => string | undefined {
  const self = fileURLToPath(import.meta.url);
  if (path.basename(self) !== 'berth.js') return () => undefined;
  let last: { at: number; value: string | undefined } | undefined;
  return () => {
    if (!last || Date.now() - last.at > INSTALLED_TTL_MS)
      last = { at: Date.now(), value: newerInstalled(VERSION, self) };
    return last.value;
  };
}

/**
 * Serve the dashboard on 127.0.0.1 only. GET-only, nothing served from disk (the page is inlined
 * in the bundle), nonce-based CSP. `/api/state` is the check report plus `runtime.installed` when
 * a newer berth is installed than the one serving it, so a dashboard left running across an
 * upgrade says so.
 */
export async function startUi(opts: {
  port: number;
  host?: string;
  reportFn?: () => Promise<CheckReport>;
  /** Test seam: the newer installed version, or undefined. */
  installedFn?: () => string | undefined;
}): Promise<UiServer> {
  const host = opts.host ?? '127.0.0.1';
  const reportFn = opts.reportFn ?? (() => buildReport({ maxAgeMs: 1000 }));
  const installedFn = opts.installedFn ?? defaultInstalledFn();
  let inflight: Promise<CheckReport> | undefined;
  let last: { at: number; report: CheckReport } | undefined;
  const getReport = () => {
    if (last && Date.now() - last.at < 1000) return Promise.resolve(last.report);
    if (!inflight) {
      inflight = reportFn()
        .then((r) => {
          last = { at: Date.now(), report: r };
          return r;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  };
  const server = http.createServer(async (req, res) => {
    const common: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
    };
    const send = (status: number, body: string, headers: Record<string, string>) => {
      res.writeHead(status, {
        ...common,
        ...headers,
        'Content-Length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(405, 'method not allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const nonce = randomBytes(16).toString('base64');
      return send(200, withNonce(PAGE_HTML, nonce), {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp(nonce),
      });
    }
    if (url.pathname === '/healthz') return send(200, 'ok', { 'Content-Type': 'text/plain' });
    if (url.pathname === '/api/state') {
      if (!sameOrigin(req))
        return send(403, '{"error":"cross-origin request refused"}', {
          'Content-Type': 'application/json',
        });
      try {
        const report = await getReport();
        const installed = installedFn();
        const runtime = installed ? { installed } : {};
        return send(200, JSON.stringify({ ...report, runtime }), {
          'Content-Type': 'application/json; charset=utf-8',
        });
      } catch (e) {
        process.stderr.write(`berth ui: report failed: ${(e as Error).message}
`);
        return send(500, '{"error":"report failed; see the berth ui terminal"}', {
          'Content-Type': 'application/json',
        });
      }
    }
    return send(404, 'not found', { 'Content-Type': 'text/plain' });
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    server,
    port,
    url: `http://${host}:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
