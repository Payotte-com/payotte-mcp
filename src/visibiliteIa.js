import QUESTIONS_IA from './data/questionsIa.json';
/**
 * visibiliteIa.js — service « Visibilité IA » (page /visibilite-ia-professionnels-immobilier).
 *
 * POST /vi/inscription — formulaire de la page (correctif 2, ronde 2, 5 oct. 2026).
 *   Remplace les courriels préremplis (mailto:), qui échouent sans logiciel de courriel.
 *   Fonctionne SANS JavaScript : POST classique (application/x-www-form-urlencoded), puis
 *   redirection 303 vers la page de confirmation du site, ou vers le formulaire avec ?erreur=… .
 *   Aucun paiement ici : le pro paie APRÈS vérification de son permis et de son secteur (promesse de
 *   la page). La demande part à Grégory (REPORT_TO), « Répondre » écrit au pro ; le pro reçoit un
 *   accusé de réception. Garde-fous : pot de miel, consentement coché, domaine réel, 5 demandes par
 *   jour et par courriel (empreinte HMAC), 200 demandes par jour au total.
 *   ⚠️ Le numéro de permis est FACULTATIF : le RECA (Alberta) n'en publie aucun — ne jamais l'exiger.
 */

const METIERS = {
  'real-estate-broker': { fr: 'Courtier immobilier', en: 'Real estate broker' },
  'mortgage-broker': { fr: 'Courtier hypothécaire', en: 'Mortgage broker' },
  'home-inspector': { fr: 'Inspecteur en bâtiment', en: 'Home inspector' },
  'notary-lawyer': { fr: 'Notaire / avocat', en: 'Notary / real estate lawyer' },
  'appraiser': { fr: 'Évaluateur agréé', en: 'Appraiser' },
};
const FORFAITS = {
  aucun: { fr: 'Aucun pour l’instant (je soumets mon nom)', en: 'None for now (I am submitting my name)' },
  fiche: { fr: 'Fiche IA', en: 'AI profile' },
  premium: { fr: 'Premium', en: 'Premium' },
  pro: { fr: 'Premium Pro', en: 'Premium Pro' },
};

