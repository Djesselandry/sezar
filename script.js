
const ICONS = {
  ok:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  warn:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  bad:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  off:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19v.01"/><path d="M3 3l18 18"/></svg>'
};
const $ = id => document.getElementById(id);
const toast = t => { const e=$('toast'); e.textContent=t; e.classList.add('show'); setTimeout(()=>e.classList.remove('show'),2200); };

if (!window.supabase || !window.SEZAR || window.SEZAR.URL.includes('VOTRE')) {
  $('login').hidden = false;
  $('lerr').textContent = "Configuration manquante : remplis config.js (URL et clé anon Supabase).";
}
const sb = (window.supabase && window.SEZAR) ? window.supabase.createClient(SEZAR.URL, SEZAR.ANON) : null;
let timer = null;

async function demarrer(){
  const { data } = await sb.auth.getSession();
  if (data.session){ $('login').hidden = true; maj(); timer = setInterval(maj, 2000); }
  else $('login').hidden = false;
}
async function connecter(e){
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $('email').value, password: $('mdp').value });
  if (error){ $('lerr').textContent = "Erreur : " + error.message; return false; }
  $('lerr').textContent = ''; demarrer(); return false;
}
async function sortir(){ await sb.auth.signOut(); clearInterval(timer); location.reload(); }

function afficher(cls, titre, sous){
  $('status').className = 'card status ' + cls;
  $('ico').innerHTML = ICONS[cls] || ICONS.off;
  $('titre').textContent = titre; $('sous').textContent = sous || '';
}

async function maj(){
  const [{ data: e, error: err }, { data: j }] = await Promise.all([
    sb.from('etat').select('*').eq('id', 1).maybeSingle(),
    sb.from('alertes').select('*').order('heure', { ascending: false }).limit(20)
  ]);
  if (err){ afficher('off', 'Cloud injoignable', 'Vérifie ta connexion Internet'); return; }
  if (!e || !e.maj){ afficher('off', 'En attente du PC', 'Lance le serveur SEZAR sur le PC'); return; }

  const age = (Date.now() - new Date(e.maj).getTime()) / 1000;
  const pcOk = age < 20;
  $('dPc').className = 'dot' + (pcOk ? ' on' : '');
  $('dEsp').className = 'dot' + (pcOk && e.esp_ok ? ' on' : '');
  $('dCam').className = 'dot' + (pcOk && e.camera_ok ? ' on' : '');
  $('maj').textContent = pcOk ? 'il y a ' + Math.round(age) + ' s' : 'il y a ' + Math.round(age/60) + ' min';
  $('nb').textContent = e.nb_alertes ?? '–';

  if (!pcOk) afficher('off', 'PC hors ligne', 'Le serveur SEZAR ne répond plus');
  else if (!e.esp_ok) afficher('off', 'ESP32 hors ligne', 'Vérifie son alimentation et le Wi-Fi');
  else if (e.alerte) afficher('bad', 'INTRUSION', 'Source : ' + e.source);
  else if (e.armee) afficher('ok', 'Système armé', 'Surveillance active');
  else afficher('warn', 'Système désarmé', 'Les mouvements sont ignorés');

  const live = pcOk && e.esp_ok;
  $('bStop').disabled = !(live && e.alerte);
  $('bArm').disabled = !live || e.armee;
  $('bDesarm').disabled = !live || !e.armee;
  $('bTest').disabled = !live;

  $('journal').innerHTML = (j && j.length)
    ? j.map(x => `<div class="row"><img src="${x.photo_url}" loading="lazy" onclick="agrandir('${x.photo_url}')" alt="">
        <div><b>Intrusion détectée</b><span>${new Date(x.heure).toLocaleString('fr-FR')}</span></div></div>`).join('')
    : '<div class="empty">Aucune intrusion enregistrée</div>';
}
function agrandir(u){ $('lbimg').src = u; $('lb').style.display = 'grid'; }

async function agir(action){
  const { error } = await sb.from('commandes').insert({ action });
  if (error){ toast('Envoi impossible'); return; }
  toast('Ordre envoyé…');
  setTimeout(maj, 3000);
}

if (sb) demarrer();
