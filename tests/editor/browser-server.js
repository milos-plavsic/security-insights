'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const docsRoot = path.join(root, 'docs');
const siteRoot = path.join(root, '.editor-browser-site');
const port = Number(process.env.EDITOR_TEST_PORT || 43917);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function buildSite() {
  fs.rmSync(siteRoot, { recursive: true, force: true });
  const result = spawnSync(
    'bundle',
    ['exec', 'jekyll', 'build', '--source', docsRoot, '--destination', siteRoot],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        BUNDLE_GEMFILE: path.join(docsRoot, 'Gemfile'),
        JEKYLL_ENV: 'test'
      }
    }
  );
  if (result.error) {
    throw new Error(`Unable to start Jekyll: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Jekyll build failed:\n${result.stdout}\n${result.stderr}`);
  }
}

buildSite();
const siteRealRoot = fs.realpathSync(siteRoot);

function send(response, status, body, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, 'http://127.0.0.1').pathname
    );
    let requestedPath = pathname;
    if (requestedPath === '/editor') {
      requestedPath = '/editor/index.html';
    } else if (requestedPath.endsWith('/')) {
      requestedPath += 'index.html';
    }
    const relativePath = requestedPath.replace(/^\/+/, '');
    const candidatePath = path.resolve(siteRoot, relativePath);
    if (!candidatePath.startsWith(`${siteRoot}${path.sep}`)
      || !fs.existsSync(candidatePath)) {
      send(response, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }
    const filePath = fs.realpathSync(candidatePath);
    const stat = fs.statSync(filePath);
    if (!filePath.startsWith(`${siteRealRoot}${path.sep}`) || !stat.isFile()) {
      send(response, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }
    const contentType = contentTypes[path.extname(filePath)]
      || 'application/octet-stream';
    send(response, 200, fs.readFileSync(filePath), contentType);
  } catch (error) {
    send(response, 400, 'Invalid request', 'text/plain; charset=utf-8');
  }
});

server.on('error', error => {
  console.error(`Editor test server failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Editor test server listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
