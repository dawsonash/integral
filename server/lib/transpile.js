// No-build hosting for React/JSX artifacts. The design spec rules out running
// arbitrary repo builds (the Vercel problem), so instead each JS-family file
// is transpiled at serve time with esbuild's transform API — pure syntax
// work, no artifact code executes on the server — and its imports are
// rewritten so a browser can load the module graph natively:
//   - bare specifiers ("react", "zustand") → esm.sh CDN, pinned to the
//     version in the artifact's package.json when present
//   - extensionless relative imports ("./App") → the real file on disk
//   - CSS imports → a snippet that injects a <link> (with a name proxy for
//     *.module.css, whose class names are unhashed when served raw)
//   - asset imports (svg/png/…) → a URL string, matching bundler behavior
//   - root-absolute specifiers ("/src/main.jsx") → the artifact mount prefix
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const LOADERS = { '.js': 'jsx', '.mjs': 'jsx', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.tsx': 'tsx' };
const RESOLVE_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];
const ASSET_RE = /\.(svg|png|jpe?g|gif|webp|ico|bmp|avif|mp[34]|webm|woff2?|ttf)$/i;

function canTranspile(ext) {
  return ext in LOADERS;
}

// dependencies/devDependencies of the artifact's own package.json, for
// pinning esm.sh URLs to the versions the app was written against.
function readDeps(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  } catch (e) {
    return {};
  }
}

function esmShUrl(spec, deps) {
  // "react-dom/client" → package "react-dom", subpath "/client";
  // scoped names keep their first two segments.
  const segs = spec.split('/');
  const nameLen = spec.startsWith('@') ? 2 : 1;
  const name = segs.slice(0, nameLen).join('/');
  const subpath = segs.slice(nameLen).join('/');
  const version = deps[name] ? '@' + encodeURIComponent(deps[name]) : '';
  // Ink companion packages (ink-select-input, @inkjs/ui, …) declare a loose
  // ink peer range; left alone, esm.sh resolves it to the latest major and
  // the app ends up with two ink instances — components render but their
  // useInput hooks listen on a context the app never mounts. Pinning via
  // ?deps collapses them onto the artifact's own ink and react. The react
  // pin changes which build *variant* of ink esm.sh serves, so ink itself
  // must carry the identical pin or it forks into two instances again.
  const pinNames = name === 'ink' ? ['react'] : /^ink-|^@inkjs\//.test(name) ? ['ink', 'react'] : [];
  const pins = pinNames.filter((d) => deps[d]).map((d) => `${d}@${encodeURIComponent(deps[d])}`);
  const query = pins.length ? '?deps=' + pins.join(',') : '';
  return `https://esm.sh/${name}${version}${subpath ? '/' + subpath : ''}${query}`;
}

// TypeScript ESM convention: source imports name the *compiled* file
// ("./app.js" for app.ts/app.tsx). Served unbuilt, the .ts flavor is what
// actually exists on disk.
const TS_SWAPS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.jsx': ['.tsx'] };

// "./App" (as imported from `fromRel`) → "./App.jsx", by looking at what
// actually exists in the artifact. Returns the specifier unchanged when the
// file exists as written, and null when nothing matches.
function resolveRelative(spec, fromRel, rootDir) {
  const fromDir = path.posix.dirname(fromRel);
  const target = path.posix.normalize(path.posix.join(fromDir, spec));
  if (target.startsWith('..')) return spec;
  const exists = (rel) => {
    const full = path.join(rootDir, rel);
    return fs.existsSync(full) && fs.statSync(full).isFile();
  };
  if (exists(target)) return spec;
  const ext = path.posix.extname(target).toLowerCase();
  for (const alt of TS_SWAPS[ext] || []) {
    if (exists(target.slice(0, -ext.length) + alt)) return spec.slice(0, -ext.length) + alt;
  }
  for (const ext of RESOLVE_EXTS) {
    if (exists(target + ext)) return spec + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    if (exists(target + '/index' + ext)) return spec.replace(/\/$/, '') + '/index' + ext;
  }
  return null;
}