export async function handleInscription(request, env, h) {
  const { SITE, REPORT_TO, EMAIL_RE, domainExists, bumpCounter, hmacHex } = h;
  const ct = request.headers.get('content-type') || '';
  let b = {};
  if (ct.includes('application/json')) b = (await request.json().catch(() => ({}))) || {};
  else { const f = await request.formData().catch(() => null); if (f) for (const [k, v] of f.entries()) b[k] = typeof v === 'string' ? v : ''; }

  const fr = b.lang !== 'en';
  const page = fr ? '/visibilite-ia-professionnels-immobilier' : '/en/ai-visibility-real-estate-professionals';
  const merci = fr ? '/inscription-recue' : '/en/registration-received';
  const retour = (code) => Response.redirect(`${SITE}${page}?erreur=${code}#inscription`, 303);

  if (b.url_hp) return Response.redirect(`${SITE}${merci}`, 303);            // pot de miel : un robot a rempli le champ caché
  const propre = (v, n = 200) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n).trim();
  const nom = propre(b.nom, 120);
  const courriel = propre(b.courriel, 160).toLowerCase();
  const metier = METIERS[b.metier] ? b.metier : '';
  const forfait = FORFAITS[b.forfait] ? b.forfait : 'aucun';
  const formule = b.formule === 'annuelle' ? 'annuelle' : 'mensuelle';
  const secteur = propre(b.secteur, 80);
  const secteurLibre = propre(b.secteur_libre, 120);
  if (b.consentement !== 'oui' && b.consentement !== true) return retour('consentement');
  if (!nom || !EMAIL_RE.test(courriel)) return retour('champs');
  if (!metier || (!secteur && !secteurLibre)) return retour('metier');
  if (!(await domainExists(courriel))) return retour('domaine');
  const jour = new Date().toISOString().slice(0, 10);
  if (env.COUNTERS) {
    const rh = (await hmacHex(env, courriel)).slice(0, 16);
    if ((await bumpCounter(env, `vii:${rh}:${jour}`, 3 * 86400)) > 5) return retour('limite');
    if ((await bumpCounter(env, `vii:total:${jour}`, 3 * 86400)) > 200) return retour('limite');
  }

  const tel = propre(b.tel, 40), site = propre(b.site_web, 160), permis = propre(b.permis, 60), note = propre(b.note, 600);
  const fiche = {
    recu: new Date().toISOString(), lang: fr ? 'fr' : 'en', nom, courriel, tel, metier, secteur, secteurLibre,
    site, permis, forfait, formule: forfait === 'aucun' ? null : formule, note,
  };
  // Trace durable de la demande (la boîte de courriel n'est pas un registre) : 400 jours.
  if (env.COUNTERS) await env.COUNTERS.put(`vi:inscription:${fiche.recu}:${(await hmacHex(env, courriel)).slice(0, 8)}`, JSON.stringify(fiche), { expirationTtl: 400 * 86400 });

  if (env.RESEND_API_KEY) {
    const lieu = secteur ? `${secteur}${secteurLibre ? ` (précisé : ${secteurLibre})` : ''}` : `HORS LISTE : ${secteurLibre}`;
    const corps = [
      `Nouvelle inscription — Visibilité IA`, '',
      `Nom : ${nom}`, `Courriel : ${courriel}`, ...(tel ? [`Téléphone : ${tel}`] : []),
      `Métier : ${METIERS[metier].fr}`, `Secteur : ${lieu}`,
      ...(site ? [`Site : ${site}`] : []), `Permis : ${permis || '— (non fourni)'}`,
      `Forfait : ${FORFAITS[forfait].fr}${forfait === 'aucun' ? '' : ` · formule ${formule}`}`,
      `Langue : ${fr ? 'français' : 'anglais'}`,
      ...(note ? ['', note] : []),
      '', 'À faire : vérifier le permis et le secteur, dire au pro laquelle des trois possibilités est la sienne (A recommandé, B nouveau secteur, C fiche professionnelle), puis envoyer le paiement s’il y a lieu.',
      '— « Répondre » écrit directement au pro.',
    ].join('\n');
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Payotte <relais@payotte.com>', to: [REPORT_TO], reply_to: courriel,
        subject: `[Visibilité IA] ${FORFAITS[forfait].fr} — ${nom} (${METIERS[metier].fr})`, text: corps,
      }),
    }).catch(() => null);
    // Accusé au pro : il sait ce qui se passe ensuite, et qu'il ne paie rien avant la vérification.
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Payotte <relais@payotte.com>', to: [courriel], reply_to: REPORT_TO,
        subject: fr ? 'Nous avons bien reçu votre inscription — Payotte' : 'We received your registration — Payotte',
        text: (fr
          ? [`Bonjour ${nom},`, '', 'Merci, nous avons bien reçu votre inscription.', '',
             'La suite : nous vérifions votre permis et votre secteur, puis nous vous écrivons pour vous dire laquelle des trois possibilités est la vôtre : expert recommandé, nouveau secteur ou fiche professionnelle.',
             forfait === 'aucun' ? '' : `Pour le forfait ${FORFAITS[forfait].fr}, le lien de paiement vous parviendra après cette vérification. Vous ne payez rien avant.`,
             '', 'Une question d’ici là ? Répondez simplement à ce courriel.', '', '— Grégory Payotte', 'https://payotte.com']
          : [`Hello ${nom},`, '', 'Thank you, we received your registration.', '',
             'Next: we check your licence and your sector, then write to tell you which of the three possibilities is yours: recommended expert, new sector or professional profile.',
             forfait === 'aucun' ? '' : `For the ${FORFAITS[forfait].en} plan, the payment link will reach you after this check. You pay nothing before.`,
             '', 'Any question in the meantime? Just reply to this email.', '', '— Grégory Payotte', 'https://payotte.com']).filter((x) => x !== null).join('\n'),
        headers: { 'Auto-Submitted': 'auto-replied' },
      }),
    }).catch(() => null);
  }
  await bumpCounter(env, `vi:insc:${forfait}:${new Date().toISOString().slice(0, 7)}`, 400 * 86400);
  return Response.redirect(`${SITE}${merci}${forfait === 'aucun' ? '' : `?forfait=${forfait}`}`, 303);
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * GET /vi/presence — « Qui les IA nomment-elles ici ? » (outil de présence dans les IA, 5 oct. 2026)
 *
 *   Paramètres : metier (slug), secteur (slug), lieu (« Secteur, Ville », tel qu'affiché par la page),
 *   lang (fr|en), nom (facultatif : le nom du pro, pour dire s'il est nommé).
 *
 *   MODÈLE GRATUIT (la page publique) : UNE seule IA, Gemini avec recherche Google.
 *     - Coût : la recherche Google est comprise dans la franchise de l'API (5 000 requêtes/MOIS pour
 *       les modèles Gemini 3.x, facturation activée ; gemini-2.5-flash répond 404 depuis oct. 2026) ;
 *       seuls les jetons coûtent, des fractions de cent. Modèle : GEMINI_MODEL, sinon gemini-3.5-flash-lite.
 *     - Économie : 3 questions par diagnostic, réponses MISES EN CACHE 7 jours par métier × secteur ×
 *       langue. Le nom du pro est cherché dans la réponse en cache : aucun appel de plus.
 *     - Garde-fous : 3 diagnostics par jour et par IP (décision de Grégory, 5 oct.), 160 RECHERCHES par jour au total (≈ 4 800/mois).
 *   MODÈLE PAYANT (rapport mensuel des abonnés, à venir) : plusieurs IA. Les fournisseurs sont listés
 *     dans FOURNISSEURS ; seul Gemini est branché. Les autres ne s'activent qu'avec leur clé ET
 *     niveau=payant + jeton CONTACTS_TOKEN (jamais depuis la page publique).
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

const FOURNISSEURS = {
  gemini: { nom: 'Gemini', cle: 'GEMINI_API_KEY', gratuit: true, interroger: interrogerGemini },
  // À brancher pour le modèle payant (non appelés aujourd'hui) :
  // chatgpt:    { nom: 'ChatGPT',    cle: 'OPENAI_API_KEY',     gratuit: false, interroger: … },  // Responses API + outil web_search
  // perplexity: { nom: 'Perplexity', cle: 'PERPLEXITY_API_KEY', gratuit: false, interroger: … },  // sonar
  // claude:     { nom: 'Claude',     cle: 'ANTHROPIC_API_KEY',  gratuit: false, interroger: … },  // Messages API + outil web_search
};

const sansAccents = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function interrogerGemini(env, question, fr) {
  const modele = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const consigne = fr
    ? `${question}\nRéponds comme à un client : nomme de 3 à 5 professionnels ou cabinets précis, un par ligne, au format « Nom — raison courte ». N'invente aucun nom : seulement ceux que tu trouves dans tes recherches.`
    : `${question}\nAnswer as you would to a client: name 3 to 5 specific professionals or firms, one per line, in the format "Name — short reason". Do not invent names: only those found in your search.`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: consigne }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2, maxOutputTokens: 700 } }),
  }).catch(() => null);
  if (!r || !r.ok) {
    const msg = r ? ((await r.json().catch(() => null))?.error?.message || '').slice(0, 220) : '';
    return { erreur: r ? `http ${r.status}${msg ? ` : ${msg}` : ''}` : 'reseau' };
  }
  const j = await r.json().catch(() => null);
  const cand = j?.candidates?.[0];
  const texte = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  const sources = [...new Set((cand?.groundingMetadata?.groundingChunks || []).map((c) => c.web?.title || '').filter(Boolean))].slice(0, 8);
  const noms = texte.split('\n').map((l) => l.replace(/^[\s*\-•\d.)]+/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.includes('—') || l.includes(' - ')).map((l) => l.split(/ — | - /)[0].trim()).filter((n) => n && n.length <= 90).slice(0, 5);
  return { noms, sources, extrait: texte.slice(0, 900) };
}

