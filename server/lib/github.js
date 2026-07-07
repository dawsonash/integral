const fs = require('fs');
const AdmZip = require('adm-zip');
const { ingestFiles, artifactRoot, MODULE_ENTRY_RE, appRootFor } = require('./artifacts');

// Overridable so tests can point at a local mock instead of api.github.com.
function apiBase() {
  return process.env.INTEGRAL_GITHUB_API || 'https://api.github.com';
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'integral',
    Accept: 'application/vnd.github+json',
  };
}

function ghError(status) {
  const err = new Error(
    status === 404
      ? 'Repository or branch not found (or the connection lost access to it).'
      : `GitHub API error (${status})`
  );
  err.status = status;
  return err;
}

async function ghJson(token, p) {
  const res = await fetch(apiBase() + p, { headers: ghHeaders(token) });
  if (!res.ok) throw ghError(res.status);
  return res.json();
}

async function listRepos(token) {
  const repos = await ghJson(token, '/user/repos?per_page=100&sort=pushed');
  return repos.map((r) => ({
    full_name: r.full_name,
    default_branch: r.default_branch,
    private: !!r.private,
    pushed_at: r.pushed_at,
  }));
}

// Start-page candidates on a branch (paths relative to repo root), for the
// entry-page picker: every HTML file, plus conventional React/module entry
// points (src/main.jsx, source/cli.tsx and friends) so unbuilt projects
// still get a start page. Dot-directories are hidden, same as ingestion
// skips them.
async function listHtmlPaths(token, fullName, ref) {
  if (!validRepoName(fullName)) throw new Error('Invalid repository name.');
  if (!validRef(ref)) throw new Error('Invalid branch name.');
  const tree = await ghJson(token, `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  // Shallowest first, index.html ahead of its siblings — the likeliest entry
  // page tops the picker.
  const rank = (p) => {
    const segs = p.split('/');
    return [segs.length, /^index\.html?$/i.test(segs[segs.length - 1]) ? 0 : 1];
  };
  const bySight = (a, b) => {
    const [da, ia] = rank(a);
    const [db_, ib] = rank(b);
    return da - db_ || ia - ib || a.localeCompare(b);
  };
  const paths = (tree.tree || [])
    .filter((e) => e.type === 'blob')
    .map((e) => e.path)
    .filter((p) => !p.split('/').some((seg) => seg.startsWith('.')) && !p.split('/').includes('node_modules'));
  const html = paths.filter((p) => /\.html?$/i.test(p)).sort(bySight);
  let modules = paths.filter((p) => MODULE_ENTRY_RE.test(p)).sort(bySight);
  // Same gate as ensureEntry/uiModuleOk: a Node server's src/index.js matches
  // the path convention too, so an entry is only offered when its app root's
  // package.json depends on a UI framework (or, with no manifest at all, the
  // file itself is JSX).
  if (modules.length) {
    const pathSet = new Set(paths);
    const keep = new Set();
    for (const root of [...new Set(modules.map(appRootFor))].slice(0, 5)) {
      const pkgPath = root ? `${root}/package.json` : 'package.json';
      const inRoot = modules.filter((m) => appRootFor(m) === root);
      if (!pathSet.has(pkgPath)) {
        inRoot.filter((m) => /\.[jt]sx$/i.test(m)).forEach((m) => keep.add(m));
        continue;
      }
      const deps = await fetchPackageDeps(token, fullName, ref, pkgPath);
      if (deps.react || deps.preact || deps.ink) inRoot.forEach((m) => keep.add(m));
    }
    modules = modules.filter((m) => keep.has(m));
  }
  return { html, modules, truncated: !!tree.truncated };
}

// dependencies (+dev) declared by one package.json on the branch; {} on any
// failure — the gate then simply offers no module entries for that root.
async function fetchPackageDeps(token, fullName, ref, pkgPath) {
  try {
    const url = `${apiBase()}/repos/${fullName}/contents/${pkgPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers: { ...ghHeaders(token), Accept: 'application/vnd.github.raw' } });
    if (!res.ok) return {};
    const pkg = JSON.parse(await res.text());
    return { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
  } catch (e) {
    return {};
  }
}

// These end up in API URLs; reject anything that could change the path shape.
function validRepoName(fullName) {
  return /^[\w.-]+\/[\w.-]+$/.test(fullName);
}
function validRef(ref) {
  return /^[\w./-]+$/.test(ref) && !ref.includes('..');
}

// Download a repo snapshot and ingest the files under `repoPath` (repo root
// when blank) as the test's artifact — same pipeline as a folder upload.
// `replace` swaps out an existing artifact, but only once the new snapshot is
// fully downloaded and filtered, so a failed pull never destroys the old one.
async function pullRepo(testId, token, fullName, branch, repoPath, maxBytes, { replace } = {}) {
  if (!validRepoName(fullName)) throw new Error('Invalid repository name.');
  let ref = (branch || '').trim();
  if (!ref) ref = (await ghJson(token, `/repos/${fullName}`)).default_branch;
  if (!validRef(ref)) throw new Error('Invalid branch name.');

  const res = await fetch(`${apiBase()}/repos/${fullName}/zipball/${encodeURIComponent(ref)}`, {
    headers: ghHeaders(token),
    redirect: 'follow',
  });
  if (!res.ok) throw ghError(res.status);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  // Check the declared uncompressed size before inflating anything.
  const total = zip.getEntries().reduce((n, e) => n + (e.header.size || 0), 0);
  if (maxBytes && total > maxBytes) {
    const err = new Error('artifact too large');
    err.code = 'ARTIFACT_TOO_LARGE';
    throw err;
  }

  const wanted = String(repoPath || '').replace(/^\/+|\/+$/g, '');
  const files = [];
  const relPaths = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    // GitHub zipballs wrap everything in an `owner-repo-sha/` directory.
    let rel = entry.entryName.split('/').slice(1).join('/');
    if (!rel) continue;
    if (wanted) {
      if (!rel.startsWith(wanted + '/')) continue;
      rel = rel.slice(wanted.length + 1);
    }
    const base = rel.split('/').pop();
    if (base.startsWith('.') || rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    files.push({ buffer: entry.getData(), originalname: rel });
    relPaths.push(rel);
  }
  if (!files.length) {
    throw new Error(wanted ? `No files found under "${wanted}" on ${ref}.` : `No files found on ${ref}.`);
  }
  // Zip headers can understate; re-check the real inflated sizes before the
  // old artifact is discarded.
  const actualBytes = files.reduce((n, f) => n + f.buffer.length, 0);
  if (maxBytes && actualBytes > maxBytes) {
    const err = new Error('artifact too large');
    err.code = 'ARTIFACT_TOO_LARGE';
    throw err;
  }
  if (replace) fs.rmSync(artifactRoot(testId), { recursive: true, force: true });
  ingestFiles(testId, files, relPaths, maxBytes);
}

module.exports = { listRepos, listHtmlPaths, pullRepo };
