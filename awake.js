// Ekranas neužgęsta, kol puslapis atidarytas (pvz. laukiant analizės ar atsakymų į klausimus).
// Naudojamas Screen Wake Lock: užraktas atnaujinamas grįžus į langą, sistemai jį atleidus
// ir po pirmo palietimo (kai kurios naršyklės be jo neleidžia). Vartotojas ekraną gali užgesinti pats.
(function(){
  if(!('wakeLock' in navigator)) return;
  let lock=null, pending=false;
  async function keep(){
    if(lock||pending||document.visibilityState!=='visible') return;
    pending=true;
    try{ lock=await navigator.wakeLock.request('screen'); lock.addEventListener('release',()=>{ lock=null; }); }
    catch(e){ lock=null; }
    pending=false;
  }
  keep();
  document.addEventListener('visibilitychange',keep);
  ['pointerdown','touchstart','keydown'].forEach(ev=>document.addEventListener(ev,keep,{passive:true}));
  setInterval(keep,30000);
})();
