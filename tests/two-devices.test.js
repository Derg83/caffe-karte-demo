// Spielt die Vorführung mit zwei Geräten durch: Laptop mit Theke, Handy des Inhabers mit der Karte.
// Start: npm test   (einmalig vorher: npm install && npx playwright install chromium)
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { start } = require('./server');

const TOMO = 'eyJuIjoiVG9tbyBDYWbDqCIsIm8iOiJEw7xzc2VsZG9yZiIsImQiOltbIkNhcHB1Y2Npbm8iLDQ2MF0sWyJGbGF0IFdoaXRlIiw0MzBdXSwicyI6ImJyaW5nZW4iLCJwIjoia2FydGUiLCJ6IjpbImJhciIsImthcnRlIl0sInQiOlszMCw2MF19';

test('Vorführung mit Laptop und zwei Handys', async t => {
  const srv = await start();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); srv.stop(); });
  const relay = encodeURIComponent(srv.url + '/relay');
  const errors = [];
  const open = async (opts, name, url) => {
    const p = await (await browser.newContext(opts)).newPage();
    p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    // Der absichtlich gekappte Live-Kanal meldet sich als abgebrochene Übertragung, das ist hier gewollt
    p.on('console', m => { if (m.type() === 'error' && !/ERR_INCOMPLETE_CHUNKED_ENCODING/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
    await p.goto(url);
    return p;
  };
  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

  const laptop = await open({ viewport: { width: 1280, height: 860 } }, 'Laptop', `${srv.url}/theke.html?k=test-topic-123&relay=${relay}&d=${TOMO}`);
  await laptop.getByText('Verbunden').waitFor();
  assert.strictEqual(await laptop.locator('#cafeTitle').textContent(), 'Tomo Cafè');

  let card1;
  await t.test('Karten-Ansicht zeigt feste Links mit QR-Code', async () => {
    await laptop.click('[data-act=cards]');
    const codes = await laptop.locator('.qcard code').allTextContents();
    assert.strictEqual(codes.length, 2);
    assert.match(codes[0], /karte\.html\?k=test-topic-123&n=1/);
    assert.strictEqual(await laptop.locator('.qcard svg').count(), 2);
    card1 = codes[0];
    await laptop.click('.sheet [data-act=close] >> nth=-1');
  });

  const phone = await open(PHONE, 'Handy 1', card1);
  const shot = (p, name) => p.screenshot({ path: `${__dirname}/screens/${name}.png`, fullPage: true });
  await t.test('Handy zeigt das Café vom Laptop und startet', async () => {
    await phone.getByText('Tomo Cafè').first().waitFor();
    await phone.click('[data-act=takt][data-v="30"]');
    await phone.click('[data-act=first][data-v="1"]');
    await phone.click('[data-act=start]');
    await phone.locator('.pill.live').waitFor();
    await laptop.getByText('Zu bringen (1)').waitFor();
    assert.ok(await laptop.getByText('Flat White').first().isVisible());
    await shot(phone, 'handy-live');
  });

  await t.test('Laptop bringt, spult vor, Handy bekommt die Runden', async () => {
    await laptop.click('[data-act=served]');
    await phone.getByText('serviert').waitFor();
    await laptop.click('[data-act=ff][data-v="60"]');
    await phone.waitForFunction(() => document.querySelectorAll('.bon-row').length >= 3);
  });

  const phone2 = await open(PHONE, 'Handy 2', card1.replace('n=1', 'n=2'));
  await t.test('Zweite Karte läuft parallel', async () => {
    await phone2.locator('[data-act=start]').waitFor();
    await phone2.click('[data-act=start]');
    await phone2.locator('.pill.live').waitFor();
    await laptop.getByText('Laptop-Ticker (2 aktiv)').waitFor();
  });

  await t.test('Handy neu laden behält den Ticker', async () => {
    await phone.reload();
    await phone.locator('.pill.live').waitFor();
  });

  await t.test('Stoppen, zahlen, kassieren', async () => {
    await phone.click('#app [data-act=sheet][data-v=confirm]');
    await phone.click('.sheet [data-act=stop]');
    await phone.click('[data-act=pay][data-v=karte]');
    await laptop.getByText('Will zahlen (1)').waitFor();
    const btn = laptop.locator('[data-act=collected]').first();
    await btn.click(); await btn.click();
    await phone.getByText('Bezahlt. Danke!').waitFor();
  });

  await t.test('Bestellung kommt an, auch wenn die Verbindung kurz weg war', async () => {
    srv.dropAll();                                  // alle Live-Verbindungen kappen
    await phone2.click('#app [data-act=sheet][data-v=extra]');
    await phone2.click('.sheet [data-act=extra][data-v="0"]');
    await phone2.getByText('extra').waitFor({ timeout: 15000 });
  });

  await t.test('Neue Vorführung setzt alle Handys zurück', async () => {
    const btn = laptop.locator('[data-act=reset]');
    await btn.click(); await btn.click();
    await phone2.locator('[data-act=start]').waitFor();
    await phone.locator('[data-act=start]').waitFor();
  });

  await t.test('Ohne Theke sieht der Gast einen Hinweis', async () => {
    const lonely = await open(PHONE, 'Handy ohne Theke', `${srv.url}/karte.html?k=keine-theke-hier&n=1&relay=${relay}`);
    await lonely.getByText('Die Theke antwortet noch nicht.').waitFor({ timeout: 10000 });
    const bad = await open(PHONE, 'Kaputte Karte', `${srv.url}/karte.html?k=x&n=1`);
    await bad.getByText('Diese Karte ist nicht gültig').waitFor();
  });

  await laptop.screenshot({ path: __dirname + '/screens/laptop.png', fullPage: true });
  assert.deepStrictEqual(errors, [], 'Fehler in der Browser-Konsole');
});