// Why a relative specifier can't be served (with steps to fix it), or null
// when it can. Specifiers with query/hash suffixes (Vite's "?raw" etc.) are
// left alone — their meaning is bundler-specific, not a missing file.
function unresolvableReason(spec, fromRel, rootDir) {
  if (!spec.startsWith('.') || /[?#]/.test(spec)) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (target.startsWith('..')) {
    return (
      `"${spec}" (imported by ${fromRel}) points outside the hosted folder — ` +
      "only the start page's folder and everything below it are hosted.\n\n" +
      'How to fix: move the imported file inside the hosted folder, or pick a start page higher up so the import stays inside it.'
    );
  }
  if (resolveRelative(spec, fromRel, rootDir) != null) return null;
  return (
    `Cannot find "${spec}" imported by ${fromRel} — no matching file in this test's files.\n\n` +
    'How to fix:\n' +
    '1. Check the import path, spelling, and extension — it must match a file exactly (case-sensitive).\n' +
    '2. If the file exists in your project, commit and push it to the selected branch, or re-upload it.\n' +
    '3. Reload this preview.'
  );
}

// A bare specifier the artifact carries a browser stand-in for (written to
// __integral/<name>.js next to the app root by writeStandIns) resolves to
// that stand-in instead of esm.sh. Searched upward from the importing file
// so nested app roots find their own.
function standInFor(spec, fromRel, rootDir) {
  if (!/^[\w-]+$/.test(spec)) return null;
  let dir = path.posix.dirname(fromRel);
  if (dir === '.') dir = '';
  for (;;) {
    const rel = (dir ? dir + '/' : '') + `__integral/${spec}.js`;
    if (fs.existsSync(path.join(rootDir, rel))) {
      const out = path.posix.relative(path.posix.dirname(fromRel), rel);
      return out.startsWith('.') ? out : './' + out;
    }
    if (!dir) return null;
    const parent = path.posix.dirname(dir);
    dir = parent === '.' ? '' : parent;
  }
}

function rewriteSpec(spec, fromRel, rootDir, mountPrefix, deps) {
  if (/^(https?:)?\/\//.test(spec) || spec.startsWith('data:')) return spec;
  if (spec.startsWith('/')) return mountPrefix + spec.slice(1);
  if (spec.startsWith('.')) return resolveRelative(spec, fromRel, rootDir) || spec;
  // Node builtins can't come from the registry; esm.sh hosts browser
  // polyfills for them (stubs where no browser equivalent exists).
  if (spec.startsWith('node:')) return `https://esm.sh/node/${spec.slice(5)}.mjs`;
  return standInFor(spec, fromRel, rootDir) || esmShUrl(spec, deps);
}

// `import "./x.css"` can't load natively; replace the statement with code
// that links the stylesheet relative to the module's own URL.
function cssInject(spec) {
  return (
    'document.head.appendChild(Object.assign(document.createElement("link"),' +
    `{rel:"stylesheet",href:new URL(${JSON.stringify(spec)},import.meta.url).href}));`
  );
}

// An import the server already knows is broken becomes code that tells the
// developer what's wrong (via the wrapper's boot-error overlay) and then
// throws — instead of letting the browser 404 with a detail-free
// "Failed to load" event.
function reportAndThrow(msg) {
  return (
    '(function (m) { console.error(m); ' +
    'if (typeof window !== "undefined" && window.__integralBootError) window.__integralBootError(m); ' +
    'throw new Error(m.split("\\n")[0]); })(' + JSON.stringify(msg) + ');'
  );
}

// Rewrite the import graph of esbuild's output. esbuild re-prints code with
// normalized double-quoted specifiers, so regex matching is reliable here.
function rewriteImports(code, fromRel, rootDir, mountPrefix, deps) {
  const rw = (spec) => rewriteSpec(spec, fromRel, rootDir, mountPrefix, deps);

  // Static imports that can't resolve to anything servable are diagnosed
  // now, while the importer and specifier are both known: the statement
  // becomes a reporter naming the missing file and how to fix it.
  code = code.replace(
    /(^|\n)((?:import|export)\s[^"'\n]*?\sfrom\s*|import\s*)"([^"\n]+)";?/g,
    (m, lead, clause, spec) => {
      const reason = unresolvableReason(spec, fromRel, rootDir);
      return reason ? lead + reportAndThrow(reason) : m;
    }
  );
  // Side-effect imports: CSS becomes a <link> injection, the rest rewrite.
  code = code.replace(/(^|\n)import\s*"([^"\n]+)";?/g, (m, lead, spec) => {
    if (/\.css$/i.test(spec) && spec.startsWith('.')) return lead + cssInject(spec);
    return `${lead}import "${rw(spec)}";`;
  });
  // Default imports of CSS modules and static assets become plain values.
  code = code.replace(
    /(^|\n)import\s+([A-Za-z_$][\w$]*)\s+from\s*"([^"\n]+)";?/g,
    (m, lead, name, spec) => {
      if (!spec.startsWith('.')) return m;
      if (/\.module\.css$/i.test(spec)) {
        // Served raw, module CSS keeps its authored class names, so a proxy
        // that echoes the key back reproduces the mapping.
        return `${lead}${cssInject(spec)}const ${name} = new Proxy({}, { get: (t, k) => k });`;
      }
      if (/\.css$/i.test(spec)) return lead + cssInject(spec);
      if (ASSET_RE.test(spec)) {
        return `${lead}const ${name} = new URL(${JSON.stringify(spec)}, import.meta.url).href;`;
      }
      return m;
    }
  );
  // Everything else that carries a specifier: `from "..."` clauses (named,
  // namespace, re-exports) and dynamic import("...").
  code = code.replace(/(\bfrom\s*)"([^"\n]+)"/g, (m, kw, spec) => `${kw}"${rw(spec)}"`);
  code = code.replace(/(\bimport\(\s*)"([^"\n]+)"(\s*\))/g, (m, open, spec, close) => `${open}"${rw(spec)}"${close}`);
  return code;
}

