import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { error, log } from 'node:console';
import process from 'node:process';

const digest = value => createHash('sha256').update(value).digest('hex');

function privateMarkers() {
  const value = process.env.OWNCONTEXT_PRIVATE_MARKERS;
  if (value === undefined) return new Set();
  const markers = JSON.parse(value);
  if (!Array.isArray(markers) || markers.some(marker => typeof marker !== 'string' || !marker.trim()))
    throw new Error('Private markers must be a JSON array of non-empty strings.');
  return new Set(markers.map(marker => digest(marker.trim().toLowerCase().replace(/\s+/g, '-'))));
}
const exampleDomain = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test)$/i;
const syntheticCredentials = new Set(['fixture-repository-token', 'repository-token-must-not-enter-auth']);
const credentialAssignments = [
  /["']?(?:[a-z0-9_]*(?:token|secret|password|api_key|apikey)|_auth)["']?\s*[:=]\s*["']([a-z0-9_.:+/=-]{24,})["']/gi,
  /^\s*(?:export\s+)?(?:\/\/[^\s]+\/:)?(?:[a-z0-9_]*(?:token|secret|password|api_key|apikey)|_auth)\s*[:=]\s*([a-z0-9_.:+/=-]{24,})\s*(?:#.*)?$/gi,
];
const patterns = [
  ['credential-token', /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-(?:ant-)?[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[a-z0-9-]{20,})\b/i],
  ['jwt-token', /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['home-directory', /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[a-z0-9_.-]+/i],
  ['bearer-token', /\bBearer\s+[a-z0-9_.:+/=-]{24,}/i],
];

export function scanText(text, markers = new Set()) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const rules = new Set();
    for (const [rule, pattern] of patterns) if (pattern.test(line)) rules.add(rule);
    for (const pattern of credentialAssignments) for (const match of line.matchAll(pattern)) {
      if (!syntheticCredentials.has(match[1])) rules.add('credential-assignment');
    }
    for (const match of line.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      if (!exampleDomain.test(match[1])) rules.add('personal-email');
    }
    const words = line.toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? [];
    for (let i = 0; i < words.length; i++) {
      if ([words[i], words.slice(i, i + 2).join('-'), words.slice(i, i + 3).join('-')]
        .some(word => markers.has(digest(word)))) { rules.add('private-identifier'); break; }
    }
    for (const match of line.matchAll(/https?:\/\/[^\s<>"'`\\)\]}]+/gi)) {
      let url;
      try { url = new URL(match[0].replace(/[.,;]+$/, '')); } catch { continue; }
      if (/(?:^|\.)(?:internal|corp|lan|local)$/.test(url.hostname)
        || /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) rules.add('internal-host');
      if (/registry|artifactory|nexus/i.test(url.hostname + url.pathname) && url.origin !== 'https://registry.npmjs.org')
        rules.add('non-public-registry');
      if ((url.username || url.password) && !exampleDomain.test(url.hostname)) rules.add('url-credentials');
    }
    const registry = line.match(/^\s*["']?(?:@[^\s:]+:)?registry["']?\s*[:=]\s*["']?([^\s"'`,]+)/i);
    if (registry && !/^https:\/\/registry\.npmjs\.org\/?$/.test(registry[1])) rules.add('non-public-registry');
    if (/"resolved"\s*:/.test(line)) {
      const resolved = line.match(/"resolved"\s*:\s*"([^"]+)"/);
      if (resolved && !resolved[1].startsWith('https://registry.npmjs.org/')) rules.add('dependency-source');
    }
    for (const rule of rules) findings.push({ line: index + 1, rule });
  }
  return findings;
}

export function checkRelease(root, markers = privateMarkers()) {
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (resolve(git(['rev-parse', '--show-toplevel']).trim()) !== resolve(root)) throw new Error('Run the release check from its source repository.');
  const staged = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, hash, stage] = entry.slice(0, tab).split(' ');
    return { path: entry.slice(tab + 1), mode, hash, stage };
  });
  const files = new Set([...staged.map(entry => entry.path), ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)]);
  const findings = [];
  const inspect = (path, text, source) => {
    for (const finding of scanText(text, markers)) findings.push({ path, source, ...finding });
  };
  for (const path of files) {
    const local = relative(root, resolve(root, path));
    if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Invalid release file path.');
    inspect(path, path, 'filename');
    const parts = path.split('/');
    let missing = false; let unsafe = false;
    for (let i = 1; i <= parts.length; i++) {
      let info;
      try { info = lstatSync(join(root, ...parts.slice(0, i))); }
      catch (cause) { if (cause.code === 'ENOENT') { missing = true; break; } throw cause; }
      if (info.isSymbolicLink() || (i === parts.length && !info.isFile())) { unsafe = true; break; }
    }
    if (unsafe) findings.push({ path, source: 'worktree', line: 1, rule: 'unsupported-file-type' });
    else if (!missing) inspect(path, readFileSync(join(root, path), 'utf8'), 'worktree');
  }
  for (const entry of staged) {
    if (!['100644', '100755'].includes(entry.mode) || entry.stage !== '0') {
      findings.push({ path: entry.path, source: 'index', line: 1, rule: 'unsupported-index-entry' });
      continue;
    }
    inspect(entry.path, git(['cat-file', 'blob', entry.hash]), 'index');
  }
  return { files: files.size, findings };
}

export function formatFinding(finding, markers = privateMarkers()) {
  const path = scanText(finding.path, markers).length ? '[redacted filename]' : finding.path;
  return `${JSON.stringify(path)}:${finding.line} (${finding.source}): ${finding.rule}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkRelease(fileURLToPath(new URL('../', import.meta.url)));
    for (const finding of result.findings) error(formatFinding(finding));
    if (result.findings.length) {
      error(`Release check failed: ${result.findings.length} findings. Matching values were withheld.`);
      process.exitCode = 1;
    } else log(`Release check passed: ${result.files} source files and staged contents scanned.`);
  } catch {
    error('Release check could not scan the complete repository. Check Git state and file access.');
    process.exitCode = 1;
  }
}
