// „Klausk savo delnų“ pavyzdiniai klausimai: asmeninei analizei („tu“) ir porai („mes“).
// Kiekvieną kartą rodomi dar neužduoti; kitam pirkimui (round) — kiti iš sąrašo.
window.KL_EX = {
  asm: [
    'Ar man verta keisti darbą?',
    'Kodėl kartojasi tos pačios santykių problemos?',
    'Kaip man geriau tvarkytis su pinigais?',
    'Kas man trukdo judėti pirmyn?',
    'Kokioje srityje labiausiai atsiskleidžia mano stiprybės?',
    'Kaip man priimti sprendimus su mažiau abejonių?',
    'Ar man tinka dirbti sau?',
    'Kaip man rasti pusiausvyrą tarp darbo ir poilsio?',
    'Kaip man užmegzti artimesnius santykius su žmonėmis?',
    'Kaip man išmokti pasakyti „ne“?',
    'Kur man ieškoti naujų galimybių?',
    'Ko man vertėtų mokytis toliau?',
    'Kaip man geriau pasinaudoti artėjančiais pokyčiais?',
    'Kas man padėtų jaustis ramiau kasdienybėje?'
  ],
  pora: [
    'Kaip mums rečiau ginčytis?',
    'Kaip suderinti požiūrį į pinigus?',
    'Kaip išlaikyti artumą kasdienybėje?',
    'Ar mums laikas gyventi kartu?',
    'Kaip mums kartu priimti svarbius sprendimus?',
    'Kaip mums geriau suprasti, ko reikia kiekvienam iš mūsų?',
    'Kaip pasidalyti namų darbus be įtampos?',
    'Kaip mums kalbėtis apie ateities planus?',
    'Kaip mums rasti daugiau laiko dviese?',
    'Kaip mums suderinti skirtingą gyvenimo tempą?',
    'Kaip mums tapti didesne atrama sunkiu metu?',
    'Kaip spręsti nesutarimus dėl artimųjų?',
    'Kur mūsų poros stiprybė ir kaip ją auginti?',
    'Kaip neprarasti romantikos ilgainiui?'
  ]
};
// n dar neužduotų pavyzdžių; round — kelintas pirkimas (0 — pirmas), kad kitą kartą būtų rodomi kiti
window.klExPick = function (kind, asked, round, n) {
  const norm = t => String(t || '').trim().toLowerCase();
  const done = new Set((asked || []).map(norm));
  const pool = (window.KL_EX[kind === 'pora' ? 'pora' : 'asm']).filter(t => !done.has(norm(t)));
  if (!pool.length) return [];
  const start = ((round || 0) * n) % pool.length, out = [];
  for (let i = 0; i < Math.min(n, pool.length); i++) out.push(pool[(start + i) % pool.length]);
  return out;
};
