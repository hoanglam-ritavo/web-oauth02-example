import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const errors = [];
let links = 0, commands = 0, paths = 0;
const read = file => readFileSync(file, 'utf8');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = join(directory, entry.name);
  return entry.isDirectory() ? walk(file) : entry.name.endsWith('.md') ? [file] : [];
});
const files = readdirSync(root).filter(name => name.endsWith('.md')).map(name => join(root, name));
if (existsSync(join(root, 'docs'))) files.push(...walk(join(root, 'docs')));
function withoutCode(text) {
  let fence;
  return text.split(/\r?\n/).map(line => {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}
function anchors(text) {
  const visible = withoutCode(text), found = new Set(), used = new Set();
  for (const match of visible.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-');
    let slug = base, n = 0;
    while (used.has(slug)) slug = `${base}-${++n}`;
    used.add(slug); found.add(slug);
  }
  for (const match of visible.matchAll(/<[^>]+\b(?:id|name)=["']([^"']+)["'][^>]*>/g)) found.add(match[1]);
  return found;
}
for (const file of files) {
  const text = read(file), visible = withoutCode(text).replace(/`+[^`]*`+/g, '');
  for (const match of visible.matchAll(/\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const url = match[1].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) continue;
    links++;
    const [target, fragment] = url.split('#');
    let resolved;
    try { resolved = target ? resolve(dirname(file), decodeURIComponent(target)) : file; }
    catch { errors.push(`${file}: invalid link ${url}`); continue; }
    if (!existsSync(resolved)) errors.push(`${file}: missing link ${url}`);
    else if (fragment && !anchors(read(resolved)).has(decodeURIComponent(fragment))) errors.push(`${file}: missing anchor ${url}`);
  }
  let historical = false, owner = root;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('<!-- docs:historical:start -->')) {
      if (historical) errors.push(`${file}: nested historical marker`);
      historical = true; continue;
    }
    if (line.includes('<!-- docs:historical:end -->')) {
      if (!historical) errors.push(`${file}: unmatched historical end`);
      historical = false; continue;
    }
    if (historical) continue;
    const context = /<!-- docs:project (.+?) -->/.exec(line);
    if (context) {
      owner = resolve(root, context[1]);
      if (!existsSync(join(owner, 'package.json'))) errors.push(`${file}: missing project ${context[1]}`);
      continue;
    }
    for (const match of line.matchAll(/\bnpm (?:run ([\w:-]+)|(test|start))\b/g)) {
      commands++;
      const script = match[1] ?? match[2];
      if (!existsSync(join(owner, 'package.json')) || !JSON.parse(read(join(owner, 'package.json'))).scripts?.[script]) errors.push(`${file}: missing npm script ${script} in ${owner}`);
    }
    for (const match of line.matchAll(/(?<![\w/.-])((?:test|scripts)\/[\w./*-]+\.(?:ts|mjs|js|cjs))/g)) {
      paths++;
      const value = match[1];
      if (value.includes('*')) {
        const directory = resolve(owner, dirname(value));
        const pattern = new RegExp('^' + value.split('/').at(-1).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        if (!existsSync(directory) || !readdirSync(directory).some(name => pattern.test(name))) errors.push(`${file}: missing path ${value}`);
      } else if (!existsSync(resolve(owner, value))) errors.push(`${file}: missing path ${value}`);
    }
  }
  if (historical) errors.push(`${file}: unclosed historical marker`);
}
if (existsSync(join(root, 'docs/flows'))) {
  for (const branch of ['web-flows', 'mobile-flows']) {
    if (!existsSync(join(root, 'docs/flows', branch))) errors.push(`Missing flow directory ${branch}`);
  }
  for (const file of files) if (/docs\/flows\/0[123]-/.test(read(file))) errors.push(`${file}: obsolete flow link`);
}
console.log(JSON.stringify({ documents: files.length, links, commands, paths, errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
