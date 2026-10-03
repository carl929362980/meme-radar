// Distribution invariants for this product.
//
// This file began life as `ave-only.test.mjs`: it was added in 12e5c56
// ("release: ship free-tier AVE radar v0.1.11"), the commit that deleted
// src/gmgn.mjs, src/gmgn-connection.mjs, src/gmgn-key-store.mjs and
// src/gmgn-readonly-worker.mjs so the open-source build needed nothing but an
// AVE key. Its stated reason was end-user simplicity, not safety:
//
//   「只需一把 AVE API Key，保存在当前电脑；不需 Agent 公钥或钱包。
//     旧数据源客户端、密钥接口与安装依赖已移除」
//
// ---
//
// 2026-10-03: the AVE-only clause is deliberately retired.
//
// AVE's trending list cannot supply what this product now needs. Its youngest
// pool is over an hour old (the <1h count is 0) and the mature-pool path is
// dead-locked by `enrichLimit: 0`, so "discovery" is structurally impossible
// with AVE alone. GMGN's trenches feed returns pools that are seconds old
// through this project's own gates (measured: 17 SOL / 2 BSC rows, 0 bans).
//
// The reason GMGN was removed does not apply to the client this project added:
// the old one needed an Agent key/wallet and a key store, while market routes
// use exist-auth (X-APIKEY + timestamp + client_id, no signature) and
// src/gmgn.mjs never reads GMGN_PRIVATE_KEY. So the removal's premise is gone,
// and what replaces it is asserted below.
//
// Everything else this file protected is still protected, and the "no signing
// key" property is now asserted directly rather than inferred from a filename
// that had to not exist. Keep these assertions; only the AVE-only clause was
// retired.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('production carries no credential store, connection manager or background worker', () => {
  // gmgn.mjs is intentionally absent from this list - see the header. These
  // three are kept because they are the credential machinery, and that stays
  // forbidden no matter how many market providers exist.
  for (const name of ['gmgn-key-store.mjs', 'gmgn-connection.mjs', 'gmgn-readonly-worker.mjs']) {
    assert.equal(fs.existsSync(path.join(root, 'src', name)), false, name);
  }
});

test('the production import graph is walked and stays zero-dependency', () => {
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)];
    for (const [, specifier] of imports) {
      assert.ok(specifier.startsWith('.') || specifier.startsWith('node:'), `Unexpected runtime dependency: ${specifier}`);
      if (specifier.startsWith('.')) visit(path.resolve(path.dirname(file), specifier));
    }
  }
  visit(path.join(root, 'src/main.mjs'));
  assert.ok(visited.size > 10, 'The whole production import graph must be inspected');
});

// Comments are removed before matching so a module may *document* that it does
// not read a signing key without tripping the very check that enforces it. The
// `[^:]` guard keeps `https://` in a URL from being read as a comment.
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('no source module can reach a signing key or a wallet, present or future', () => {
  // Asserted over every module rather than only the reachable graph, so a
  // provider client is covered the moment it exists - the wiring test would
  // otherwise be the only thing standing between us and a signing key.
  const dir = path.join(root, 'src');
  const modules = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  assert.ok(modules.length > 10, 'src/ must actually be scanned');
  for (const name of modules) {
    const code = stripComments(fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.doesNotMatch(code, /GMGN_PRIVATE_KEY|_PRIVATE_KEY|keypair\.pem|signTransaction|eth_requestAccounts|sendTransaction/, name);
  }
});

test('the distribution installs no legacy dependency and exports no credential endpoints', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies || {}, {});
  assert.deepEqual(Object.keys(lock.packages), ['']);
  const server = fs.readFileSync(path.join(root, 'src/server.mjs'), 'utf8');
  assert.doesNotMatch(server, /\/api\/gmgn|saveGmgnKey|disconnectGmgnKey|getGmgnOnboarding|getGmgnConnection|gmgnConnection|gmgnUrl/);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.doesNotMatch(html, /gmgn/i);
});
