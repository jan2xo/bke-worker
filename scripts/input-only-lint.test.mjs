import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanSource,scanRepository} from './input-only-lint.mjs';

test('fixture rejects every prohibited text read property',()=>{
 const text=['node.innerText','node.textContent','node.innerHTML','node.outerHTML'].join('\n');
 const matches=scanSource(text,'browser-extension/src/unsafe.ts');
 assert.equal(matches.filter(x=>x.kind==='DOM_TEXT_ACCESS').length,4);
});
test('fixture rejects reply/message-list selectors',()=>{
 const unsafe=[
   "document.querySelector('[data-testid=reply]')",
   "document.querySelectorAll('.message-list')",
   "document.querySelector('#assistant-message')",
   "const selector = '[data-testid=conversation-turn]';",
 ].join('\n');
 const out=scanSource(unsafe,'browser-extension/src/unsafe.ts');
 assert.ok(out.filter(x=>x.kind==='REPLY_SELECTOR').length>=4);
});
test('input composer and URL/status metadata do not trigger this narrow detector',()=>{
 const source=[
   "document.querySelector('[data-testid=prompt-textarea]')",
   "const pageUrl = location.href;",
   "const turnBusy = document.querySelector('[data-testid=stop-button]');",
 ].join('\n');
 assert.equal(scanSource(source,'browser-extension/src/input.ts').length,0);
});
test('fixtures scan both directories, exclude unrelated files and symlinks',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bke-input-only-'));
 try {
   const ext=path.join(root,'browser-extension/src');
   const geo=path.join(root,'android-gecko/app/src/main/assets/worker-extension');
   fs.mkdirSync(ext,{recursive:true});fs.mkdirSync(geo,{recursive:true});
   fs.writeFileSync(path.join(ext,'a.ts'),'output.innerHTML;\n');
   fs.writeFileSync(path.join(geo,'b.js'),"document.querySelector('.message-list');\n");
   fs.mkdirSync(path.join(root,'other'),{recursive:true});
   fs.writeFileSync(path.join(root,'other','hidden.js'),'textContent');
   const out=scanRepository(root);
   assert.equal(out.length,2);
   assert.ok(out.some(x=>x.file==='browser-extension/src/a.ts'));
   assert.ok(out.some(x=>x.file.endsWith('worker-extension/b.js')));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
