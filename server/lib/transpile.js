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
// file exists as written or nothing matches.
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
  return spec;
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
  if (spec.startsWith('.')) return resolveRelative(spec, fromRel, rootDir);
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

// Rewrite the import graph of esbuild's output. esbuild re-prints code with
// normalized double-quoted specifiers, so regex matching is reliable here.
function rewriteImports(code, fromRel, rootDir, mountPrefix, deps) {
  const rw = (spec) => rewriteSpec(spec, fromRel, rootDir, mountPrefix, deps);

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

// Transform one artifact source file for native browser loading. Returns the
// rewritten code, or null when esbuild can't parse it — callers fall back to
// serving the file untouched, so an odd file degrades instead of breaking.
function transpile(source, { rootDir, relPath, mountPrefix }) {
  const ext = path.extname(relPath).toLowerCase();
  const loader = LOADERS[ext];
  if (!loader) return null;
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
    return null;
  }
  return rewriteImports(out.code, relPath, rootDir, mountPrefix || '/', readDeps(rootDir));
}

module.exports = { transpile, canTranspile, readDeps, esmShUrl };
