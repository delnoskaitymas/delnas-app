// Iš kur atėjo lankytojas (UTM žymos reklamos nuorodoje) — be slapukų:
// šaltinis laikomas tik šioje naršyklėje 30 d., serveris skaičiuoja tik bendrus skaičius.
(function () {
  function clean(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9ąčęėįšųūž_\-]/g, '').slice(0, 30); }
  function send(o) {
    try {
      const b = JSON.stringify(o);
      if (navigator.sendBeacon) navigator.sendBeacon('/ev', new Blob([b], { type: 'application/json' }));
      else fetch('/ev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b, keepalive: true });
    } catch (e) {}
  }
  try {
    const q = new URLSearchParams(location.search), so = clean(q.get('utm_source')), ca = clean(q.get('utm_campaign'));
    if (so || ca) {
      const s = (so || 'kita') + (ca ? ' / ' + ca : '');
      // Vidinės nuorodos (pvz. šventinė eilutė, rezultato ekranas) skaičiuojamos, bet neperrašo reklamos šaltinio
      if (so !== 'app') localStorage.setItem('delnasSrc', JSON.stringify({ s, at: Date.now() }));
      if (!sessionStorage.getItem('delnasSrcV:' + s)) { sessionStorage.setItem('delnasSrcV:' + s, '1'); send({ e: 'src_visit', s }); }
    }
  } catch (e) {}
  // Pirkimas priskiriamas paskutiniam reklamos šaltiniui (jei buvo per 30 d.); vienas kartas vienam užsakymui
  window.delnasSrcBuy = function (kind, key) {
    // Draugo nuolaida vienkartinė: jei šis pirkimas buvo su draugo kodu (siųstas mokant per pastarąsias 6 val.) — kodas šiame telefone pamirštamas
    try {
      const sent = JSON.parse(localStorage.getItem('delnasRefSent') || 'null'), r = JSON.parse(localStorage.getItem('delnasRef') || 'null');
      if (sent && Date.now() - sent.at < 6 * 3600e3) { if (r && r.c === sent.c) localStorage.removeItem('delnasRef'); localStorage.removeItem('delnasRefSent'); }
    } catch (e) {}
    try {
      const d = JSON.parse(localStorage.getItem('delnasSrc') || 'null');
      if (!d || Date.now() - d.at > 30 * 864e5) return;
      const k = 'delnasSrcB:' + kind + ':' + (key || '');
      if (localStorage.getItem(k)) return;
      localStorage.setItem(k, '1');
      send({ e: 'src_buy', s: d.s, k: kind });
    } catch (e) {}
  };
})();
