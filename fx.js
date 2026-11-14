/* Sklandūs perėjimai tarp puslapių ir rodinių — kaip analizės ekranuose (index.html: fu / fuOut).
   Įeinant: puslapis ir kiekvienas atsiradęs rodinys (section) švelniai išryškėja.
   Išeinant per nuorodą tame pačiame lange: puslapis trumpai užtemsta, tada atidaromas kitas.
   Nuorodos, kurias apdoroja kiti skriptai (preventDefault, naujas langas), neliečiamos.
   <script src="/fx.js" data-noin></script> — be įėjimo animacijos (index.html: ekranai turi savo). */
(function(){
  try{
    if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var me=document.currentScript, noIn=!!(me&&me.hasAttribute('data-noin'));
    var css='@keyframes fxIn{from{opacity:0}to{opacity:1}}'+
      'html.fx-out body{opacity:0;transition:opacity .22s ease}';
    if(!noIn) css+='body{animation:fxIn .45s cubic-bezier(.25,.46,.45,.94) backwards}'+
      // Puslapio rodiniai (dovana, kodas, kuponas, „Mano analizės“). Tik ryškumas, be poslinkio — ekrano talpinimo skaičiavimai nepasikeičia
      '.wrap>section:not(.hidden){animation:fxIn .45s cubic-bezier(.25,.46,.45,.94) backwards}';
    var st=document.createElement('style'); st.textContent=css; (document.head||document.documentElement).appendChild(st);
    // Grįžus naršyklės „Atgal“ (puslapis iš atminties) — vėl matomas, švelniai
    window.addEventListener('pageshow',function(e){
      document.documentElement.classList.remove('fx-out');
      if(e.persisted&&!noIn&&document.body){ var b=document.body; b.style.animation='none'; void b.offsetWidth; b.style.animation=''; }
    });
    // Išeinant: tik paprastos šios svetainės nuorodos tame pačiame lange (vėliausiai — po visų kitų paspaudimo apdorojimų)
    window.addEventListener('click',function(e){
      if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey) return;
      var a=e.target&&e.target.closest&&e.target.closest('a[href]'); if(!a) return;
      if((a.target&&a.target!=='_self')||a.hasAttribute('download')||a.hasAttribute('data-nofx')) return;
      var u; try{ u=new URL(a.href,location.href); }catch(x){ return; }
      if(u.origin!==location.origin||!/^https?:$/.test(u.protocol)) return;
      if(u.pathname===location.pathname&&u.search===location.search) return; // tas pats puslapis (pvz. #žymė)
      e.preventDefault();
      document.documentElement.classList.add('fx-out');
      setTimeout(function(){ location.href=u.href; },200);
      // Jei naršyklė puslapio neatidarytų — neliktų tuščio ekrano
      setTimeout(function(){ document.documentElement.classList.remove('fx-out'); },2500);
    });
  }catch(e){}
})();
