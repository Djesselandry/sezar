(function () {
  "use strict";

  // =========================
  // 1) Constantes
  // =========================
  var INTERVALLE_RAFRAICHISSEMENT_MS = 2000;
  var SEUIL_PC_HORS_LIGNE_S = 20;
  var DELAI_LIVE_MS = 400;
  var MAX_ALERTES = 20;
  var CLE_LOCALE_STOCKAGE = "sezar_cle_locale";

  // =========================
  // 2) Choix du mode (cloud ou local)
  // =========================
  function detecterMode() {
    var cfg = window.SEZAR;
    if (!cfg) return "local";
    var url = String(cfg.URL || "");
    if (url.indexOf("VOTRE") !== -1 || url.trim() === "") return "local";
    if (!cfg.ANON || String(cfg.ANON).indexOf("VOTRE") !== -1) return "local";
    return "cloud";
  }

  // =========================
  // 3) Sources de données : sourceCloud et sourceLocale
  // =========================
  function creerSourceCloud() {
    var client = null;
    var timerId = null;

    function getClient() {
      if (client) return client;
      if (!window.supabase || !window.SEZAR) return null;
      client = window.supabase.createClient(window.SEZAR.URL, window.SEZAR.ANON);
      return client;
    }

    function traduireErreurConnexion(message) {
      var m = String(message || "").toLowerCase();
      if (m.indexOf("invalid login credentials") !== -1) {
        return "E-mail ou mot de passe incorrect.";
      }
      if (m.indexOf("email not confirmed") !== -1) {
        return "Adresse e-mail non confirmée.";
      }
      return "Connexion impossible. Vérifiez vos identifiants.";
    }

    return {
      mode: "cloud",
      async session() {
        var sb = getClient();
        if (!sb) return null;
        var res = await sb.auth.getSession();
        return res && res.data ? res.data.session : null;
      },
      async seConnecter(email, motDePasse) {
        var sb = getClient();
        if (!sb) throw new Error("Configuration manquante.");
        var res = await sb.auth.signInWithPassword({ email: email, password: motDePasse });
        if (res.error) throw new Error(traduireErreurConnexion(res.error.message));
        return res.data.session;
      },
      async seDeconnecter() {
        var sb = getClient();
        if (!sb) return;
        await sb.auth.signOut();
      },
      async lireStatut() {
        var sb = getClient();
        if (!sb) {
          return { erreur: "config", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
        }
        try {
          var r = await Promise.all([
            sb.from("etat").select("*").eq("id", 1).maybeSingle(),
            sb.from("alertes").select("id").limit(MAX_ALERTES)
          ]);
          var e = r[0].data;
          var err = r[0].error;
          if (err) return { erreur: "cloud", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
          if (!e || !e.maj) return { erreur: "attente", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };

          var ageS = (Date.now() - new Date(e.maj).getTime()) / 1000;
          var pcOk = ageS < SEUIL_PC_HORS_LIGNE_S;
          return {
            erreur: null,
            pcEnLigne: pcOk,
            espEnLigne: pcOk && !!e.esp_ok,
            cameraEnLigne: pcOk && !!e.camera_ok,
            armee: !!e.armee,
            alerte: !!e.alerte,
            source: e.source || "",
            nbAlertes: typeof e.nb_alertes === "number" ? e.nb_alertes : null,
            ip: e.ip || "",
            derniereSynchro: new Date(e.maj)
          };
        } catch (ex) {
          return { erreur: "cloud", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
        }
      },
      async lireJournal() {
        var sb = getClient();
        if (!sb) return [];
        try {
          var res = await sb.from("alertes").select("*").order("heure", { ascending: false }).limit(MAX_ALERTES);
          var rows = res.data || [];
          return rows.map(function (x) {
            return { date: x.heure ? new Date(x.heure) : null, urlPhoto: x.photo_url || "" };
          }).filter(function (x) { return x.urlPhoto; });
        } catch (ex) {
          return [];
        }
      },
      async envoyer(action) {
        var sb = getClient();
        if (!sb) throw new Error("Configuration manquante.");
        var res = await sb.from("commandes").insert({ action: action });
        if (res.error) throw new Error("Envoi impossible.");
      },
      demarrerBoucle(fn) {
        if (timerId) clearInterval(timerId);
        timerId = setInterval(fn, INTERVALLE_RAFRAICHISSEMENT_MS);
      },
      arreterBoucle() {
        if (timerId) { clearInterval(timerId); timerId = null; }
      }
    };
  }

  function creerSourceLocale() {
    var timerId = null;
    var liveTimerId = null;
    var liveEnCours = false;
    var cle = "";

    function lireCleStockee() {
      try {
        return localStorage.getItem(CLE_LOCALE_STOCKAGE) || "";
      } catch (e) {
        return "";
      }
    }

    function enregistrerCle(valeur) {
      cle = valeur || "";
      try {
        if (cle) localStorage.setItem(CLE_LOCALE_STOCKAGE, cle);
        else localStorage.removeItem(CLE_LOCALE_STOCKAGE);
      } catch (e) { /* ignore */ }
    }

    function urlAvecCle(base) {
      var sep = base.indexOf("?") >= 0 ? "&" : "?";
      return base + sep + "key=" + encodeURIComponent(cle);
    }

    async function requeteJson(url, options) {
      var opt = options || {};
      var res = await fetch(url, opt);
      if (res.status === 401) {
        var err = new Error("non autorise");
        err.code = 401;
        throw err;
      }
      if (!res.ok) throw new Error("requete echouee");
      return res.json();
    }

    return {
      mode: "local",
      async session() {
        cle = lireCleStockee();
        return cle ? { cle: cle } : null;
      },
      async seConnecter(cleSaisie) {
        var testCle = String(cleSaisie || "").trim();
        if (!testCle) throw new Error("Clé manquante.");
        var url = urlAvecCleLocal(testCle);
        var res = await fetch(url + "&_=" + Date.now(), { method: "GET", cache: "no-store" });
        if (res.status === 401) {
          throw new Error("Clé d'accès refusée.");
        }
        if (!res.ok) throw new Error("Serveur local injoignable.");
        enregistrerCle(testCle);
        cle = testCle;
        return { cle: cle };
      },
      async seDeconnecter() {
        enregistrerCle("");
      },
      async lireStatut() {
        if (!cle) return { erreur: "cle", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
        try {
          var data = await requeteJson(urlAvecCle("/api/etat"));
          var esp = data.esp;
          var cam = data.camera || {};
          if (!esp) {
            return {
              erreur: null,
              pcEnLigne: true,
              espEnLigne: false,
              cameraEnLigne: !!cam.ok,
              armee: false,
              alerte: false,
              source: "",
              nbAlertes: null,
              ip: "",
              derniereSynchro: new Date()
            };
          }
          return {
            erreur: null,
            pcEnLigne: true,
            espEnLigne: true,
            cameraEnLigne: !!cam.ok,
            armee: !!esp.armee,
            alerte: !!esp.alerte,
            source: esp.source || "",
            nbAlertes: typeof esp.nb_alertes === "number" ? esp.nb_alertes : null,
            ip: esp.ip || "",
            derniereSynchro: new Date()
          };
        } catch (e) {
          if (e && e.code === 401) return { erreur: "cle", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
          return { erreur: "local", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
        }
      },
      async lireJournal() {
        if (!cle) return [];
        try {
          var data = await requeteJson(urlAvecCle("/api/etat"));
          var journal = (data && data.journal) || [];
          return journal.map(function (x) {
            return { date: x.heure ? new Date(x.heure) : null, urlPhoto: x.photo ? ("/photos/" + encodeURIComponent(x.photo) + "?key=" + encodeURIComponent(cle)) : "" };
          }).filter(function (x) { return x.urlPhoto; });
        } catch (e) {
          return [];
        }
      },
      async envoyer(action) {
        if (!cle) throw new Error("Clé manquante.");
        var res = await fetch(urlAvecCle("/api/action/" + encodeURIComponent(action)), { method: "POST" });
        if (res.status === 401) {
          var err401 = new Error("non autorise");
          err401.code = 401;
          throw err401;
        }
        if (!res.ok) throw new Error("Action impossible.");
      },
      demarrerBoucle(fn) {
        if (timerId) clearInterval(timerId);
        timerId = setInterval(fn, INTERVALLE_RAFRAICHISSEMENT_MS);
      },
      arreterBoucle() {
        if (timerId) { clearInterval(timerId); timerId = null; }
      },
      demarrerLive() {
        function charger() {
          if (!cle || liveEnCours) { planifier(); return; }
          liveEnCours = true;
          var img = document.getElementById("liveImg");
          if (!img) { liveEnCours = false; return; }
          var u = "/api/live?key=" + encodeURIComponent(cle) + "&_=" + Date.now();
          img.onload = function () { liveEnCours = false; planifier(); };
          img.onerror = function () { liveEnCours = false; planifier(); };
          img.src = u;
        }
        function planifier() {
          if (liveTimerId) clearTimeout(liveTimerId);
          liveTimerId = setTimeout(charger, DELAI_LIVE_MS);
        }
        charger();
      },
      arreterLive() {
        if (liveTimerId) { clearTimeout(liveTimerId); liveTimerId = null; }
        liveEnCours = false;
      }
    };

    function urlAvecCleLocal(cleTest) {
      return "/api/etat?key=" + encodeURIComponent(cleTest);
    }
  }

  // =========================
  // 4) Logique métier (fonction pure)
  // =========================
  function calculerStatut(statut) {
    if (!statut) return { type: "off", titre: "Chargement", details: "" };
    if (statut.erreur === "config") {
      return { type: "off", titre: "Configuration manquante", details: "Vérifiez le fichier de configuration." };
    }
    if (statut.erreur === "cle") {
      return { type: "off", titre: "Accès refusé", details: "Clé d'accès requise ou incorrecte." };
    }
    if (statut.erreur === "cloud") {
      return { type: "off", titre: "Service injoignable", details: "Vérifiez votre connexion Internet." };
    }
    if (statut.erreur === "local") {
      return { type: "off", titre: "Serveur local injoignable", details: "Vérifiez que le serveur est démarré." };
    }
    if (statut.erreur === "attente") {
      return { type: "off", titre: "En attente du PC", details: "Lancez le serveur SEZAR sur le PC." };
    }
    if (!statut.pcEnLigne) {
      return { type: "off", titre: "PC hors ligne", details: "Le serveur ne répond plus." };
    }
    if (!statut.espEnLigne) {
      return { type: "off", titre: "ESP32 hors ligne", details: "Vérifiez l'alimentation et le réseau." };
    }
    if (statut.alerte) {
      var src = statut.source ? ("Source : " + statut.source) : "Intrusion détectée";
      return { type: "bad", titre: "Intrusion", details: src };
    }
    if (statut.armee) {
      return { type: "ok", titre: "Système armé", details: "Surveillance active." };
    }
    return { type: "warn", titre: "Système désarmé", details: "Les mouvements sont ignorés." };
  }

  // =========================
  // 5) Affichage
  // =========================
  var iconesSvg = {
    ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
    bad: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 9v5"/><path d="M12 17h.01"/></svg>',
    off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10 10 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><path d="M3 3l18 18"/></svg>'
  };

  function echapperTexte(texte) {
    var d = document.createElement("div");
    d.textContent = texte == null ? "" : String(texte);
    return d.innerHTML;
  }

  function afficherStatut(statut) {
    var vue = calculerStatut(statut);
    var card = document.getElementById("etatCard");
    var ic = document.getElementById("etatIcon");
    var t = document.getElementById("etatTitre");
    var d = document.getElementById("etatDetails");
    if (!card || !ic || !t || !d) return;
    card.setAttribute("data-type", vue.type);
    ic.innerHTML = iconesSvg[vue.type] || iconesSvg.off;
    t.textContent = vue.titre;
    d.textContent = vue.details || "";
  }

  function afficherPills(statut) {
    var dotPc = document.getElementById("dotPc");
    var dotEsp = document.getElementById("dotEsp");
    var dotCam = document.getElementById("dotCam");
    if (!dotPc || !dotEsp || !dotCam) return;
    var okPc = statut && statut.pcEnLigne;
    var okEsp = statut && statut.espEnLigne;
    var okCam = statut && statut.cameraEnLigne;
    dotPc.className = "dot" + (okPc ? " on" : "");
    dotEsp.className = "dot" + (okEsp ? " on" : "");
    dotCam.className = "dot" + (okCam ? " on" : "");
  }

  function afficherBoutons(statut, modeActif) {
    var btnArm = document.getElementById("btnArm");
    var btnDesarm = document.getElementById("btnDesarm");
    var btnSirene = document.getElementById("btnSirene");
    var btnTest = document.getElementById("btnTest");
    if (!btnArm || !btnDesarm || !btnSirene || !btnTest) return;

    var enLigne = statut && statut.pcEnLigne && statut.espEnLigne;
    btnSirene.disabled = !(enLigne && statut.alerte);
    btnArm.disabled = !enLigne || !!statut.armee;
    btnDesarm.disabled = !enLigne || !statut.armee;
    btnTest.disabled = !enLigne;
  }

  function formaterDateRelative(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return "Date inconnue";
    var maintenant = new Date();
    var debutAuj = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate());
    var debutJour = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
    var diffJours = Math.round((debutAuj - debutJour) / 86400000);
    var h = String(dateObj.getHours()).padStart(2, "0");
    var m = String(dateObj.getMinutes()).padStart(2, "0");
    var heure = h + ":" + m;
    if (diffJours === 0) return "Aujourd'hui " + heure;
    if (diffJours === 1) return "Hier " + heure;
    return dateObj.toLocaleDateString("fr-FR") + " " + heure;
  }

  function afficherJournal(items) {
    var cont = document.getElementById("journalListe");
    if (!cont) return;
    if (!items || items.length === 0) {
      cont.innerHTML = '<p class="empty">Aucune intrusion enregistrée.</p>';
      return;
    }
    var html = '<ul class="journal-list">';
    items.forEach(function (item) {
      var url = echapperTexte(item.urlPhoto || "");
      var dateTxt = formaterDateRelative(item.date);
      html += '<li class="journal-item">';
      html += '<img class="journal-thumb" src="' + url + '" alt="" loading="lazy" data-url="' + url + '">';
      html += '<div class="journal-text"><p class="journal-title">Intrusion détectée</p><p class="journal-date">' + echapperTexte(dateTxt) + '</p></div>';
      html += '</li>';
    });
    html += '</ul>';
    cont.innerHTML = html;

    var vignettes = cont.querySelectorAll(".journal-thumb");
    vignettes.forEach(function (img) {
      img.addEventListener("click", function () {
        ouvrirLightbox(img.getAttribute("data-url") || img.src);
      });
      img.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ouvrirLightbox(img.getAttribute("data-url") || img.src);
        }
      });
      img.setAttribute("tabindex", "0");
      img.setAttribute("role", "button");
    });
  }

  function afficherInfos(statut) {
    var infoPc = document.getElementById("infoPc");
    var infoEsp = document.getElementById("infoEsp");
    var infoCam = document.getElementById("infoCam");
    var infoMaj = document.getElementById("infoMaj");
    var infoNb = document.getElementById("infoNb");
    var infoIpRow = document.getElementById("infoIpRow");
    var infoIp = document.getElementById("infoIp");
    if (!infoPc) return;

    if (!statut || statut.erreur === "config" || statut.erreur === "cle") {
      infoPc.textContent = "—";
      infoEsp.textContent = "—";
      infoCam.textContent = "—";
      infoMaj.textContent = "—";
      infoNb.textContent = "—";
      if (infoIpRow) infoIpRow.hidden = true;
      return;
    }

    infoPc.textContent = statut.pcEnLigne ? "En ligne" : "Hors ligne";
    infoEsp.textContent = statut.espEnLigne ? "En ligne" : "Hors ligne";
    infoCam.textContent = statut.cameraEnLigne ? "En ligne" : "Hors ligne";

    if (statut.derniereSynchro instanceof Date && !isNaN(statut.derniereSynchro.getTime())) {
      var sec = Math.round((Date.now() - statut.derniereSynchro.getTime()) / 1000);
      if (sec < 5) infoMaj.textContent = "à l’instant";
      else if (sec < 60) infoMaj.textContent = "il y a " + sec + " s";
      else infoMaj.textContent = "il y a " + Math.round(sec / 60) + " min";
    } else {
      infoMaj.textContent = "—";
    }

    infoNb.textContent = (statut.nbAlertes === null || statut.nbAlertes === undefined) ? "—" : String(statut.nbAlertes);

    if (statut.ip) {
      if (infoIpRow && infoIp) {
        infoIpRow.hidden = false;
        infoIp.textContent = statut.ip;
      }
    } else if (infoIpRow) {
      infoIpRow.hidden = true;
    }
  }

  function afficherLiveVisible(visible) {
    var bloc = document.getElementById("blocLive");
    if (bloc) bloc.hidden = !visible;
  }

  // =========================
  // 6) Événements et démarrage
  // =========================
  var etatApp = {
    mode: null,
    source: null,
    statutCourant: null,
    envoiEnCours: false
  };

  function afficherToast(message) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  function ouvrirLightbox(url) {
    if (!url) return;
    var lb = document.getElementById("lightbox");
    var img = document.getElementById("lightboxImg");
    if (!lb || !img) return;
    img.src = url;
    lb.hidden = false;
  }

  function fermerLightbox() {
    var lb = document.getElementById("lightbox");
    var img = document.getElementById("lightboxImg");
    if (lb) lb.hidden = true;
    if (img) img.src = "";
  }

  async function bouclePrincipale() {
    if (!etatApp.source) return;
    var statut = await etatApp.source.lireStatut();
    etatApp.statutCourant = statut;

    if (statut.erreur === "cle" && etatApp.mode === "local") {
      etatApp.source.arreterBoucle();
      etatApp.source.arreterLive && etatApp.source.arreterLive();
      afficherLoginLocal(true);
      return;
    }

    afficherPills(statut);
    afficherStatut(statut);
    afficherBoutons(statut, etatApp.mode);
    afficherInfos(statut);

    var journal = await etatApp.source.lireJournal();
    afficherJournal(journal);
  }

  async function envoyerAction(action) {
    if (etatApp.envoiEnCours) return;
    etatApp.envoiEnCours = true;
    try {
      await etatApp.source.envoyer(action);
      afficherToast("Ordre envoyé.");
      setTimeout(function () { bouclePrincipale(); }, 1200);
    } catch (e) {
      if (e && e.code === 401 && etatApp.mode === "local") {
        afficherToast("Clé d'accès refusée.");
        afficherLoginLocal(true);
      } else {
        afficherToast("Envoi impossible.");
      }
    } finally {
      etatApp.envoiEnCours = false;
    }
  }

  function afficherLoginCloud() {
    var login = document.getElementById("login");
    var sub = document.getElementById("loginSub");
    var cloudFields = document.getElementById("loginCloudFields");
    var localFields = document.getElementById("loginLocalFields");
    var submit = document.getElementById("loginSubmit");
    if (sub) sub.textContent = "Connexion au compte";
    if (cloudFields) cloudFields.hidden = false;
    if (localFields) localFields.hidden = true;
    if (submit) submit.textContent = "Se connecter";
    if (login) login.hidden = false;
  }

  function afficherLoginLocal(forcer) {
    var login = document.getElementById("login");
    var sub = document.getElementById("loginSub");
    var cloudFields = document.getElementById("loginCloudFields");
    var localFields = document.getElementById("loginLocalFields");
    var submit = document.getElementById("loginSubmit");
    if (sub) sub.textContent = "Accès local";
    if (cloudFields) cloudFields.hidden = true;
    if (localFields) localFields.hidden = false;
    if (submit) submit.textContent = "Accéder";
    if (login) login.hidden = false;
  }

  function cacherLogin() {
    var login = document.getElementById("login");
    if (login) login.hidden = true;
  }

  async function demarrerApplication() {
    etatApp.mode = detecterMode();

    var headerSub = document.getElementById("headerSub");
    var zoneDeco = document.getElementById("zoneDeconnexion");

    if (etatApp.mode === "cloud") {
      if (headerSub) headerSub.textContent = "Surveillance depuis le cloud";
      if (zoneDeco) zoneDeco.hidden = false;
      afficherLiveVisible(false);
      etatApp.source = creerSourceCloud();

      var session = await etatApp.source.session();
      if (!session) {
        afficherLoginCloud();
        return;
      }
      cacherLogin();
      await bouclePrincipale();
      etatApp.source.demarrerBoucle(bouclePrincipale);
    } else {
      if (headerSub) headerSub.textContent = "Surveillance locale";
      if (zoneDeco) zoneDeco.hidden = true;
      afficherLiveVisible(true);
      etatApp.source = creerSourceLocale();

      var sLoc = await etatApp.source.session();
      if (!sLoc || !sLoc.cle) {
        afficherLoginLocal(true);
        return;
      }
      cacherLogin();
      etatApp.source.demarrerLive();
      await bouclePrincipale();
      etatApp.source.demarrerBoucle(bouclePrincipale);
    }
  }

  function brancherEvenements() {
    var form = document.getElementById("loginForm");
    if (form) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var errEl = document.getElementById("loginErreur");
        if (errEl) errEl.textContent = "";
        try {
          if (etatApp.mode === "cloud") {
            var email = document.getElementById("email").value;
            var mdp = document.getElementById("mdp").value;
            await etatApp.source.seConnecter(email, mdp);
          } else {
            var cle = document.getElementById("cle").value;
            await etatApp.source.seConnecter(cle);
          }
          cacherLogin();
          if (etatApp.mode === "local") {
            etatApp.source.demarrerLive();
          }
          await bouclePrincipale();
          if (etatApp.source.demarrerBoucle) etatApp.source.demarrerBoucle(bouclePrincipale);
        } catch (e) {
          if (errEl) errEl.textContent = e && e.message ? e.message : "Connexion impossible.";
        }
      });
    }

    var btnArm = document.getElementById("btnArm");
    var btnDesarm = document.getElementById("btnDesarm");
    var btnSirene = document.getElementById("btnSirene");
    var btnTest = document.getElementById("btnTest");
    if (btnArm) btnArm.addEventListener("click", function () { envoyerAction("arm"); });
    if (btnDesarm) btnDesarm.addEventListener("click", function () { envoyerAction("desarm"); });
    if (btnSirene) btnSirene.addEventListener("click", function () { envoyerAction("veille"); });
    if (btnTest) btnTest.addEventListener("click", function () { envoyerAction("alerte"); });

    var btnDeconnexion = document.getElementById("btnDeconnexion");
    if (btnDeconnexion) {
      btnDeconnexion.addEventListener("click", async function () {
        if (!etatApp.source) return;
        if (etatApp.source.arreterBoucle) etatApp.source.arreterBoucle();
        if (etatApp.source.arreterLive) etatApp.source.arreterLive();
        await etatApp.source.seDeconnecter();
        window.location.reload();
      });
    }

    var lbClose = document.getElementById("lightboxClose");
    if (lbClose) lbClose.addEventListener("click", fermerLightbox);
    var lb = document.getElementById("lightbox");
    if (lb) {
      lb.addEventListener("click", function (ev) {
        if (ev.target === lb) fermerLightbox();
      });
    }
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") fermerLightbox();
    });
  }

  brancherEvenements();
  demarrerApplication();
})();