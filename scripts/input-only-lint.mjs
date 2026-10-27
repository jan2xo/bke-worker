#!/usr/bin/env node
/**
 * Conservative static regression detector, NOT proof of an input-only runtime.
 * Scans extension source and the Gecko worker-extension. Does not inspect DOM,
 * browser state, credentials or ChatGPT responses and changes no CI workflows.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SOURCE_DIRS = [
  'browser-extension/src',
  'android-gecko/app/src/main/assets/worker-extension',
];
const EXTENSIONS = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs']);
const READ_METHODS = /\b(?:innerText|textContent|innerHTML|outerHTML)\b/g;
const REPLY_SELECTOR = /\b(?:querySelector(?:All)?|closest|matches|getElementById)\s*\([^\n)]*(?:reply|message[-_ ]?list|assistant[-_ ]?message|conversation[-_ ]?turn)/gi;
const REPLY_LITERAL = /(?:['"`])(?:\[[^\n'"`]*|[.#][^\n'"`]*)(?:reply|message[-_ ]?list|assistant[-_ ]?message|conversation[-_ ]?turn)[^\n'"`]*['"`]/gi;

/** Source may contain comments; false positives are deliberately not suppressed. */
export function scanSource(text, relativePath) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, n) => {
    for (const [kind, pattern] of [
      ['DOM_TEXT_ACCESS', READ_METHODS],
      ['REPLY_SELECTOR', REPLY_SELECTOR],
      ['REPLY_SELECTOR', REPLY_LITERAL],
    ]) {
      pattern.lastIndex=0;
      let hit;
      while ((hit=pattern.exec(line)) !== null) {
        findings.push({file:relativePath,line:n+1,kind,match:hit[0]});
        if (hit[0].length===0) pattern.lastIndex++;
      }
    }
  });
  return findings;
}

function collect(dir, root, findings) {
  if (!fs.existsSync(dir)) return; // another checkout may omit a platform
  for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const full=path.join(dir,item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) {collect(full,root,findings);continue;}
    if (!item.isFile() || !EXTENSIONS.has(path.extname(item.name))) continue;
    const relative=path.relative(root,full).split(path.sep).join('/');
    findings.push(...scanSource(fs.readFileSync(full,'utf8'),relative));
  }
}
export function scanRepository(root) {
  const findings=[];
  for (const dir of SOURCE_DIRS) collect(path.join(root,dir),root,findings);
  return findings.sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line);
}

const isEntrypoint = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const findings=scanRepository(root);
  for (const f of findings) {
    process.stderr.write(f.file+':'+f.line+' '+f.kind+' '+f.match+'\n');
  }
  if (findings.length) {
    process.stderr.write('Input-only source lint failed: '+findings.length+
      ' findings. Static regression detector only; not runtime proof.\n');
    process.exitCode=1;
  } else {
    process.stdout.write('Input-only source lint: no listed patterns (NOT runtime proof).\n');
  }
}
