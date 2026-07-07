const fs = require('fs');
const express = require('express');
const { db } = require('../db');
const { requireUser, githubConfigured } = require('../lib/auth');
const { planFor } = require('../lib/plans');
const { uploadLimiter } = require('../lib/ratelimit');
const { listRepos, listHtmlPaths, pullRepo } = require('../lib/github');
const { artifactRoot, isModuleEntry, appRootFor, uiModuleOk, writeEntryWrapper } = require('../lib/artifacts');
const { newId } = require('../lib/util');
const path = require('path');

const router = express.Router();

function requireToken(req, res, next) {
  if (!req.user.github_token) {
    return res.status(400).json({ error: 'github_not_connected', message: 'Connect GitHub repositories first.' });
  }
  next();
}

// Repo picker data for the create-test form. `available` tells the frontend
// whether offering "connect" makes sense at all (GitHub OAuth configured).
router.get('/api/github/repos', requireUser, async (req, res) => {
  const available = githubConfigured();
  if (!req.user.github_token) return res.json({ connected: false, available });
  try {
    res.json({ connected: true, available, repos: await listRepos(req.user.github_token) });
  } catch (e) {
    if (e.status === 401) {
      // Token revoked on GitHub's side; drop it so the UI offers to reconnect.
      db.prepare('UPDATE users SET github_token = NULL WHERE id = ?').run(req.user.id);
      return res.json({ connected: false, available });
    }
    res.status(502).json({ error: 'github_error', message: e.message });
  }
});

// Start-page candidates on a branch (HTML pages + React entry modules), for
// the entry-page picker.
router.get('/api/github/tree', requireUser, requireToken, async (req, res) => {
  try {
    res.json(await listHtmlPaths(req.user.github_token, String(req.query.repo || ''), String(req.query.ref || '')));
  } catch (e) {
    res.status(e.status === 404 ? 404 : 400).json({ error: 'github_error', message: e.message });
  }
});

// ---------- live entry-page preview ----------
// The picker preview hosts a real snapshot of the branch (same serving
// pipeline as a test, transpilation included) so React entries render, CSS
// and images resolve, and what the dev sees is what testers will get. The
// snapshot lives in an artifact dir keyed by an unguessable id — it's served
// on the run host (no cookies there), so the id is the whole capability,
// exactly like a test link. One live preview per user; the retention sweep
// removes any preview dir a restart orphans (no test row → orphan).

const previews = new Map(); // user id → { id, repo, ref, wrappers: Map(entry → path) }

router.post('/api/github/preview', uploadLimiter, requireUser, requireToken, async (req, res) => {
  const repo = String(req.body?.repo || '');
  const ref = String(req.body?.ref || '').trim();
  const entry = String(req.body?.entry || '').replace(/^\/+/, '');
  if (!entry || entry.includes('..') || path.posix.isAbsolute(entry)) {
    return res.status(400).json({ error: 'bad_entry', message: 'Pick a start page to preview.' });
  }
  const maxBytes = planFor(req.user).artifactBytes;
  let p = previews.get(req.user.id);
  try {
    if (!p || p.repo !== repo || p.ref !== ref || !fs.existsSync(artifactRoot('preview-' + p.id))) {
      if (p) fs.rmSync(artifactRoot('preview-' + p.id), { recursive: true, force: true });
      p = { id: newId(16), repo, ref, wrappers: new Map() };
      await pullRepo('preview-' + p.id, req.user.github_token, repo, ref, '', maxBytes);
      previews.set(req.user.id, p);
    }
  } catch (e) {
    if (e.code === 'ARTIFACT_TOO_LARGE') {
      return res.status(413).json({
        error: 'artifact_too_large',
        message: `Repository exceeds your plan's ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
      });
    }
    return res.status(e.status === 404 ? 404 : 400).json({ error: 'github_error', message: e.message });
  }
  let pagePath = entry;
  if (isModuleEntry(entry)) {
    // Module entries need a host page; synthesize one per previewed entry.
    // Same uiModuleOk gate as test creation — a Node server's src/index.js
    // is not a browser app.
    pagePath = p.wrappers.get(entry);
    if (!pagePath) {
      const appRoot = appRootFor(entry);
      const moduleRel = appRoot ? entry.slice(appRoot.length + 1) : entry;
      if (!uiModuleOk(path.join(artifactRoot('preview-' + p.id), appRoot), moduleRel)) {
        return res.status(400).json({
          error: 'not_ui_module',
          message: 'This module is not a hostable app entry (its package.json has no React, Preact, or Ink dependency).',
        });
      }
      const name = writeEntryWrapper(path.join(artifactRoot('preview-' + p.id), appRoot), moduleRel);
      pagePath = appRoot ? `${appRoot}/${name}` : name;
      p.wrappers.set(entry, pagePath);
    }
  }
  res.json({ id: p.id, path: pagePath });
});

module.exports = router;
