/* Tiny HTTP server that plays every website in the end-to-end tests. */
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function startServer() {
  const hits = [];
  let port = 0;

  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

  const handler = (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    hits.push({ method: req.method, host, path: url.pathname, search: url.search, href: `http://${host}${req.url}` });
    const P = port;
    const html = (code, title, body) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(title, body));
    };

    if (url.pathname === '/needs-utm') {
      // A (hypothetical) site that 404s without its campaign parameter.
      return url.searchParams.has('utm_source') ? html(200, 'ok', '<p>needs-utm ok</p>') : html(404, 'not found', '<p>404</p>');
    }
    if (url.pathname === '/loop') {
      // A site that insists on re-adding a tracker → redirect loop when it's stripped.
      if (!url.searchParams.has('fbclid')) {
        res.writeHead(302, { location: '/loop?fbclid=server-added', 'cache-control': 'no-store' });
        return res.end();
      }
      return html(200, 'loop ok', '<p>loop ok</p>');
    }
    if (url.pathname.startsWith('/click/')) {
      // An email click-tracker: opaque link that redirects to a tagged URL.
      res.writeHead(302, { location: `http://shop.example.com:${P}/sale?utm_source=email&utm_campaign=bf&mc_eid=u123&item=9`, 'cache-control': 'no-store' });
      return res.end();
    }
    if (url.pathname === '/links') {
      const d = `http://dest.example.com:${P}`;
      const g = `http://www.google.com:${P}`;
      const enc = encodeURIComponent;
      return html(200, 'links', `
        <a id="plain" href="${d}/article?utm_source=x&fbclid=y&id=7">plain</a>
        <a id="wrapped" href="${g}/url?q=${enc(d + '/wrapped?utm_source=g&k=1')}&sa=D&usg=abc">wrapped</a>
        <a id="ping" href="${d}/pinged" ping="http://tracker.example.com:${P}/ping">ping</a>
        <a id="relative" href="/rel?utm_medium=email&page=2">relative</a>
        <a id="keep" href="${d}/keep?ref=friend&t=10&s=2">keep</a>
        <a id="unsub" href="${d}/unsubscribe?mc_eid=abc&list=1">unsub</a>
        <a id="swapwrap" href="${d}/before-swap">swapwrap</a>
        <div id="host"></div>
        <p id="copytext">${d}/copied?utm_source=copy&x=1</p>
        <script>
          // Like Gmail/Facebook: swap the href to a tracking redirect at mousedown time.
          document.getElementById('swapwrap').addEventListener('mousedown', (e) => {
            e.currentTarget.href = '${g}/url?q=' + encodeURIComponent('${d}/after-swap?gclid=1&ok=1');
          });
          // A link inside shadow DOM (invisible to MutationObserver).
          const root = document.getElementById('host').attachShadow({ mode: 'open' });
          root.innerHTML = '<a id="shadow" href="${g}/url?q=' + encodeURIComponent('${d}/from-shadow?utm_source=s') + '">shadow</a>';
          // A link added after load.
          setTimeout(() => {
            const a = document.createElement('a');
            a.id = 'late';
            a.href = '${d}/late?mc_eid=1&ok=1';
            a.textContent = 'late';
            document.body.append(a);
          }, 50);
        </script>`);
    }
    return html(200, 'ok', `<p id="u">${url.pathname}${url.search.replace(/</g, '&lt;')}</p>`);
  };

  // HSTS-preloaded hosts (amazon.com, github.com, google.com…) are forced to
  // HTTPS by Chrome, so we also serve HTTPS with a throwaway self-signed cert.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clink-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
    '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=clink-test'], { stdio: 'ignore' });
  const tls = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  fs.rmSync(dir, { recursive: true, force: true });
  const server = http.createServer(handler);
  const secure = https.createServer(tls, handler);

  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return Promise.all([listen(server), listen(secure)]).then(([p, sp]) => {
    port = p;
    return {
      port: p,
      httpsPort: sp,
      hits,
      close: () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => secure.close(r))]),
    };
  });
}
