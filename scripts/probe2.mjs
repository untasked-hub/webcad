// Probe: aim CDP mouse at canvas rect coords, check measure HUD
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://localhost:8080';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
const pages = await browser.pages();
const page = pages[0] || (await browser.newPage());
await page.goto(BASE + '/', { waitUntil: 'networkidle2' });

// sign up a fresh user
const u = 'probe2_' + Date.now();
await page.evaluate(async (u) => {
  const r = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pass1234' }), credentials: 'include' });
  window.__signup = r.status;
}, u);

const info = await page.evaluate(() => {
  const c = document.querySelector('#canvas') || document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, tool: window.__tool };
});

console.log('canvas rect', JSON.stringify(info));

const ax = info.rect.x + 200, ay = info.rect.y + 150;
const bx = ax + 150, by = ay;

const cdp = await page.createCDPSession();
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ax, y: ay, button: 'left', clickCount: 1 });
for (let i = 1; i <= 5; i++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ax + (bx - ax) * i / 5, y: ay });
}
const mid = await page.evaluate(() => {
  const row = document.querySelector('#hud-measure');
  const hl = document.querySelector('#hl');
  return { display: row ? getComputedStyle(row).display : 'NO_ROW', hl: hl ? hl.textContent : 'NO_HL' };
});
console.log('mid', JSON.stringify(mid));
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 });
const end = await page.evaluate(() => {
  const row = document.querySelector('#hud-measure');
  const hl = document.querySelector('#hl');
  return { display: row ? getComputedStyle(row).display : 'NO_ROW', hl: hl ? hl.textContent : 'NO_HL' };
});
console.log('end', JSON.stringify(end));
await browser.disconnect();