// esbuild's structured errors → a message the boot-error overlay can show:
// file:line:column, what esbuild said, and the offending source line. The
// browser would reject the same file with nothing but "Failed to load".
function describeEsbuildError(e, relPath) {
  const errs = (e && e.errors) || [];
  if (!errs.length) return (e && e.message) || String(e);
  const parts = errs.slice(0, 3).map((err) => {
    const loc = err.location || {};
    const where = loc.line ? `${relPath}:${loc.line}:${(loc.column || 0) + 1}` : relPath;
    const caret = loc.lineText ? `\n  ${loc.lineText}\n  ${' '.repeat(loc.column || 0)}^` : '';
    return `${where}: ${err.text}${caret}`;
  });
  if (errs.length > 3) parts.push(`(+${errs.length - 3} more)`);
  return 'Syntax error — this file could not be compiled:\n' + parts.join('\n');
}

// Transform one artifact source file for native browser loading. Returns
// { code } with the rewritten module, or { error } with a human-readable
// diagnosis when esbuild can't parse it — the browser couldn't parse such a
// file either, so callers serve the diagnosis instead of the raw source.
function transpile(source, { rootDir, relPath, mountPrefix }) {
  const ext = path.extname(relPath).toLowerCase();
  const loader = LOADERS[ext];
  if (!loader) return { code: null, error: null };
  let out;
  try {
    out = esbuild.transformSync(source, {
      loader,
      jsx: 'automatic',
      target: 'es2020',
      sourcefile: relPath,
      logLevel: 'silent',
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env.MODE': '"production"',
        'import.meta.env.DEV': 'false',
        'import.meta.env.PROD': 'true',
        'import.meta.env.SSR': 'false',
        'import.meta.env.BASE_URL': '"./"',
        'import.meta.env': '{}',
      },
    });
  } catch (e) {
    return { code: null, error: describeEsbuildError(e, relPath) };
  }
  return {
    code: rewriteImports(out.code, relPath, rootDir, mountPrefix || '/', readDeps(rootDir)),
    error: null,
  };
}

module.exports = { transpile, canTranspile, readDeps, esmShUrl };