const nettoyerLieu = (x) => String(x || '').replace(/[^\p{L}\p{N} ,.'’\-]/gu, '').slice(0, 80).trim();
const nettoyerNom = (x) => String(x || '').replace(/[^\p{L} .'’\-&]/gu, '').slice(0, 80).trim();
const MOIS_RECH = () => new Date().toISOString().slice(0, 7);

/** Résultat de présence pour métier × secteur × lieu × langue : cache 7 j, sinon 3 questions à Gemini.
 *  Retourne { res } ou { erreur, statut }. Le plafond est compté en RECHERCHES (160/jour). */
export async function obtenirPresence(env, metier, secteur, lieu, fr) {
  const f = FOURNISSEURS.gemini;
  if (!env[f.cle]) return { erreur: 'non-configure', statut: 503 };
  const jour = new Date().toISOString().slice(0, 10);
  const cle = `vip:cache3:${metier}:${secteur}:${fr ? 'fr' : 'en'}:${sansAccents(lieu).replace(/[^a-z0-9]+/g, '-')}`;
  let res = env.COUNTERS ? JSON.parse((await env.COUNTERS.get(cle)) || 'null') : null;
  if (res) return { res };
  const gabarits = QUESTIONS_IA[metier][fr ? 'fr' : 'en'].slice(0, 3);
  const cleAppels = `vip:recherches:${jour}`;
  const deja = env.COUNTERS ? parseInt((await env.COUNTERS.get(cleAppels)) || '0', 10) : 0;
  if (deja + gabarits.length > 160) return { erreur: 'quota', statut: 429 };
  if (env.COUNTERS) {
    await env.COUNTERS.put(cleAppels, String(deja + gabarits.length), { expirationTtl: 2 * 86400 });
    const cm = `vip:recherches-mois:${MOIS_RECH()}`;
    await env.COUNTERS.put(cm, String(parseInt((await env.COUNTERS.get(cm)) || '0', 10) + gabarits.length), { expirationTtl: 400 * 86400 });
  }
  const reponses = [];
  for (const g of gabarits) {
    const question = g.replace('{lieu}', lieu);
    const r = await f.interroger(env, question, fr);
    if (r.erreur) return { erreur: 'ia', detail: r.erreur, statut: 502 };
    reponses.push({ question, ...r });
  }
  res = { ia: f.nom, date: jour, reponses };
  if (env.COUNTERS) await env.COUNTERS.put(cle, JSON.stringify(res), { expirationTtl: 7 * 86400 });
  return { res };
}

/** Le nom du pro, cherché dans la réponse (aucun appel de plus). */
function lirePresence(res, nom) {
  const cible = sansAccents(nom);
  return res.reponses.map((r) => ({
    question: r.question, noms: r.noms, sources: r.sources,
    payotte: r.sources.some((x) => /payotte/i.test(x)) || /payotte/i.test(r.extrait || ''),
    vous: cible.length >= 3 ? sansAccents(r.extrait).includes(cible) : null,
  }));
}

export async function handlePresence(request, env, url, h) {
  const { json, bumpCounter } = h;
  const fr = url.searchParams.get('lang') !== 'en';
  const metier = url.searchParams.get('metier') || '';
  const secteur = (url.searchParams.get('secteur') || '').slice(0, 80);
  const lieu = nettoyerLieu(url.searchParams.get('lieu'));
  const nom = nettoyerNom(url.searchParams.get('nom'));
  if (!QUESTIONS_IA[metier] || !/^[a-z0-9-]{2,80}$/.test(secteur) || lieu.length < 2) return json({ ok: false, erreur: 'parametres' }, 400);
  if (!env[FOURNISSEURS.gemini.cle]) return json({ ok: false, erreur: 'non-configure' }, 503);
  const jour = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('cf-connecting-ip') || 'x';
  if ((await bumpCounter(env, `vip:ip:${ip}:${jour}`, 2 * 86400)) > 3) return json({ ok: false, erreur: 'limite' }, 429);
  const o = await obtenirPresence(env, metier, secteur, lieu, fr);
  if (o.erreur) return json({ ok: false, erreur: o.erreur, ...(o.detail ? { detail: o.detail } : {}) }, o.statut);
  await bumpCounter(env, `vip:diag:${MOIS_RECH()}`, 400 * 86400);
  return json({ ok: true, ia: o.res.ia, date: o.res.date, reponses: lirePresence(o.res, nom) });
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * SUIVI MENSUEL — « Recevez ce test chaque mois, gratuitement » (ronde 3, 5 oct. 2026)
 *   POST /vi/suivi (JSON) : courriel + consentement coché (LCAP) + métier, secteur, lieu, nom, langue.
 *     Enregistré dans COUNTERS sous `vi:suivi:{empreinte}` ; métadonnée { p } = prochain envoi (ms).
 *     Un courriel de bienvenue part tout de suite avec le résultat du jour.
 *   Envoi mensuel : passerSuivi(env) dans scheduled(), quelques abonnés par passage, budget de temps
 *     court (limite de 30 s du Cron Trigger). Respecte `stop:all` (SUBSCRIBERS) : arrêt manuel de tout.
 *   GET /vi/desabonnement?e=…&t=… : désabonnement en un clic (jeton HMAC), aussi en List-Unsubscribe.
 *   GET /vi/stats?key=CONTACTS_TOKEN : consommation du mois, pour Grégory.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */
const PAGE = { fr: 'https://payotte.com/visibilite-ia-professionnels-immobilier', en: 'https://payotte.com/en/ai-visibility-real-estate-professionals' };
const NOM_METIER = {
  'real-estate-broker': { fr: 'courtier immobilier', en: 'real estate broker' }, 'mortgage-broker': { fr: 'courtier hypothécaire', en: 'mortgage broker' },
  'home-inspector': { fr: 'inspecteur en bâtiment', en: 'home inspector' }, 'notary-lawyer': { fr: 'notaire', en: 'real estate lawyer' }, 'appraiser': { fr: 'évaluateur agréé', en: 'appraiser' },
};
const escH = (x) => String(x ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function courrielSuivi(env, h, a, res, premier) {
  const fr = a.lang !== 'en';
  const lignes = lirePresence(res, a.nom);
  const vus = new Map();
  lignes.flatMap((r) => r.noms).forEach((n) => { const k = sansAccents(n).replace(/[^a-z0-9]/g, ''); if (!vus.has(k)) vus.set(k, n); });
  const noms = [...vus.values()].slice(0, 6);
  const nomme = lignes.some((r) => r.vous === true);
  const metier = NOM_METIER[a.metier]?.[fr ? 'fr' : 'en'] || a.metier;
  const t = await h.hmacHex(env, `vi-desab:${a.courriel}`);
  const desab = `${h.WORKER_ORIGIN}/vi/desabonnement?e=${encodeURIComponent(a.courriel)}&t=${t.slice(0, 24)}`;
  const adresse = (env.ADRESSE_POSTALE || '').trim();
  const verdict = !a.nom ? (fr ? 'Voici qui Gemini (Google) recommande à vos clients' : 'Here is who Gemini (Google) recommends to your clients')
    : nomme ? (fr ? 'Gemini (Google) vous nomme.' : 'Gemini (Google) names you.') : (fr ? 'Gemini (Google) ne vous nomme pas.' : 'Gemini (Google) does not name you.');
  const couleur = a.nom && !nomme ? '#c8102e' : a.nom && nomme ? '#1f7a5a' : '#211c1e';
  const sujet = fr ? `${premier ? 'Votre test' : 'Votre test du mois'} : qui l'IA recommande comme ${metier} à ${a.lieu}` : `${premier ? 'Your test' : 'Your monthly test'}: who AI recommends as ${metier} in ${a.lieu}`;
  const html = `<div style="background:#f5f3f2;padding:20px 10px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:520px;width:100%;background:#fff;border:1px solid #eae5e5;border-radius:8px;">
<tr><td style="padding:18px 24px 6px;font-size:13px;color:#8a8284;">Payotte · ${fr ? 'Visibilité IA' : 'AI visibility'} · ${res.date}</td></tr>
<tr><td style="padding:6px 24px 0;"><div style="font-size:22px;font-weight:bold;color:${couleur};">${verdict}</div>
<div style="font-size:14px;line-height:1.5;color:#443e40;margin-top:6px;">${fr ? `Quand un client lui demande qui consulter comme ${escH(metier)} à ${escH(a.lieu)}, il recommande :` : `When a client asks it who to see as a ${escH(metier)} in ${escH(a.lieu)}, it recommends:`}</div>
<ol style="font-size:15px;font-weight:bold;color:#211c1e;line-height:1.6;margin:8px 0 0;padding-left:22px;">${noms.map((n) => `<li>${escH(n)}</li>`).join('') || `<li>${fr ? 'aucun nom précis' : 'no specific name'}</li>`}</ol></td></tr>
<tr><td style="padding:16px 24px 0;"><div style="background:#eef7f2;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.5;color:#1f3d31;"><b>${fr ? 'Faites entrer votre nom dans leurs réponses' : 'Get your name into their answers'}</b><br>${fr ? 'Votre fiche Payotte vous ajoute à une source que Copilot cite déjà des centaines de fois par jour, et que les autres IA lisent.' : 'Your Payotte profile adds you to a source Copilot already cites hundreds of times a day, and that other AI tools read.'}<br><a href="${PAGE[fr ? 'fr' : 'en']}#nom" style="display:inline-block;margin-top:10px;background:#c8102e;color:#fff;text-decoration:none;font-weight:bold;padding:9px 16px;border-radius:9px;">${fr ? 'Soumettre mon nom' : 'Submit my name'} &rarr;</a></div></td></tr>
<tr><td style="padding:14px 24px 18px;font-size:11px;line-height:1.6;color:#a49c9e;">${fr ? 'Réponse de Gemini (Google), avec recherche Google. Les réponses des IA varient : c’est une estimation.' : 'Gemini (Google) answer, with Google Search. AI answers vary: this is an estimate.'}<br>${fr ? 'Vous recevez ce test une fois par mois parce que vous l’avez demandé sur payotte.com.' : 'You receive this test once a month because you asked for it on payotte.com.'} <a href="${desab}" style="color:#8a8284;">${fr ? 'Ne plus recevoir' : 'Unsubscribe'}</a>${adresse ? `<br>${escH(adresse)}` : ''}</td></tr></table></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'Payotte <relais@payotte.com>', to: [a.courriel], reply_to: h.REPORT_TO, subject: sujet, html,
      headers: { 'List-Unsubscribe': `<${desab}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
  }).catch(() => null);
  return !!(r && r.ok);
}

export async function handleSuivi(request, env, h) {
  const { json, bumpCounter, hmacHex, EMAIL_RE, domainExists } = h;
  const b = (await request.json().catch(() => null)) || {};
  const fr = b.lang !== 'en';
  if (b.url_hp) return json({ ok: true });
  const courriel = String(b.courriel || '').trim().toLowerCase().slice(0, 160);
  if (b.consentement !== true) return json({ ok: false, erreur: 'consentement' }, 400);
  if (!EMAIL_RE.test(courriel)) return json({ ok: false, erreur: 'courriel' }, 400);
  const metier = QUESTIONS_IA[b.metier] ? b.metier : '';
  const secteur = /^[a-z0-9-]{2,80}$/.test(b.secteur || '') ? b.secteur : '';
  const lieu = nettoyerLieu(b.lieu), nom = nettoyerNom(b.nom);
  if (!metier || !secteur || lieu.length < 2) return json({ ok: false, erreur: 'parametres' }, 400);
  if (!(await domainExists(courriel))) return json({ ok: false, erreur: 'domaine' }, 400);
  const jour = new Date().toISOString().slice(0, 10);
  if ((await bumpCounter(env, `vis:${(await hmacHex(env, courriel)).slice(0, 16)}:${jour}`, 2 * 86400)) > 3) return json({ ok: false, erreur: 'limite' }, 429);
  if ((await bumpCounter(env, `vis:total:${jour}`, 2 * 86400)) > 300) return json({ ok: false, erreur: 'limite' }, 429);
  const a = { courriel, metier, secteur, lieu, nom, lang: fr ? 'fr' : 'en', depuis: new Date().toISOString() };
  const cle = `vi:suivi:${(await hmacHex(env, courriel)).slice(0, 20)}`;
  const prochain = Date.now() + 30 * 86400000;
  await env.COUNTERS.put(cle, JSON.stringify(a), { metadata: { p: prochain } });
  await bumpCounter(env, `vis:inscrits:${MOIS_RECH()}`, 400 * 86400);
  // Bienvenue : le résultat du jour, tout de suite (en cache, puisque le visiteur vient de le voir).
  if (env.RESEND_API_KEY) {
    const o = await obtenirPresence(env, metier, secteur, lieu, fr);
    if (o.res) await courrielSuivi(env, h, a, o.res, true);
  }
  return json({ ok: true });
}

export async function handleDesabonnement(url, env, h) {
  const e = String(url.searchParams.get('e') || '').toLowerCase(), t = url.searchParams.get('t') || '';
  const attendu = (await h.hmacHex(env, `vi-desab:${e}`)).slice(0, 24);
  const fr = true;
  let msg = 'Lien invalide. Écrivez-nous : nous vous retirons à la main. / Invalid link. Write to us and we will remove you.';
  if (e && t === attendu) {
    await env.COUNTERS.delete(`vi:suivi:${(await h.hmacHex(env, e)).slice(0, 20)}`);
    msg = 'C’est fait : vous ne recevrez plus le test mensuel. / Done: you will no longer receive the monthly test.';
  }
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payotte</title><body style="font-family:Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 16px;color:#211c1e"><h1 style="font-size:22px">Payotte</h1><p>${msg}</p><p><a href="https://payotte.com">payotte.com</a></p></body>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** Passage du cron : envoie le test mensuel aux abonnés échus. Budget de temps court. */
export async function passerSuivi(env, h, { budgetMs = 9000 } = {}) {
  const debut = Date.now();
  if (!env.RESEND_API_KEY || !env.COUNTERS) return { envoyes: 0 };
  if (env.SUBSCRIBERS && (await env.SUBSCRIBERS.get('stop:all'))) return { arrete: 'stop:all', envoyes: 0 };
  let envoyes = 0, cursor;
  do {
    const page = await env.COUNTERS.list({ prefix: 'vi:suivi:', cursor, limit: 1000 });
    for (const k of page.keys) {
      if (Date.now() - debut > budgetMs) return { envoyes, budget: true };
      if ((k.metadata?.p || 0) > Date.now()) continue;
      const a = JSON.parse((await env.COUNTERS.get(k.name)) || 'null');
      if (!a) continue;
      const o = await obtenirPresence(env, a.metier, a.secteur, a.lieu, a.lang !== 'en');
      if (o.erreur === 'quota') return { envoyes, quota: true };
      if (o.erreur) continue;
      if (await courrielSuivi(env, h, a, o.res, false)) envoyes++;
      await env.COUNTERS.put(k.name, JSON.stringify(a), { metadata: { p: Date.now() + 30 * 86400000 } });
      await h.bumpCounter(env, `vis:envois:${MOIS_RECH()}`, 400 * 86400);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { envoyes };
}

export async function handleStats(url, env, h) {
  if (!env.CONTACTS_TOKEN || url.searchParams.get('key') !== env.CONTACTS_TOKEN) return h.json({ error: 'forbidden' }, 403);
  const m = url.searchParams.get('mois') || MOIS_RECH();
  const lire = async (k) => parseInt((await env.COUNTERS.get(k)) || '0', 10);
  let abonnes = 0, cursor;
  do { const p = await env.COUNTERS.list({ prefix: 'vi:suivi:', cursor, limit: 1000 }); abonnes += p.keys.length; cursor = p.list_complete ? undefined : p.cursor; } while (cursor);
  return h.json({
    mois: m, rechercheGeminiMois: await lire(`vip:recherches-mois:${m}`), franchiseMois: 5000,
    rechercheAujourdhui: await lire(`vip:recherches:${new Date().toISOString().slice(0, 10)}`), plafondJour: 160,
    diagnosticsMois: await lire(`vip:diag:${m}`), suivisInscritsMois: await lire(`vis:inscrits:${m}`), suivisEnvoisMois: await lire(`vis:envois:${m}`), abonnesSuivi: abonnes,
    inscriptionsFormulaire: { aucun: await lire(`vi:insc:aucun:${m}`), fiche: await lire(`vi:insc:fiche:${m}`), premium: await lire(`vi:insc:premium:${m}`), pro: await lire(`vi:insc:pro:${m}`) },
  });
}
