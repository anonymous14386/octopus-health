'use strict';

/**
 * The deploy-verification stamp, and the asset stamps that go in the URLs.
 *
 * Two separate failures, one cause: you cannot tell a deploy that never landed
 * from one that landed without helping.
 *
 *   /api/build answers it for the SERVER. Portainer polls and reports back to
 *   nobody, so before this the only evidence was whether a fix appeared to
 *   work.
 *
 *   asset() answers it for the BROWSER. Cloudflare caches CSS and JS for four
 *   hours and overrides the origin's Cache-Control, so a shipped front-end fix
 *   is invisible for that long and looks exactly like a failed deploy. On
 *   2026-09-05 a menu fix on the public site was correct, deployed and verified
 *   in a browser, and still broken for the person looking at it —
 *   cf-cache-status: HIT, age: 1332, last-modified in August.
 *
 * The property worth defending in both cases is that the value MOVES when the
 * thing it describes moves, and that nothing has to be remembered for that to
 * keep being true.
 *
 * Run: node --test test/build-stamp.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const root = path.join(__dirname, '..');
const { BUILD, sourceFiles, asset } = require('../build');

/**
 * Append a probe to `relPath`, re-require build.js, hand the fresh module to
 * `read`, then restore. `read` runs WHILE the probe is in place — asset() is
 * lazy and caches on first call, so reading it after the restore would just
 * re-hash the original file and the assertion would compare a value to itself.
 */
function withProbe(relPath, read) {
  const target   = path.join(root, relPath);
  const original = fs.readFileSync(target);
  try {
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n/* build-stamp probe */\n')]));
    delete require.cache[require.resolve('../build')];
    return read(require('../build'));
  } finally {
    fs.writeFileSync(target, original);
    delete require.cache[require.resolve('../build')];
  }
}

const stampWith = relPath => withProbe(relPath, m => m.BUILD);

// ── The server stamp ─────────────────────────────────────────────────────────

test('the stamp is a real hash, not the failure value', () => {
  assert.match(BUILD, /^[0-9a-f]{12}$/);
  assert.notStrictEqual(BUILD, 'unknown');
});

test('editing server source moves the stamp', () => {
  assert.notStrictEqual(stampWith('index.js'), BUILD, 'editing index.js did not move the stamp');
});

test('editing a template moves it too — templates are deployed behaviour', () => {
  const name = fs.readdirSync(path.join(root, 'views')).find(f => f.endsWith('.ejs'));
  assert.ok(name, 'expected at least one template');
  assert.notStrictEqual(stampWith(`views/${name}`), BUILD, `editing views/${name} did not move the stamp`);
});

test('the walk covers what ships and excludes dependencies and live data', () => {
  const files = sourceFiles();
  assert.ok(files.includes('index.js'), 'index.js is not covered by the stamp');
  assert.ok(files.some(f => f.startsWith('views/')), 'templates are not covered');
  assert.ok(files.some(f => f.startsWith('api/')), 'the api router is not covered');
  assert.ok(!files.some(f => f.includes('node_modules')), 'node_modules must not be hashed');
  assert.ok(!files.some(f => f.startsWith('data/')), 'live data must not be hashed');
  assert.ok(!files.includes('package-lock.json'), 'the lockfile is deliberately excluded');
});

test('/health and /api/build are registered ahead of the SSO gate', () => {
  const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const gate = src.indexOf('const SSO_COOKIE');
  assert.ok(gate > 0, 'expected the SSO block to exist');
  for (const route of ["app.get('/health'", "app.get('/api/build'"]) {
    const at = src.indexOf(route);
    assert.ok(at > 0, `${route} is not registered`);
    assert.ok(at < gate, `${route} is registered after the SSO gate`);
  }
});

// ── The asset stamps ─────────────────────────────────────────────────────────

test('asset() stamps a real file and moves when that file changes', () => {
  assert.match(asset('/theme.css'), /^\/theme\.css\?v=[0-9a-f]{8}$/);
  const moved = withProbe('public/theme.css', m => m.asset('/theme.css'));
  assert.match(moved, /^\/theme\.css\?v=[0-9a-f]{8}$/);
  assert.notStrictEqual(moved, asset('/theme.css'), 'editing theme.css did not move its stamp');
});

/**
 * BUILD moves whenever any server file changes. If asset() used it, every
 * deploy would re-download every asset and throw away caching that is doing its
 * job. Per-file means the stamp changes when and only when that asset does.
 */
test('an asset stamp is per file, not the build stamp', () => {
  assert.notStrictEqual(asset('/theme.css').split('=')[1], BUILD);
  assert.notStrictEqual(asset('/theme.css').split('=')[1], asset('/stick-figure.js').split('=')[1]);

  // Touching the server must NOT move an asset stamp.
  const after = withProbe('index.js', m => m.asset('/theme.css'));
  assert.strictEqual(after, asset('/theme.css'),
    'editing the server moved a CSS stamp — that re-downloads assets for no reason');
});

test('a missing asset degrades to the bare path rather than throwing', () => {
  // A missing stamp is a stale cache. A thrown error is a blank page.
  assert.strictEqual(asset('/definitely-not-here.css'), '/definitely-not-here.css');
});

/**
 * The guard that matters most. Everything above can be right while one template
 * still links an unstamped URL — and that template is the one that goes stale,
 * silently, exactly as if the deploy had failed. Found by scanning every view,
 * so a template added tomorrow is covered without anyone remembering.
 */
test('every CSS and JS reference in every view is stamped', () => {
  const views = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ejs')) views.push(full);
    }
  })(path.join(root, 'views'));
  assert.ok(views.length, 'no views found — the assertion below would pass vacuously');

  const unstamped = [];
  for (const file of views) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:href|src)="(\/[^"]*\.(?:css|js))"/g)) {
      unstamped.push(`${path.relative(root, file)} → ${m[1]}`);
    }
  }
  assert.deepEqual(unstamped, [],
    'these link an unversioned asset, so Cloudflare will keep serving the cached ' +
    "copy for four hours after a deploy — use <%= asset('/path') %>");
});

/**
 * asset() has to actually reach the templates. app.locals is what makes that
 * true without every render remembering to pass it, so this drives express's
 * real render pipeline rather than asserting the assignment exists.
 */
test('app.locals.asset reaches a render, with nothing passed per-render', async () => {
  const express = require('express');
  const os      = require('node:os');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-views-'));
  try {
    fs.writeFileSync(path.join(dir, 'probe.ejs'), `<link href="<%= asset('/theme.css') %>">`);

    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', dir);
    app.locals.asset = asset;

    // No `asset` in the render locals — app.locals is the whole mechanism.
    const html = await new Promise((resolve, reject) =>
      app.render('probe', {}, (err, out) => (err ? reject(err) : resolve(out))));

    assert.match(html, /href="\/theme\.css\?v=[0-9a-f]{8}"/,
      'app.locals.asset did not reach the template');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the index view renders with a stamped stylesheet', () => {
  const ejs = require('ejs');
  const src = fs.readFileSync(path.join(root, 'views', 'index.ejs'), 'utf8');
  const head = src.slice(0, src.indexOf('</head>'));
  const out  = ejs.render(head, { asset, title: 'probe' }, { async: false });
  assert.match(out, /href="\/theme\.css\?v=[0-9a-f]{8}"/,
    'the real template did not come out with a versioned stylesheet');
});
