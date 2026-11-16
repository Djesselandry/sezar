/*
 * SEZAR - logique de l'application web.
 * Le fichier est découpé en blocs : constantes, choix du mode, sources de données
 * (cloud/local derrière une interface commune), logique métier, affichage, événements.
 * L'IIFE évite de polluer l'espace global et garde l'état regroupé dans `etatApp`.
 */
(function () {
  "use strict";

  // ============================================================
  // 1) Constantes
  // ============================================================

  // Fréquence de rafraîchissement de l'état (2 secondes, comme avant).
  var INTERVALLE_RAFRAICHISSEMENT_MS = 2000;
  // Si `maj` (cloud) date de plus de 20 s, on considère le PC hors ligne.
  var SEUIL_PC_HORS_LIGNE_S = 20;
  // Nombre maximum d'alertes affichées dans le journal.
  var MAX_ALERTES = 20;
  // Clé de stockage localStorage pour la clé d'accès du mode local.
  var CLE_LOCALE_STOCKAGE = "sezar_cle_locale";

  // ============================================================
  // 2) Choix du mode (cloud ou local)
  // ============================================================

  /**
   * Décide du mode une seule fois au démarrage.
   * Cloud si config.js contient une URL/clé valides, sinon local.
   * @returns {"cloud"|"local"}
   */
  function detecterMode() {
    var cfg = window.SEZAR;
    // Pas de config.js : la page est forcément servie par le serveur local.
    if (!cfg) return "local";
    var url = String(cfg.URL || "");
    // Les valeurs d'exemple ("VOTRE...") indiquent une config non remplie.
    if (url.indexOf("VOTRE") !== -1 || url.trim() === "") return "local";
    if (!cfg.ANON || String(cfg.ANON).indexOf("VOTRE") !== -1) return "local";
    return "cloud";
  }

  // ============================================================
  // 3) Sources de données : sourceCloud et sourceLocale
  // ============================================================
  // Les deux objets exposent la même interface (session, seConnecter, seDeconnecter,
  // lireStatut, lireJournal, envoyer, démarrer/arrêter). Le reste du code ignore le mode.

  /**
   * Source de données "cloud" : Supabase Auth + tables etat/alertes/commandes.
   * Aucune clé service_role ici : uniquement la clé publique anon (config.js).
   * @returns {object} interface commune de source de données
   */
  function creerSourceCloud() {
    var client = null;
    var timerId = null;

    /**
     * Crée (une seule fois) et renvoie le client Supabase.
     * @returns {object|null} client supabase-js ou null si la lib n'est pas chargée
     */
    function getClient() {
      if (client) return client;
      if (!window.supabase || !window.SEZAR) return null;
      client = window.supabase.createClient(window.SEZAR.URL, window.SEZAR.ANON);
      return client;
    }

    return {
      mode: "cloud",

      /** Renvoie la session Supabase existante, ou null si l'utilisateur n'est pas connecté. */
      async session() {
        var sb = getClient();
        if (!sb) return null;
        var res = await sb.auth.getSession();
        return res && res.data ? res.data.session : null;
      },

      /** Connexion par e-mail + mot de passe. Lève une erreur en français si échec. */
      async seConnecter(email, motDePasse) {
        var sb = getClient();
        if (!sb) throw new Error("Configuration manquante.");
        var res = await sb.auth.signInWithPassword({ email: email, password: motDePasse });
        // Message traduit : ne pas exposer le message technique anglais de Supabase.
        if (res.error) throw new Error("E-mail ou mot de passe incorrect.");
        return res.data.session;
      },

      /** Ferme la session Supabase côté navigateur. */
      async seDeconnecter() {
        var sb = getClient();
        if (!sb) return;
        await sb.auth.signOut();
      },

      /**
       * Lit la ligne unique `etat` (id=1) et normalise le résultat.
       * Le PC est hors ligne si `maj` a plus de 20 s (SEUIL_PC_HORS_LIGNE_S).
       */
      async lireStatut() {
        var sb = getClient();
        if (!sb) {
          return { erreur: "config", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
        }
        try {
          var q = await sb.from("etat").select("*").eq("id", 1).maybeSingle();
          // Pas de ligne ou pas de date `maj` : le PC n'a encore rien publié.
          if (q.error || !q.data || !q.data.maj) {
            return { erreur: "attente", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
          }
          // Âge de la dernière synchronisation, en secondes.
          var age = (Date.now() - new Date(q.data.maj).getTime()) / 1000;
          var ok = age < SEUIL_PC_HORS_LIGNE_S;
          return {
            erreur: null,
            pcEnLigne: ok,
            espEnLigne: ok && !!q.data.esp_ok,
            cameraEnLigne: ok && !!q.data.camera_ok,
            armee: !!q.data.armee,
            alerte: !!q.data.alerte,
            source: q.data.source || "",
            nbAlertes: typeof q.data.nb_alertes === "number" ? q.data.nb_alertes : null,
            ip: q.data.ip || "",
            derniereSynchro: new Date(q.data.maj)
          };
        } catch (err) {
          return { erreur: "cloud", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
        }
      },

      /** Lit les 20 alertes les plus récentes et renvoie [{ date, urlPhoto }]. */
      async lireJournal() {
        var sb = getClient();
        if (!sb) return [];
        try {
          var res = await sb.from("alertes").select("*").order("heure", { ascending: false }).limit(MAX_ALERTES);
          // Normalise les lignes Supabase vers le format commun du journal.
          return (res.data || []).map(function (row) {
            return { date: row.heure ? new Date(row.heure) : null, urlPhoto: row.photo_url || "" };
          }).filter(function (item) { return item.urlPhoto; });
        } catch (err) {
          return [];
        }
      },

      /** Insère un ordre { action } dans la table `commandes` (le PC l'exécutera). */
      async envoyer(action) {
        var sb = getClient();
        if (!sb) throw new Error("Configuration manquante.");
        var res = await sb.from("commandes").insert({ action: action });
        if (res.error) throw new Error("Envoi impossible.");
      },

      /** Démarre la boucle de rafraîchissement périodique. */
      demarrerBoucle: function (fn) {
        if (timerId) clearInterval(timerId);
        timerId = setInterval(fn, INTERVALLE_RAFRAICHISSEMENT_MS);
      },

      /** Arrête la boucle de rafraîchissement. */
      arreterBoucle: function () {
        if (timerId) { clearInterval(timerId); timerId = null; }
      }
    };
  }

  /**
   * Source de données "locale" : API du serveur Python protégée par clé (?key=).
   * La clé est lue dans localStorage (try/catch pour les navigateurs restrictifs).
   * @returns {object} interface commune de source de données
   */
  function creerSourceLocale() {
    var timerId = null;
    var cle = "";

    /** Lit la clé mémorisée (chaîne vide si localStorage indisponible). */
    function lireCle() {
      try { return localStorage.getItem(CLE_LOCALE_STOCKAGE) || ""; } catch (err) { return ""; }
    }

    /**
     * Mémorise (ou efface) la clé locale, en tolérant un localStorage bloqué.
     * @param {string} value
     */
    function enregistrerCle(value) {
      cle = value || "";
      try {
        if (cle) localStorage.setItem(CLE_LOCALE_STOCKAGE, cle);
        else localStorage.removeItem(CLE_LOCALE_STOCKAGE);
      } catch (err) {}
    }

    /** Ajoute `?key=...` (ou `&key=...`) à une URL de l'API locale. */
    function urlAvecCle(base) {
      var sep = base.indexOf("?") >= 0 ? "&" : "?";
      return base + sep + "key=" + encodeURIComponent(cle);
    }

    /** Construit l'URL de test de clé (`/api/etat?key=...`). */
    function urlAvecCleLocal(cleSaisie) {
      return "/api/etat?key=" + encodeURIComponent(cleSaisie || cle);
    }

    /**
     * GET JSON sur l'API locale.
     * Transforme un 401 en erreur marquée `code = 401` pour redemander la clé.
     */
    async function requeteJson(url) {
      var res = await fetch(url, { cache: "no-store" });
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

      /** Renvoie { cle } si une clé est mémorisée, sinon null. */
      async session() {
        cle = lireCle();
        return cle ? { cle: cle } : null;
      },

      /**
       * Vérifie une clé en interrogeant /api/etat, puis la mémorise si elle est acceptée.
       * @param {string} value clé saisie par l'utilisateur
       */
      async seConnecter(value) {
        var name = String(value || "").trim();
        if (!name) throw new Error("Clé manquante.");
        // Paramètre anti-cache pour forcer un vrai test de la clé.
        var url = urlAvecCleLocal(name) + "&_=" + Date.now();
        var res = await fetch(url, { cache: "no-store" });
        if (res.status === 401) throw new Error("Clé d'accès refusée.");
        if (!res.ok) throw new Error("Serveur local injoignable.");
        enregistrerCle(name);
        return { cle: name };
      },

      /** Oublie la clé locale. */
      async seDeconnecter() {
        enregistrerCle("");
      },

      /**
       * Lit /api/etat et normalise le résultat.
       * `esp: null` signifie que l'ESP32 est hors ligne (le PC, lui, répond).
       */
      async lireStatut() {
        if (!cle) return { erreur: "cle", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
        try {
          var data = await requeteJson(urlAvecCle("/api/etat"));
          var esp = data.esp;
          var cam = data.camera || {};
          // Le serveur local répond mais l'ESP32 est injoignable.
          if (!esp) {
            return { erreur: null, pcEnLigne: true, espEnLigne: false, cameraEnLigne: !!cam.ok, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: new Date() };
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
        } catch (err) {
          // Clé refusée : on le signale pour redemander la clé à l'utilisateur.
          if (err && err.code === 401) return { erreur: "cle", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
          return { erreur: "local", pcEnLigne: false, espEnLigne: false, cameraEnLigne: false, armee: false, alerte: false, source: "", nbAlertes: null, ip: "", derniereSynchro: null };
        }
      },

      /** Lit le journal depuis /api/etat et construit les URLs de photos protégées par la clé. */
      async lireJournal() {
        if (!cle) return [];
        try {
          var data = await requeteJson(urlAvecCle("/api/etat"));
          var entries = (data && data.journal) || [];
          return entries.map(function (item) {
            return { date: item.heure ? new Date(item.heure) : null, urlPhoto: item.photo ? ("/photos/" + encodeURIComponent(item.photo) + "?key=" + encodeURIComponent(cle)) : "" };
          }).filter(function (item) { return item.urlPhoto; });
        } catch (err) {
          return [];
        }
      },

      /** POST /api/action/{action}. Marque un 401 pour permettre de redemander la clé. */
      async envoyer(action) {
        if (!cle) throw new Error("Clé manquante.");
        var res = await fetch(urlAvecCle("/api/action/" + encodeURIComponent(action)), { method: "POST" });
        if (res.status === 401) { var e = new Error("non autorise"); e.code = 401; throw e; }
        if (!res.ok) throw new Error("Action impossible.");
      },

      /** Démarre la boucle de rafraîchissement périodique. */
      demarrerBoucle: function (fn) {
        if (timerId) clearInterval(timerId);
        timerId = setInterval(fn, INTERVALLE_RAFRAICHISSEMENT_MS);
      },

      /** Arrête la boucle de rafraîchissement. */
      arreterBoucle: function () {
        if (timerId) { clearInterval(timerId); timerId = null; }
      },

      /** Branche la vue en direct sur le flux MJPEG local (/api/stream). */
      demarrerLive: function () {
        var img = document.getElementById("liveImg");
        if (!img || !cle) return;
        img.src = "/api/stream?key=" + encodeURIComponent(cle) + "&_=" + Date.now();
      },

      /** Rien à arrêter explicitement : retirer la source de l'image suffit. */
      arreterLive: function () {}
    };
  }

  // ============================================================
  // 4) Logique métier (fonction pure)
  // ============================================================

  /**
   * Transforme l'objet normalisé des sources en affichage { type, titre, details }.
   * Fonction pure : ne lit aucune variable globale, donc facile à tester.
   * Priorité : erreur > PC hors ligne > ESP32 hors ligne > intrusion > armé > désarmé.
   * @param {object|null} statut objet renvoyé par lireStatut()
   * @returns {{type:string, titre:string, details:string}}
   */
  function calculerStatut(statut) {
    // Aucune donnée encore reçue (premier chargement).
    if (!statut) return { type: "off", titre: "Chargement", details: "" };
    // Erreurs techniques : toujours prioritaires sur l'état métier.
    if (statut.erreur === "config") return { type: "off", titre: "Configuration manquante", details: "Vérifiez le fichier de configuration." };
    if (statut.erreur === "cle") return { type: "off", titre: "Accès refusé", details: "Clé d'accès requise ou incorrecte." };
    if (statut.erreur === "cloud") return { type: "off", titre: "Service injoignable", details: "Vérifiez votre connexion Internet." };
    if (statut.erreur === "local") return { type: "off", titre: "Serveur local injoignable", details: "Vérifiez que le serveur est démarré." };
    if (statut.erreur === "attente") return { type: "off", titre: "En attente du PC", details: "Lancez le serveur SEZAR sur le PC." };
    // Ensuite la priorité métier : PC > ESP32 > intrusion > armé > désarmé.
    if (!statut.pcEnLigne) return { type: "off", titre: "PC hors ligne", details: "Le serveur ne répond plus." };
    if (!statut.espEnLigne) return { type: "off", titre: "ESP32 hors ligne", details: "Vérifiez l'alimentation et le réseau." };
    if (statut.alerte) return { type: "bad", titre: "Intrusion", details: statut.source ? "Source : " + statut.source : "Intrusion détectée" };
    if (statut.armee) return { type: "ok", titre: "Système armé", details: "Surveillance active." };
    return { type: "warn", titre: "Système désarmé", details: "Les mouvements sont ignorés." };
  }

  // ============================================================
  // 5) Affichage : une fonction par zone
  // ============================================================

  // Icônes SVG inline (trait fin). La couleur vient du CSS via currentColor.
  var iconesSvg = {
    ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
    bad: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 9v5"/><path d="M12 17h.01"/></svg>',
    off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10 10 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><path d="M3 3l18 18"/></svg>'
  };

  /**
   * Formate une date en libellé lisible : "Aujourd'hui 14:32", "Hier 22:10", sinon date FR.
   * @param {Date|null} dateObj
   * @returns {string}
   */
  function formaterDateRelative(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return "Date inconnue";
    var maintenant = new Date();
    // Minuit local du jour courant et du jour de la date : évite les erreurs d'heure.
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

  /**
   * Affiche l'état principal : type (couleur), titre et détails.
   * Le texte est inséré avec textContent pour éviter toute injection HTML.
   * @param {object|null} statut
   */
  function afficherStatut(statut) {
    var vue = calculerStatut(statut);
    var card = document.getElementById("etatCard");
    var ic = document.getElementById("etatIcon");
    var t = document.getElementById("etatTitre");
    var d = document.getElementById("etatDetails");
    if (!card || !ic || !t || !d) return;
    // data-type pilote la couleur via le CSS (toujours accompagné d'un texte).
    card.setAttribute("data-type", vue.type);
    ic.innerHTML = iconesSvg[vue.type] || iconesSvg.off;
    t.textContent = vue.titre;
    d.textContent = vue.details || "";
  }

  /**
   * Construit la grille des scènes (Jour/Nuit/Silence/Test).
   * En mode cloud, les scènes ne sont pas envoyées : elles dépendent du réseau local.
   * @param {object|null} statut
   * @param {"cloud"|"local"} mode
   */
  function afficherScenes(statut, mode) {
    var container = document.getElementById("sceneGrid");
    if (!container) return;
    // Reconstruction simple pour éviter de garder d'anciens écouteurs.
    while (container.firstChild) container.removeChild(container.firstChild);
    var scenes = [
      { nom: "Jour", icon: "sun", action: "desarm" },
      { nom: "Nuit", icon: "moon", action: "arm" },
      { nom: "Silence", icon: "bell-off", action: "veille" },
      { nom: "Test", icon: "spark", action: "alerte" }
    ];
    var active = statut && statut.armee ? "Nuit" : "Jour";
    scenes.forEach(function (scene) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "scene-card" + (scene.nom === active ? " is-active" : "");
      var iconWrap = document.createElement("div");
      iconWrap.className = "scene-icon";
      iconWrap.innerHTML = getSceneIcon(scene.icon);
      var label = document.createElement("div");
      label.className = "scene-name";
      label.textContent = scene.nom;
      button.appendChild(iconWrap);
      button.appendChild(label);
      button.addEventListener("click", function () {
        if (mode === "cloud") {
          afficherToast("Scène disponible sur le réseau local de la maison.");
          return;
        }
        envoyerAction(scene.action);
      });
      container.appendChild(button);
    });
  }

  /**
   * Renvoie l'icône SVG d'une scène (fallback : "spark").
   * @param {string} name
   * @returns {string}
   */
  function getSceneIcon(name) {
    var icons = {
      sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
      moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A8.5 8.5 0 0 1 11.2 3a8.5 8.5 0 1 0 9.8 9.8z"/></svg>',
      "bell-off": '<svg viewBox="0 0 24 24"><path d="M15 17H5l1.4-1.2A2 2 0 0 0 7 14.2V11A5 5 0 0 1 17 11v1.2"/><path d="M10 20a2 2 0 0 0 4 0"/><path d="M3 3l18 18"/></svg>',
      spark: '<svg viewBox="0 0 24 24"><path d="M12 2v5M12 17v5M2 12h5M17 12h5M5.5 5.5l3.5 3.5M15 15l3.5 3.5M18.5 5.5l-3.5 3.5M9 15l-3.5 3.5"/></svg>'
    };
    return icons[name] || icons.spark;
  }

  /**
   * Affiche la liste des appareils (caméra, sirène, ESP32, PC) avec leur état.
   * @param {object|null} statut
   */
  function afficherAppareils(statut) {
    var container = document.getElementById("deviceList");
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    var items = [
      { nom: "Caméra", meta: "Vision intérieure", ok: !!(statut && statut.cameraEnLigne), icon: "camera" },
      { nom: "Sirène", meta: "Alarme sonore", ok: !!(statut && statut.alerte), icon: "bell" },
      { nom: "ESP32", meta: "Contrôle local", ok: !!(statut && statut.espEnLigne), icon: "chip" },
      { nom: "Serveur PC", meta: "Système central", ok: !!(statut && statut.pcEnLigne), icon: "server" }
    ];
    items.forEach(function (item) {
      var card = document.createElement("div");
      card.className = "device-card";
      var icon = document.createElement("div");
      icon.className = "device-icon";
      icon.innerHTML = getDeviceIcon(item.icon);
      var text = document.createElement("div");
      text.className = "device-text";
      var name = document.createElement("div");
      name.className = "device-name";
      name.textContent = item.nom;
      var meta = document.createElement("div");
      meta.className = "device-meta";
      meta.textContent = item.meta;
      text.appendChild(name);
      text.appendChild(meta);
      var state = document.createElement("div");
      state.className = "device-state";
      var switchEl = document.createElement("span");
      switchEl.className = "switch" + (item.ok ? " is-on" : "");
      state.appendChild(switchEl);
      state.appendChild(document.createTextNode(item.ok ? " En ligne" : " Hors ligne"));
      card.appendChild(icon);
      card.appendChild(text);
      card.appendChild(state);
      container.appendChild(card);
    });
  }

  /**
   * Renvoie l'icône SVG d'un appareil (fallback : "server").
   * @param {string} name
   * @returns {string}
   */
  function getDeviceIcon(name) {
    var icons = {
      camera: '<svg viewBox="0 0 24 24"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h2.3l1.2-2h6l1.2 2h2.3A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.5"/></svg>',
      bell: '<svg viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M6 17h12l-1.3-1.3A2 2 0 0 1 16 14.2V11a4 4 0 1 0-8 0v3.2a2 2 0 0 1-.7 1.5z"/></svg>',
      chip: '<svg viewBox="0 0 24 24"><rect x="5" y="9" width="14" height="6" rx="2"/><path d="M9 5v4M15 5v4M9 15v4M15 15v4M5 12h-2M21 12h-2"/></svg>',
      server: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="5" rx="2"/><rect x="3" y="14" width="18" height="5" rx="2"/><path d="M7 8h0M7 17h0"/></svg>'
    };
    return icons[name] || icons.server;
  }

  /**
   * Affiche le journal des intrusions sous forme de lignes avec miniature et date.
   * Le DOM est construit avec createElement/textContent (aucune donnée brute injectée).
   * @param {Array<{date:Date|null, urlPhoto:string}>} items
   */
  function afficherJournal(items) {
    var cont = document.getElementById("journalListe");
    if (!cont) return;
    while (cont.firstChild) cont.removeChild(cont.firstChild);
    if (!items || items.length === 0) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Aucune intrusion enregistrée.";
      cont.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "journal-item";
      var img = document.createElement("img");
      img.className = "journal-thumb";
      img.src = item.urlPhoto || "";
      img.alt = "Photo d'intrusion";
      img.addEventListener("click", function () { ouvrirLightbox(item.urlPhoto || ""); });
      var text = document.createElement("div");
      text.className = "journal-text";
      var title = document.createElement("p");
      title.className = "journal-title";
      title.textContent = "Intrusion détectée";
      var date = document.createElement("p");
      date.className = "journal-date";
      date.textContent = formaterDateRelative(item.date);
      text.appendChild(title);
      text.appendChild(date);
      row.appendChild(img);
      row.appendChild(text);
      cont.appendChild(row);
    });
  }

  /**
   * Affiche la vue en direct en mode local, sinon un visuel d'attente (cloud).
   * En local, l'image pointe vers le flux MJPEG protégé par la clé.
   * @param {object|null} statut
   * @param {"cloud"|"local"} mode
   */
  function afficherVideo(statut, mode) {
    var img = document.getElementById("liveImg");
    var status = document.getElementById("liveStatus");
    if (!img || !status) return;
    if (mode === "local") {
      var cle = localStorage.getItem(CLE_LOCALE_STOCKAGE) || "";
      img.src = "/api/stream?key=" + encodeURIComponent(cle) + "&_=" + Date.now();
      status.textContent = statut && statut.cameraEnLigne ? "Flux en direct" : "Caméra hors ligne";
      return;
    }
    status.textContent = "Vidéo disponible sur le réseau local de la maison";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#1f1817"/><circle cx="320" cy="170" r="90" fill="none" stroke="#e5b76b" stroke-width="4"/><path d="M260 72h120l70 98v80H190v-80z" fill="none" stroke="#e5b76b" stroke-width="3"/></svg>');
  }

  // ============================================================
  // 6) Assistant local (optionnel, mode local uniquement)
  // ============================================================

  /** Liste des suggestions affichées sous la zone de saisie de l'assistant. */
  function suggestions() {
    return ["État du système", "Armer", "Météo", "Heure"];
  }

  /**
   * Ajoute une bulle de message dans le panneau de l'assistant.
   * @param {"user"|"bot"} role
   * @param {string} message
   */
  function afficherMessage(role, message) {
    var pane = document.getElementById("assistantMessages");
    if (!pane) return;
    var bubble = document.createElement("div");
    bubble.className = "bubble " + role;
    // textContent : le message vient du serveur, donc jamais injecté comme HTML.
    bubble.textContent = message;
    pane.appendChild(bubble);
    pane.scrollTop = pane.scrollHeight;
  }

  /** Envoie le message saisi à /api/assistant et affiche la réponse ou l'erreur. */
  function envoyerMessage() {
    var input = document.getElementById("assistantInput");
    if (!input) return;
    var texte = input.value.trim();
    if (!texte) return;
    afficherMessage("user", texte);
    input.value = "";
    // L'assistant n'existe que côté serveur local.
    if (etatApp.mode !== "local") {
      afficherMessage("bot", "L'assistant local n'est disponible que sur le réseau local de la maison.");
      return;
    }
    var key = localStorage.getItem(CLE_LOCALE_STOCKAGE) || "";
    var button = document.getElementById("assistantSend");
    if (button) button.disabled = true;
    fetch("/api/assistant?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: texte })
    }).then(function (res) {
      if (!res.ok) throw new Error("assistant indisponible");
      return res.json();
    }).then(function (data) {
      afficherMessage("bot", data && data.reponse ? data.reponse : "Aucune réponse.");
    }).catch(function () {
      afficherMessage("bot", "Je n'ai pas répondu. Vérifiez la clé locale ou le serveur.");
    }).then(function () {
      if (button) button.disabled = false;
    });
  }

  /** Crée les boutons de suggestion et les branche à l'envoi de message. */
  function remplirSuggestions() {
    var box = document.getElementById("assistantSuggestions");
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    suggestions().forEach(function (label) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "suggestion";
      btn.textContent = label;
      btn.addEventListener("click", function () {
        var input = document.getElementById("assistantInput");
        if (input) input.value = label;
        envoyerMessage();
      });
      box.appendChild(btn);
    });
  }

  // ============================================================
  // 7) Événements et démarrage
  // ============================================================

  // État central de l'application (évite les variables globales dispersées).
  var etatApp = { mode: null, source: null, envoiEnCours: false };

  /**
   * Affiche une confirmation discrète en bas de l'écran pendant ~2 s.
   * @param {string} message
   */
  function afficherToast(message) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  /**
   * Ouvre la photo en grand.
   * @param {string} url
   */
  function ouvrirLightbox(url) {
    if (!url) return;
    var lb = document.getElementById("lightbox");
    var img = document.getElementById("lightboxImg");
    if (!lb || !img) return;
    img.src = url;
    lb.hidden = false;
  }

  /** Ferme la visionneuse de photo. */
  function fermerLightbox() {
    var lb = document.getElementById("lightbox");
    if (lb) lb.hidden = true;
  }

  /**
   * Boucle de rafraîchissement : lit l'état et le journal puis met l'interface à jour.
   * Appelée toutes les 2 s par la source active (cloud ou local).
   */
  async function bouclePrincipale() {
    if (!etatApp.source) return;
    var statut = await etatApp.source.lireStatut();
    afficherStatut(statut);
    afficherScenes(statut, etatApp.mode);
    afficherAppareils(statut);
    afficherJournal(await etatApp.source.lireJournal());
    afficherVideo(statut, etatApp.mode);
  }

  /**
   * Envoie une action à la source active, avec retour visuel et anti double-clic.
   * @param {"arm"|"desarm"|"veille"|"alerte"} action
   */
  async function envoyerAction(action) {
    if (etatApp.envoiEnCours || !etatApp.source) return;
    etatApp.envoiEnCours = true;
    try {
      await etatApp.source.envoyer(action);
      afficherToast("Ordre envoyé.");
      // Petit délai pour laisser le PC/ESP32 appliquer l'ordre avant de relire.
      setTimeout(bouclePrincipale, 500);
    } catch (e) {
      // Clé locale refusée : on redemande la clé au lieu d'afficher une erreur générique.
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

  /** Prépare et affiche le formulaire de connexion en mode cloud. */
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

  /** Prépare et affiche le formulaire de clé d'accès en mode local. */
  function afficherLoginLocal() {
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

  /** Masque l'écran de connexion pour laisser apparaître l'interface principale. */
  function cacherLogin() {
    var login = document.getElementById("login");
    if (login) login.hidden = true;
  }

  /**
   * Point de démarrage : choisit le mode une seule fois, instancie la source
   * correspondante, vérifie la session puis lance la boucle de rafraîchissement.
   */
  async function demarrerApplication() {
    etatApp.mode = detecterMode();
    if (etatApp.mode === "cloud") {
      etatApp.source = creerSourceCloud();
      var session = await etatApp.source.session();
      // Pas de session Supabase : on affiche le formulaire de connexion.
      if (!session) { afficherLoginCloud(); return; }
      cacherLogin();
      await bouclePrincipale();
      etatApp.source.demarrerBoucle && etatApp.source.demarrerBoucle(bouclePrincipale);
    } else {
      etatApp.source = creerSourceLocale();
      var activeKey = await etatApp.source.session();
      // Pas de clé mémorisée : on demande la clé d'accès.
      if (!activeKey || !activeKey.cle) { afficherLoginLocal(); return; }
      cacherLogin();
      etatApp.source.demarrerLive && etatApp.source.demarrerLive();
      await bouclePrincipale();
      etatApp.source.demarrerBoucle && etatApp.source.demarrerBoucle(bouclePrincipale);
    }
  }

  /** Branche tous les écouteurs d'événements (connexion, actions, lightbox, assistant). */
  function brancherEvenements() {
    var form = document.getElementById("loginForm");
    if (form) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var errEl = document.getElementById("loginErreur");
        if (errEl) errEl.textContent = "";
        try {
          // Le même formulaire sert aux deux modes : on lit les bons champs.
          if (etatApp.mode === "cloud") {
            var email = document.getElementById("email").value;
            var password = document.getElementById("mdp").value;
            await etatApp.source.seConnecter(email, password);
          } else {
            var cle = document.getElementById("cle").value;
            await etatApp.source.seConnecter(cle);
          }
          cacherLogin();
          await bouclePrincipale();
        } catch (err) {
          if (errEl) errEl.textContent = err && err.message ? err.message : "Connexion impossible.";
        }
      });
    }

    // Assistant : envoi par bouton ou touche Entrée.
    var match = document.getElementById("assistantSend");
    if (match) match.addEventListener("click", envoyerMessage);
    var input = document.getElementById("assistantInput");
    if (input) input.addEventListener("keydown", function (event) { if (event.key === "Enter") envoyerMessage(); });

    // Ouverture/fermeture du panneau de l'assistant.
    var assistantToggle = document.getElementById("assistantToggle");
    var assistantPanel = document.getElementById("assistantPanel");
    if (assistantToggle && assistantPanel) {
      assistantToggle.addEventListener("click", function () { assistantPanel.hidden = !assistantPanel.hidden; });
    }
    var assistantClose = document.getElementById("assistantClose");
    if (assistantClose && assistantPanel) assistantClose.addEventListener("click", function () { assistantPanel.hidden = true; });

    // Plein écran : ouvre l'image courante dans un nouvel onglet.
    var btnFullscreen = document.getElementById("btnFullscreen");
    if (btnFullscreen) {
      btnFullscreen.addEventListener("click", function () {
        var img = document.getElementById("liveImg");
        if (img && img.src) window.open(img.src, "_blank");
      });
    }

    // Visionneuse : fermeture au clic sur le fond ou sur le bouton.
    var lb = document.getElementById("lightbox");
    if (lb) lb.addEventListener("click", function (event) { if (event.target === lb) fermerLightbox(); });
    var closeBtn = document.getElementById("lightboxClose");
    if (closeBtn) closeBtn.addEventListener("click", fermerLightbox);

    // Filtres du journal : un seul actif à la fois (purement visuel).
    document.querySelectorAll(".filter-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        document.querySelectorAll(".filter-chip").forEach(function (item) { item.classList.remove("is-active"); });
        chip.classList.add("is-active");
      });
    });
  }

  // Démarrage : branche les événements, remplit l'assistant puis lance l'application.
  brancherEvenements();
  remplirSuggestions();
  demarrerApplication();
})();
