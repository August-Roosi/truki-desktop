// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// A tiny login site for the cookie login tests. It only does something when
// startTrukiFakeLoginPage() is called; mocha also loads every .mjs file under
// ts/test-node.
//
// GET  /           a form that posts to /login
// POST /login      sets the cookies named in ?cookies=a,b (default c_user,xs)
//                  and redirects to /home
// GET  /set?cookies=a,b   sets those cookies and shows a page
// GET  /popup      opens /set?cookies=... in a new window via window.open
// Every request's User-Agent is recorded in `userAgents`.

import { createServer } from 'node:http';

function setCookieHeaders(names) {
  return names
    .filter(name => name !== '')
    .map(name => `${name}=value-of-${name}; Path=/; HttpOnly`);
}

function namesFrom(url, fallback) {
  const raw = url.searchParams.get('cookies');
  return raw == null ? fallback : raw.split(',');
}

export async function startTrukiFakeLoginPage() {
  const userAgents = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    userAgents.push(req.headers['user-agent'] ?? '');
    if (req.method === 'POST' && url.pathname === '/login') {
      req.resume();
      req.on('end', () => {
        res.writeHead(302, {
          'Set-Cookie': setCookieHeaders(namesFrom(url, ['c_user', 'xs'])),
          Location: '/home',
        });
        res.end();
      });
      return;
    }
    if (url.pathname === '/set') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': setCookieHeaders(namesFrom(url, [])),
      });
      res.end('<!doctype html><title>set</title><p>set</p>');
      return;
    }
    if (url.pathname === '/popup') {
      const target = `/set?cookies=${encodeURIComponent(
        url.searchParams.get('cookies') ?? ''
      )}`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!doctype html><title>popup</title><script>window.open(${JSON.stringify(
          target
        )}, '_blank');</script>`
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>login</title>' +
        `<form method="post" action="/login${url.search}">` +
        '<input name="user"><button>Log in</button></form>'
    );
  });
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    userAgents,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}
