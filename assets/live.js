// Gemeinsame Bausteine für die Live-Vorführung mit zwei Geräten (theke.html und karte.html).
// Handy und Laptop tauschen Nachrichten über einen öffentlichen Vermittler (ntfy.sh) aus.
// Es werden keine personenbezogenen Daten übertragen, nur Café-Name, Getränke, Preise und Uhrzeiten.
const CKL = (() => {
  const qs = new URLSearchParams(location.search);
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // Ein anderer Vermittler ist nur für lokale Tests erlaubt
  const RELAY = (isLocal && qs.get('relay')) || 'https://ntfy.sh';
  // Höchstens 40 Zeichen, weil jede Karte einen eigenen Kanal „<code>-<nr>“ bekommt (ntfy erlaubt 64)
  const TOPIC_RE = /^[A-Za-z0-9_-]{8,40}$/;

  /* ---------- Helfer ---------- */
  const eur = c => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  const clock = ts => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function dur(ms) { ms = Math.max(0, ms); const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${pad(m)} Min` : `${m} Min`; }
  function cd(ms) { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`; }
  const rid = (len = 10) => Array.from(crypto.getRandomValues(new Uint8Array(len)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  let toastT;
  function toast(t) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2800);
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* Speicher nicht verfügbar */ } }
  };

  /* ---------- Café-Einstellungen ---------- */
  const TAKTE = [15, 30, 40];
  const DEFAULT = {
    name: 'Dein Café', ort: '',
    drinks: [['Espresso', 280], ['Cappuccino', 380], ['Flat White', 420], ['Latte Macchiato', 420], ['Chai Latte', 450], ['Frischer Minztee', 380], ['Wasser 0,5 l', 300]],
    service: 'bringen', place: 'karte', tables: 12, pay: ['bar', 'karte'], takte: [15, 30, 40]
  };
  const PAY = {
    bar: { short: 'bar am Platz', title: 'Bar am Platz', sub: 'Die Bedienung kommt zu dir.', icon: 'cash' },
    karte: { short: 'Karte am Platz', title: 'Karte am Platz', sub: 'Die Bedienung bringt das Terminal.', icon: 'card' },
    kasse: { short: 'an der Kasse', title: 'An der Kasse', sub: 'Zeig diese Übersicht an der Kasse.', icon: 'kasse' }
  };
  function clean(c) {
    const d = { ...DEFAULT, ...(c || {}) };
    d.name = String(d.name || DEFAULT.name).slice(0, 60); d.ort = String(d.ort || '').slice(0, 60);
    d.drinks = (Array.isArray(d.drinks) ? d.drinks : DEFAULT.drinks).filter(x => Array.isArray(x) && String(x[0]).trim())
      .map(x => [String(x[0]).trim().slice(0, 40), Math.max(0, Math.round(+x[1]) || 0)]).slice(0, 20);
    if (!d.drinks.length) d.drinks = DEFAULT.drinks;
    d.service = d.service === 'abholen' ? 'abholen' : 'bringen'; d.place = d.place === 'tisch' ? 'tisch' : 'karte';
    d.tables = Math.min(60, Math.max(1, Math.round(+d.tables) || 12));
    d.pay = (Array.isArray(d.pay) ? d.pay : []).filter(p => PAY[p]); if (!d.pay.length) d.pay = ['bar', 'karte'];
    // Nur 15, 30 oder 40 Min. Ältere Einstellungen mit anderen Takten bekommen die neuen Standard-Takte.
    const tk = [...new Set((Array.isArray(d.takte) ? d.takte : []).map(Number))].sort((a, b) => a - b);
    d.takte = tk.length && tk.every(t => TAKTE.includes(t)) ? tk : DEFAULT.takte.slice();
    return d;
  }
  // Gleiches Format wie die Vorführ-Seite (?d=...), damit fertige Café-Links weiter funktionieren
  function encode(c) {
    const j = JSON.stringify({ n: c.name, o: c.ort, d: c.drinks, s: c.service, p: c.place, z: c.pay, t: c.takte });
    return btoa(unescape(encodeURIComponent(j))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(s) {
    const j = JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
    return clean({ name: j.n, ort: j.o, drinks: j.d, service: j.s, place: j.p, pay: j.z, takte: j.t });
  }

  /* ---------- Vermittler ---------- */
  // ntfy.sh kostenlos: höchstens 4 KB pro Nachricht (größere kommen als Datei an) und 250 Nachrichten pro Tag und Internetanschluss.
  // Deshalb bekommt jede Karte ihren eigenen kleinen Kanal, und gesendet wird nur, wenn sich etwas ändert.
  const MAX_BYTES = 3800;
  const bytes = obj => new TextEncoder().encode(JSON.stringify(obj)).length;
  const cardTopic = (topic, n) => `${topic}-${n}`;
  async function publish(topic, obj) {
    const res = await fetch(`${RELAY}/${topic}`, { method: 'POST', body: JSON.stringify(obj) });
    if (!res.ok) { const e = new Error('Senden fehlgeschlagen (' + res.status + ')'); e.status = res.status; throw e; }
  }
  const LIMIT_TEXT = 'Der kostenlose Vorführ-Server hat sein Tageslimit für diesen Internetanschluss erreicht.';

  /* ---------- „Bist du noch da?“ (gleiche Regel wie die echte App) ---------- */
  const REMIND_AFTER = 3 * 3600000;   // nach 3 Stunden ohne Aktion des Gasts
  const ANSWER_WITHIN = 15 * 60000;   // ohne Antwort danach keine weitere Runde
  const isHeld = (t, at) => !!t.remindAt && at >= t.remindAt + ANSWER_WITHIN;

  /* ---------- Vorausplanen: bis zu 5 Getränke mit Uhrzeit, unverbindlich ---------- */
  // t.plan = [{ i: Getränk, at: Zeitpunkt }], aufsteigend. Ist ein Plan da, kommt die nächste Runde zum Plan-Zeitpunkt.
  const PLAN_MAX = 5, LOCK_BEFORE = 10 * 60000, MIN_GAP = 5 * 60000, STEP = 5 * 60000;
  const nextItem = t => t.plan && t.plan.length ? t.plan[0].i : t.next;
  // Die nächste Runde ist 10 Min vorher fest (das Café bereitet sie vor); bei Pause nicht
  const canChange = (t, at) => isHeld(t, at) || t.nextAt - at > LOCK_BEFORE;
  function planValid(t, p, at, okItem) {
    if (!Array.isArray(p) || p.length > PLAN_MAX) return false;
    if (!p.every(x => x && okItem(x.i) && Number.isFinite(x.at))) return false;
    for (let k = 1; k < p.length; k++) if (p[k].at - p[k - 1].at < MIN_GAP) return false;
    if (!p.length) return true;
    if (p[p.length - 1].at - at > 6 * 3600000) return false;
    if (!canChange(t, at)) return p[0].i === nextItem(t) && p[0].at === t.nextAt;   // nächste Runde ist fest und bleibt
    return p[0].at - at >= LOCK_BEFORE - 60000;                                   // 1 Min Puffer für die Übertragung
  }

  /* ---------- Kompaktes Format für einen Ticker ---------- */
  const ST = ['offen', 'fertig', 'erledigt'];
  // Runde als [Nr, Name, Preis, Sekunden seit Start, Status, extra]
  function pack(t) {
    const { orders, older, ...rest } = t;
    return { ...rest, older: older || null, o: orders.map(o => [o.k, o.name, o.price, Math.round((o.at - t.start) / 1000), ST.indexOf(o.status), o.extra ? 1 : 0]) };
  }
  function unpack(p) {
    const { o, ...rest } = p;
    return { ...rest, orders: (o || []).map(([k, name, price, s, st, ex]) => ({ k, name, price, at: p.start + s * 1000, status: ST[st] || 'offen', extra: !!ex })) };
  }
  // Passt die Nachricht nicht in 4 KB, werden die ältesten Runden zu einer Zeile zusammengefasst
  function fit(msg) {
    const t = msg.t; if (!t) return msg;
    while (bytes(msg) > MAX_BYTES && t.o.length > 1) {
      const r = t.o.shift(); t.older = { c: (t.older ? t.older.c : 0) + 1, s: (t.older ? t.older.s : 0) + r[2] };
    }
    return msg;
  }
  // Abonniert das Thema; EventSource verbindet sich bei Abbrüchen selbst neu
  function subscribe(topic, { since, onMsg, onStatus }) {
    const es = new EventSource(`${RELAY}/${topic}/sse` + (since ? `?since=${encodeURIComponent(since)}` : ''));
    es.onopen = () => onStatus && onStatus(true);
    es.onerror = () => onStatus && onStatus(false);
    es.onmessage = e => {
      let d, m;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d.event !== 'message' || typeof d.message !== 'string') return;
      try { m = JSON.parse(d.message); } catch (_) { return; }
      if (m && typeof m === 'object') onMsg(m);
    };
    return es;
  }

  /* ---------- Darstellung ---------- */
  const ICON = {
    cup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3c-.6 1 .6 2 0 3M12 3c-.6 1 .6 2 0 3"/></svg>',
    nfc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 8.5a6 6 0 0 1 0 7M9.5 6a10 10 0 0 1 0 12M13 3.5a14 14 0 0 1 0 17"/></svg>',
    tray: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 17h18M5 17a7 7 0 0 1 14 0M12 8V6M10 6h4"/></svg>',
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/></svg>',
    cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
    kasse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16M6 20V11h12v9M8 11V6h8v5M10 15h4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };
  const total = t => t.orders.reduce((a, o) => a + o.price, t.older ? t.older.s : 0);
  const count = t => t.orders.length + (t.older ? t.older.c : 0);
  function bon(t, cfg, final) {
    const ab = cfg.service === 'abholen';
    const lbl = { offen: ab ? 'in Arbeit' : 'unterwegs', fertig: 'abholbereit', erledigt: ab ? 'abgeholt' : 'serviert' }, cls = { offen: 'st-open', fertig: 'st-ready', erledigt: 'st-done' };
    return `<div class="bon${final ? ' final' : ''}"><div class="bon-h"><span>Übersicht · ${esc(t.place)}</span><span class="mono">#${esc(t.no)}</span></div>
      ${t.older ? `<div class="bon-row"><time></time><span>${t.older.c} frühere ${t.older.c === 1 ? 'Runde' : 'Runden'}</span>${final ? '' : '<span class="st st-done">erledigt</span>'}<span class="p">${eur(t.older.s)}</span></div>` : ''}
      ${!t.orders.length && !t.older ? '<p class="note" style="padding:8px 0;border-top:1px dashed var(--line)">Noch nichts bestellt.</p>' : ''}
    ${t.orders.map(o => `<div class="bon-row"><time>${clock(o.at)}</time><span>${esc(o.name)}${o.extra ? '<em>extra</em>' : ''}</span>${final ? '' : `<span class="st ${cls[o.status]}">${lbl[o.status]}</span>`}<span class="p">${eur(o.price)}</span></div>`).join('')}
      <div class="bon-sum"><span>${final ? 'Summe' : 'Bisher'}</span><span class="mono">${eur(total(t))}</span></div></div>`;
  }
  let actx = null;
  function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (_) { /* kein Ton */ } }
  function beep() {
    if (!actx) return;
    try { const t0 = actx.currentTime; [0, .18].forEach((d, i) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = i ? 1046 : 784; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(.0001, t0 + d); g.gain.exponentialRampToValueAtTime(.35, t0 + d + .02); g.gain.exponentialRampToValueAtTime(.0001, t0 + d + .16); o.start(t0 + d); o.stop(t0 + d + .18); }); } catch (_) { /* kein Ton */ }
  }

  return { qs, RELAY, TOPIC_RE, eur, clock, pad, esc, dur, cd, rid, toast, store, DEFAULT, PAY, clean, encode, decode, publish, subscribe, REMIND_AFTER, ANSWER_WITHIN, isHeld, TAKTE, PLAN_MAX, LOCK_BEFORE, MIN_GAP, STEP, nextItem, canChange, planValid, cardTopic, pack, unpack, fit, bytes, LIMIT_TEXT, ICON, total, count, bon, unlockAudio, beep };
})();
