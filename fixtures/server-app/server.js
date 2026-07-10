// Server-rendered fixture for the fake-backend sandbox tests. Declares an
// express dependency so classify() sees a server app, but is implemented on
// node:http only — the sandbox boots it from a bare artifact directory with
// no node_modules. It exercises everything the proxy must handle: HTML with
// root-absolute links, form POST + redirect, a cookie-gated page with a
// login endpoint, CSP/X-Frame-Options headers to strip, non-HTML assets, and
// env injection.
const http = require('http');

const items = ['first item'];
const greeting = process.env.FIXTURE_GREETING || 'no greeting set';

function page(body) {
  return (
    '<!DOCTYPE html><html><head><link rel="stylesheet" href="/style.css"></head>' +
    `<body>${body}</body></html>`
  );
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  const { pathname } = new URL(req.url, 'http://x');

  if (req.method === 'GET' && pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(page(
      `<h1>Fixture app</h1><p id="greeting">${greeting}</p>` +
      '<ul>' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>' +
      '<form method="POST" action="/items"><input name="name"><button id="add">Add</button></form>' +
      '<a href="/gated" id="gated-link">gated page</a>'
    ));
  } else if (req.method === 'POST' && pathname === '/login') {
    res.writeHead(302, { 'Set-Cookie': 'fixture_session=letmein; Path=/; HttpOnly', Location: '/' });
    res.end();
  } else if (req.method === 'GET' && pathname === '/gated') {
    if (!/fixture_session=letmein/.test(req.headers.cookie || '')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('login required');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(page('<h1 id="secret">Secret page</h1>'));
  } else if (req.method === 'POST' && pathname === '/items') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const name = new URLSearchParams(body).get('name');
      if (name) items.push(name);
      res.writeHead(302, { Location: '/' });
      res.end();
    });
  } else if (req.method === 'GET' && pathname === '/style.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end('body { font-family: sans-serif }');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => {
  console.log(`fixture-server-app listening on ${server.address().port}`);
});
