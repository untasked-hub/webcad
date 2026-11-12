import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: 'new' });
const pg = await b.newPage();
await pg.goto('http://127.0.0.1:8080', { waitUntil: 'networkidle0' });
const ev = (js) => pg.evaluate(js).catch(e => 'ERR:' + e.message);

// create a line via command bar, then select it, then run MOVE
const out = await ev(`(async () => {
  const s = window.__ak.state;
  const input = document.getElementById('cmdInput') || document.querySelector('#cmdbar input, input.cmd');
  const setVal = (v) => { input.value = v; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
  const prompt = () => document.querySelector('.prompt, #prompt') ? document.querySelector('.prompt, #prompt').textContent : '(no prompt el)';
  const hist = () => (window.__ak.state ? Array.from(document.querySelectorAll('.cmdlog li, .cmdlog div')).map(e => e.textContent) : []);
  setVal('line 100,100 @100,0');
  await new Promise(r => setTimeout(r, 100));
  const ents = s.doc.entities.map(e => ({ id: e.id, type: e.type, p1: e.p1, layer: e.layer }));
  const last = ents[ents.length - 1];
  s.sel = new Set([last.id]);
  setVal('move @10,20');
  await new Promise(r => setTimeout(r, 100));
  return JSON.stringify({
    inputFound: !!input, inputId: input.id, inputClass: input.className,
    entsAfterCreate: ents, selSize: s.sel.size, tool: s.tool,
    promptAfterMove: prompt(),
    logAfterMove: hist(),
    lineAfter: s.doc.entities.filter(e => e.type === 'line').map(e => e.p1)
  });
})()`);
console.log(out);
await b.close();
