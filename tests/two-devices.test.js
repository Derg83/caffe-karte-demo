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
    // Gewollt: der absichtlich gekappte Live-Kanal und das ausgelöste Tageslimit (429)
    p.on('console', m => { if (m.type() === 'error' && !/ERR_INCOMPLETE_CHUNKED_ENCODING|status of 429/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
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
    // Erst nur die Frage, noch kein Start-Knopf
    await phone.getByText('Schon bestellt?').waitFor();
    assert.strictEqual(await phone.locator('[data-act=start]').count(), 0);
    await phone.click('[data-act=later][data-v="0"]');      // Nein: direkt hier bestellen
    await phone.getByText('Dann bestell direkt hier').waitFor();
    await phone.getByText('Flat White').first().waitFor();   // Getränke vom Laptop sind angekommen
    await phone.click('[data-act=takt][data-v="30"]');
    await phone.click('[data-act=first][data-v="1"]');
    assert.strictEqual(await phone.locator('[data-act=start]').textContent(), 'Flat White bestellen');
    await phone.click('[data-act=start]');
    await phone.locator('.pill.live').waitFor();
    await laptop.getByText('Zu bringen (1)').waitFor();
    assert.ok(await laptop.getByText('Flat White').first().isVisible());
    await shot(phone, 'handy-live');
  });

  await t.test('Verbindungstest zeigt Server und gemeldete Karte', async () => {
    await laptop.click('[data-act=check]');
    await laptop.getByText(/Verbunden\. Antwort in/).waitFor();
    await laptop.locator('.chk-row.ok', { hasText: 'Tisch 1' }).waitFor();
    assert.ok(await laptop.locator('.chk-row', { hasText: 'Tisch 2' }).getByText('Noch keine Meldung').isVisible());
    await laptop.click('.sheet button[data-act=close]');
    assert.strictEqual(await laptop.locator('.chk').count(), 0);
  });

  await t.test('Laptop bringt, spult vor, Handy bekommt die Runden', async () => {
    await laptop.click('[data-act=served]');
    await phone.getByText('serviert').waitFor();
    await laptop.click('[data-act=ff][data-v="60"]');
    await phone.waitForFunction(() => document.querySelectorAll('.bon-row').length >= 3);
  });

  const phone2 = await open(PHONE, 'Handy 2', card1.replace('n=1', 'n=2'));
  await t.test('Vorausplanen: Anzahl, Getränk, Zeit verschieben, folgende rücken mit', async () => {
    // Tisch 1 läuft im 30-Minuten-Takt mit Flat White, nächste Runde in 30 Min
    await phone.getByText('Als Nächstes', { exact: true }).waitFor();
    await phone.click('[data-act=planner]');
    await phone.getByText('Du weißt schon, was es als Nächstes wird?').first().waitFor();
    assert.strictEqual(await phone.locator('.prow').count(), 3);
    await phone.click('.sheet [data-act=pcount][data-v="4"]');
    assert.strictEqual(await phone.locator('.prow').count(), 4);
    const times = async () => phone.locator('.prow .ptime b').allTextContents();
    const before = await times();
    await phone.selectOption('select[data-pi="1"]', '0');
    await phone.click('[data-act=ptime][data-v="1:1"]');            // Runde 2 fünf Minuten später
    const after = await times();
    const min = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    assert.deepStrictEqual(after.map(min).map((m, k) => m - min(before[k])), [0, 5, 5, 5]);   // folgende rücken mit
    await phone.click('[data-act=ptime][data-v="0:-1"]');           // erste Runde 5 Min früher geht (noch 25 Min weg)
    await phone.click('[data-act=psave]');
    await phone.locator('.planbox').waitFor();
    assert.strictEqual(await phone.locator('.pline').count(), 4);
    await laptop.getByText(/vorgemerkt: .*Cappuccino/).waitFor();
    // Vorspulen: erste vorgemerkte Runde kommt, dann die geplante Cappuccino-Runde
    await laptop.click('[data-act=ff][data-v="15"]');
    await laptop.click('[data-act=ff][data-v="15"]');
    await phone.waitForFunction(() => document.querySelectorAll('.pline').length === 3);   // eine weniger
    await laptop.click('[data-act=ff][data-v="15"]');
    await laptop.click('[data-act=ff][data-v="15"]');
    await phone.waitForFunction(() => [...document.querySelectorAll('.bon-row span:nth-child(2)')].some(e => e.textContent.startsWith('Cappuccino')));
  });

  await t.test('Nächste Runde ist 10 Min vorher fest', async () => {
    // Nächste vorgemerkte Runde ist 30 Min entfernt: 20 Min vorspulen, dann sind es 10 Min
    assert.ok(await phone.locator('.card [data-act=sheet][data-v=menu]').isVisible());
    await laptop.click('[data-act=ff][data-v="15"]');
    await laptop.click('[data-act=ff][data-v="5"]');
    await phone.locator('.card .qfix').waitFor();
    await laptop.getByText('(fest)').first().waitFor();
  });

  await t.test('Zweite Karte läuft parallel', async () => {
    await phone2.locator('[data-act=later]').first().waitFor();
    await phone2.click('[data-act=later][data-v="0"]');
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

  await t.test('Nach 3 Stunden: „Bist du noch da?“, ohne Antwort Pause, „Ja, weiter“ setzt fort', async () => {
    // Handy 2 läuft seit Kurzem, letzte Aktion war der Start
    for (let i = 0; i < 3; i++) await laptop.click('[data-act=ff][data-v="60"]');
    await phone2.getByText('Bist du noch da?').waitFor();
    await laptop.getByText('Fragt gerade: „Bist du noch da?“').waitFor();
    await laptop.click('[data-act=ff][data-v="15"]');
    await phone2.locator('.pill', { hasText: 'Pausiert' }).waitFor();
    await laptop.getByText('Pausiert: Gast antwortet nicht').waitFor();
    const rows = await phone2.locator('.bon-row').count();
    await laptop.click('[data-act=ff][data-v="60"]');
    await laptop.waitForTimeout(1500);
    assert.strictEqual(await phone2.locator('.bon-row').count(), rows, 'während der Pause kam eine Runde');
    await phone2.click('[data-act=stillhere]');
    await phone2.locator('.pill.live').waitFor();
    await laptop.getByText('Pausiert: Gast antwortet nicht').waitFor({ state: 'detached' });
    assert.strictEqual(await phone2.getByText('Bist du noch da?').count(), 0);
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
    await phone2.getByText('Schon bestellt?').waitFor();
    await phone.getByText('Schon bestellt?').waitFor();
  });

  await t.test('„Ich hab noch was“: Start ohne Bestellung, erste Runde nach dem Takt', async () => {
    const p4 = await open(PHONE, 'Handy 4', card1.replace('n=1', 'n=4'));
    await p4.locator('[data-act=later]').first().waitFor();
    await p4.click('[data-act=later][data-v="1"]');          // Ja, schon bestellt
    await p4.getByText('Wann soll das nächste kommen?').waitFor();
    await p4.click('[data-act=takt][data-v="40"]');
    assert.strictEqual(await p4.locator('[data-act=start]').textContent(), 'Ticker starten · nächstes in 40 Min');
    // Schon vor dem Start vorausplanen: 2 Getränke, das zweite ein Flat White
    await p4.click('[data-act=planner]');
    await p4.click('.sheet [data-act=pcount][data-v="2"]');
    await p4.selectOption('select[data-pi="1"]', '1');                // Flat White
    await p4.click('[data-act=psave]');
    await p4.getByText('Vorgemerkt', { exact: true }).waitFor();
    assert.strictEqual(await p4.locator('.pline').count(), 2);
    await p4.click('[data-act=start]');
    await p4.locator('.pill.live').waitFor();
    assert.strictEqual(await p4.locator('.bon-row').count(), 0);
    await laptop.getByText('Tisch 4 startet, erste Runde in 40 Min').waitFor();
    await laptop.locator('.tcard', { hasText: 'Tisch' }).filter({ hasText: '4' }).first().waitFor();
    await laptop.click('[data-act=ff][data-v="60"]');
    await p4.waitForFunction(() => document.querySelectorAll('.bon-row').length === 1);
    await p4.locator('.pline').first().waitFor();   // noch 1 vorgemerkt (Flat White)
    await laptop.click('[data-act=ff][data-v="60"]');
    await p4.waitForFunction(() => [...document.querySelectorAll('.bon-row span:nth-child(2)')].some(e => e.textContent.startsWith('Flat White')));
    await p4.close();
  });

  await t.test('Lange Vorführung mit drei Karten bleibt unter 4 KB pro Nachricht', async () => {
    const phone3 = await open(PHONE, 'Handy 3', card1.replace('n=1', 'n=3'));
    for (const p of [phone, phone2, phone3]) {
      await p.locator('[data-act=later]').first().waitFor();
      await p.click('[data-act=later][data-v="0"]');
      await p.click('[data-act=takt][data-v="30"]');
      await p.click('[data-act=start]');
      await p.locator('.pill.live').waitFor();
    }
    // 12 Stunden im 30-Minuten-Takt, alle 3 Stunden bestätigen die Gäste „Ja, weiter“: Startgetränk plus 24 Runden
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 3; i++) await laptop.click('[data-act=ff][data-v="60"]');
      for (const p of [phone, phone2, phone3]) { await p.locator('[data-act=stillhere]').click(); await p.getByText('Bist du noch da?').waitFor({ state: 'detached' }); }
    }
    for (const p of [phone, phone2, phone3]) {
      await p.getByText('seit 12 h').first().waitFor();
      await p.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.bon-row')], older = rows[0] && rows[0].textContent.match(/(\d+) frühere/);
        return rows.length - (older ? 1 : 0) + (older ? +older[1] : 0) === 25;
      });
    }
    assert.strictEqual(srv.stats.tooBig, 0, 'Nachricht über 4 KB');
    assert.ok(srv.stats.maxBytes <= 3900, 'größte Nachricht ' + srv.stats.maxBytes);
  });

  await t.test('Sehr lange Ticker werden gekürzt, Summe bleibt gleich', async () => {
    const r = await laptop.evaluate(() => {
      const t = { no: '1', place: 'Karte 1', screen: 'live', takt: 30, next: 0, start: 0, orders: [] };
      for (let k = 1; k <= 300; k++) t.orders.push({ k, name: 'Frischer Minztee', price: 380, at: k * 1800000, status: 'erledigt', extra: false });
      const msg = CKL.fit({ type: 'state', cfg: {}, t: CKL.pack(t) });
      const back = CKL.unpack(msg.t);
      return { bytes: CKL.bytes(msg), total: CKL.total(back), count: CKL.count(back) };
    });
    assert.ok(r.bytes <= 3800, 'Bytes ' + r.bytes);
    assert.strictEqual(r.total, 300 * 380);
    assert.strictEqual(r.count, 300);
  });

  await t.test('Im Leerlauf wird nichts gesendet', async () => {
    const before = srv.stats.count;
    await laptop.waitForTimeout(4000);
    assert.strictEqual(srv.stats.count, before);
  });

  await t.test('Tageslimit des Vermittlers wird klar angezeigt', async () => {
    srv.setLimit(0);
    await laptop.click('[data-act=ff][data-v="15"]');
    await laptop.getByText('Tageslimit erreicht', { exact: true }).waitFor();
    await laptop.getByRole('alert').getByText('Handy-Hotspot').waitFor();
    srv.setLimit(Infinity);
    await laptop.click('[data-act=ff][data-v="15"]');
    await laptop.getByText('Verbunden').waitFor();
    assert.strictEqual(await laptop.getByRole('alert').count(), 0);
  });

  await t.test('„Was bringt’s?“ öffnet den Rechner mit den Preisen des Cafés', async () => {
    const [calc] = await Promise.all([laptop.context().waitForEvent('page'), laptop.click('header [data-act=calc]')]);
    await calc.waitForLoadState();
    assert.match(calc.url(), /index\.html\?d=.+&tab=rechner/);
    await calc.getByText('Das bringt der Ticker dem Tomo Cafè').waitFor();
    // Durchschnitt aus 4,60 € und 4,30 €
    assert.strictEqual(await calc.locator('#o-price').textContent(), '4,50\u00a0€');
    // Voreinstellung landet bei etwa 1.000 € Mehrumsatz, abgerundet
    assert.strictEqual((await calc.locator('#calcOut .big b').textContent()).replace(/\s/g, ' '), 'über 1.000 €');
    await calc.getByText('Schon 12 Getränke im Monat').waitFor();
    await calc.close();
  });

  await t.test('Ohne Theke sieht der Gast einen Hinweis', async () => {
    const lonely = await open(PHONE, 'Handy ohne Theke', `${srv.url}/karte.html?k=keine-theke-hier&n=1&relay=${relay}`);
    await lonely.getByText('Die Theke antwortet noch nicht.').waitFor({ timeout: 10000 });
    const bad = await open(PHONE, 'Kaputte Karte', `${srv.url}/karte.html?k=x&n=1`);
    await bad.getByText('Diese Karte ist nicht gültig').waitFor();
  });

  await laptop.screenshot({ path: __dirname + '/screens/laptop.png', fullPage: true });
  console.log('Nachrichten insgesamt:', srv.stats.count, '· größte:', srv.stats.maxBytes, 'Bytes');
  assert.deepStrictEqual(errors, [], 'Fehler in der Browser-Konsole');
});
