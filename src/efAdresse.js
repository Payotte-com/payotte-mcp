/**
 * efAdresse.js — la réponse immédiate du bandeau d'évaluation foncière (29 sept. 2026).
 *
 * On tape une adresse, on reçoit en une seconde :
 *   1. sa valeur au rôle, sa hausse, et où elle se situe parmi les propriétés SEMBLABLES de la
 *      municipalité (même type, même époque de construction, même taille) — la question
 *      « mon évaluation est-elle trop haute ? » ;
 *   2. un ORDRE DE GRANDEUR de la valeur, seulement là où une source officielle le permet
 *      (facteur comparatif du MAMH au Québec, ventes réelles en N.-É. et au N.-B.) — sinon rien ;
 *   3. la date limite pour contester.
 *
 * Aucune opinion de valeur : des comparaisons de chiffres publics, avec leurs dates. Le mot
 * « évaluation » reste au rôle et à l'évaluateur agréé ; l'ordre de grandeur n'est jamais appelé
 * « estimation » ni « évaluation » (Code des professions, art. 36 j) : le TITRE est réservé).
 *
 * Données : ef-donnees/ (binding ASSETS, run_worker_first : jamais servies en vrac au public),
 * construites par scripts/construire-ef-donnees.mjs. Aucune donnée personnelle (voir SPEC.md).
 * Anti-moissonnage : 150 recherches par jour et par adresse IP (empreinte HMAC, jamais l'IP).
 */

export const USAGES = ['detache', 'jumele', 'rangee', 'condo', 'plex', 'autre'];
export const SEUIL_GROUPE = 30;
const QUANT = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
const PLAFOND_IP = 150;
export const PROVINCES_EF = {
  qc: { code: 'QC', nom: { fr: 'Québec', en: 'Quebec' }, slug: 'quebec' },
  ns: { code: 'NS', nom: { fr: 'Nouvelle-Écosse', en: 'Nova Scotia' }, slug: 'nova-scotia' },
  nb: { code: 'NB', nom: { fr: 'Nouveau-Brunswick', en: 'New Brunswick' }, slug: 'new-brunswick' },
  ab: { code: 'AB', nom: { fr: 'Alberta', en: 'Alberta' }, slug: 'alberta' },
  mb: { code: 'MB', nom: { fr: 'Manitoba', en: 'Manitoba' }, slug: 'manitoba' },
};
export const PROV_DE_SLUG = Object.fromEntries(Object.entries(PROVINCES_EF).map(([k, v]) => [v.slug, k]));

// Normalisation : IDENTIQUE à normRue de extraire-*.mjs (minuscules, sans accents, ponctuation → espace).
export const normRue = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Types de voie et directions ignorés dans la requête (FR et EN) — la donnée les a déjà retirés de rueNorm.
const BRUIT = new Set(('rue r avenue av ave boulevard boul blvd bd chemin ch route rte rang place pl terrasse croissant cres ' +
  'crescent impasse allee carre promenade montee cote street st road rd drive dr court ct lane ln way terrace close ' +
  'circle cir trail trl parkway pkwy highway hwy grove gate green heights hts point pt row square sq landing mews ' +
  'n s e w o ne nw se sw no so nord sud est ouest north south east west de du des la le les d l appt app apt unit unite suite ' +
  'ville city qc quebec ns nb ab mb').split(' '));

/** Les groupes d'une unité, du plus précis au plus large. Même fonction à la construction et à la lecture. */
export function groupe(u) {
  const dec = !u.annee ? 'x' : u.annee < 1950 ? 'a' : u.annee < 1970 ? 'b' : u.annee < 1990 ? 'c' : u.annee < 2010 ? 'd' : 'e';
  const a = u.aireM2;
  const t = !a ? 'x' : u.usage === 'condo'
    ? (a < 60 ? '1' : a < 90 ? '2' : a < 130 ? '3' : '4')
    : (a < 100 ? '1' : a < 140 ? '2' : a < 190 ? '3' : a < 260 ? '4' : '5');
  // Dernier repli : toutes les propriétés résidentielles de la municipalité (le libellé le dit).
  return [`${u.usage}|${dec}|${t}`, `${u.usage}|*|${t}`, `${u.usage}|${dec}|*`, `${u.usage}|*|*`, 'tous|*|*'];
}

/** Rang approximatif (0-100) d'une valeur dans une distribution décrite par ses quantiles 5-95. */
function rang(q, x) {
  if (!q) return null;
  if (x <= q[0]) return 3;
  if (x >= q[q.length - 1]) return 97;
  for (let i = 1; i < q.length; i++) {
    if (x <= q[i]) return Math.round(QUANT[i - 1] + (QUANT[i] - QUANT[i - 1]) * ((x - q[i - 1]) / ((q[i] - q[i - 1]) || 1)));
  }
  return 97;
}
const med = (q) => (q ? q[9] : null);

const LIB = {
  fr: {
    usages: { detache: 'maisons détachées', jumele: 'maisons jumelées', rangee: 'maisons en rangée', condo: 'condos', plex: 'plex (2 à 5 logements)', autre: 'propriétés résidentielles', tous: 'propriétés résidentielles de tous types' },
    usage1: { detache: 'Maison détachée', jumele: 'Maison jumelée', rangee: 'Maison en rangée', condo: 'Condo', plex: 'Plex', autre: 'Résidentiel' },
    dec: { a: 'construites avant 1950', b: 'construites de 1950 à 1969', c: 'construites de 1970 à 1989', d: 'construites de 1990 à 2009', e: 'construites depuis 2010' },
    aire: { condo: { 1: 'de moins de 60 m²', 2: 'de 60 à 90 m²', 3: 'de 90 à 130 m²', 4: 'de plus de 130 m²' },
      autre: { 1: 'de moins de 100 m²', 2: 'de 100 à 140 m²', 3: 'de 140 à 190 m²', 4: 'de 190 à 260 m²', 5: 'de plus de 260 m²' } },
  },
  en: {
    usages: { detache: 'detached houses', jumele: 'semi-detached houses', rangee: 'row houses', condo: 'condos', plex: 'plexes (2–5 units)', autre: 'residential properties', tous: 'residential properties of all types' },
    usage1: { detache: 'Detached house', jumele: 'Semi-detached', rangee: 'Row house', condo: 'Condo', plex: 'Plex', autre: 'Residential' },
    dec: { a: 'built before 1950', b: 'built 1950–1969', c: 'built 1970–1989', d: 'built 1990–2009', e: 'built since 2010' },
    aire: { condo: { 1: 'under 60 m²', 2: '60–90 m²', 3: '90–130 m²', 4: 'over 130 m²' },
      autre: { 1: 'under 100 m²', 2: '100–140 m²', 3: '140–190 m²', 4: '190–260 m²', 5: 'over 260 m²' } },
  },
};
function libelleGroupe(k, lang) {
  const L = LIB[lang];
  const [us, dec, t] = k.split('|');
  const parts = [L.usages[us]];
  if (dec !== '*' && dec !== 'x') parts.push(L.dec[dec]);
  if (t !== '*' && t !== 'x') parts.push((us === 'condo' ? L.aire.condo : L.aire.autre)[t]);
  return parts.join(', ');
}

async function lireActif(env, chemin) {
  const r = await env.ASSETS.fetch(new Request(`https://ef.local/${chemin}`));
  if (!r.ok) return null;
  return r.json();
}

/** Liste des municipalités d'une province (pour le champ du bandeau). */
export async function efMunis(env, prov) {
  if (!PROVINCES_EF[prov] || !env.ASSETS) return null;
  const idx = await lireActif(env, `${prov}/index.json`);
  return idx ? idx.map(([code, nom]) => [code, nom]) : null;
}

/** Découpe la requête : numéro civique, suffixe, mots de la voie, logement éventuel. */
export function analyser(q, prov = 'qc') {
  const s = String(q ?? '').trim();
  const m = s.match(/^\s*(?:(\d+[A-Za-z]?)\s*[-–]\s*)?(\d+)\s*([A-Za-z]|1\/2)?\b[\s,]*(.*)$/);
  if (!m) return null;
  let apt = m[1] ? m[1] : null;                        // « 305-1200 rue X » : logement 305
  let reste = m[4];
  const a = reste.match(/(?:app\.?|appt\.?|apt\.?|unit[ée]?|suite|#)\s*([0-9A-Za-z-]+)/i);
  if (a) { apt = a[1]; reste = reste.replace(a[0], ' '); }
  // Au Québec, « St-Laurent » veut dire Saint ; ailleurs, « St » est d'abord « Street » (donc du bruit).
  const ABR = prov === 'qc' ? { st: 'saint', ste: 'sainte', mt: 'mont' } : { ste: 'sainte' };
  const mots = normRue(reste).split(' ').map((w) => ABR[w] ?? w).filter((w) => w && !BRUIT.has(w));
  return { num: Number(m[2]), suffixe: m[3] ? m[3].toUpperCase() : null, mots, apt: apt ? String(apt).toUpperCase() : null };
}

function score(ligne, req) {
  const rn = ligne[4];
  if (!req.mots.length) return 0.5;
  const toks = rn.split(' ');
  const va = (w, t) => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t));
  let ok = 0;
  for (const w of req.mots) if (toks.some((t) => va(w, t))) ok++;
  const couverts = toks.filter((t) => req.mots.some((w) => va(w, t))).length / toks.length;
  return ok / req.mots.length + 0.05 * couverts;     // à égalité, la rue dont le nom est le mieux couvert
}

/** Recherche + réponse. `deps` : { hmacHex, bumpCounter, feed } du worker. */
export async function efAdresse(env, url, request, deps) {
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'fr';
  const prov = String(url.searchParams.get('prov') ?? '');
  const muni = String(url.searchParams.get('muni') ?? '');
  if (!PROVINCES_EF[prov]) return { error: lang === 'fr' ? 'Province non couverte.' : 'Province not covered.' };
  if (!env.ASSETS) return { error: 'no-data' };

  // Anti-moissonnage (compteur par empreinte d'IP, jamais l'IP en clair).
  const ip = request.headers.get('cf-connecting-ip') || 'x';
  const jour = new Date().toISOString().slice(0, 10);
  const n = await deps.bumpCounter(env, `efa:${(await deps.hmacHex(env, ip)).slice(0, 16)}:${jour}`, 2 * 86400);
  if (n > PLAFOND_IP) return { error: lang === 'fr' ? 'Limite de recherches atteinte pour aujourd’hui.' : 'Daily search limit reached.' };

  const req = analyser(url.searchParams.get('q'), prov);
  if (!req) return { error: lang === 'fr' ? 'Commencez par le numéro civique (ex. 1234 rue Principale).' : 'Start with the street number (e.g. 1234 Main St).' };
  const idx = await lireActif(env, `${prov}/index.json`);
  const M = idx?.find((x) => x[0] === muni);
  if (!M) return { error: lang === 'fr' ? 'Choisissez la municipalité dans la liste.' : 'Pick the municipality from the list.' };
  const [code, muniNom, nT, dateValeurMuni, facteur, dateFacteur] = M;
  const dossier = `${prov}/${code.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const [tranche, stats] = await Promise.all([lireActif(env, `${dossier}/${req.num % nT}.json`), lireActif(env, `${dossier}/stats.json`)]);

  const auNumero = (tranche ?? []).filter((l) => l[0] === req.num || (l[1] && req.num >= l[0] && req.num <= l[1]));
  let cand = auNumero
    .map((l) => ({ l, s: score(l, req) + (req.suffixe && l[2] === req.suffixe ? 0.1 : 0) + (req.apt && l[5] === req.apt ? 0.2 : 0) }))
    .filter((c) => c.s >= 0.5)
    .sort((a, b) => b.s - a.s);
  // Rue mal orthographiée : plutôt qu'un « introuvable », les rues qui existent à ce numéro.
  if (!cand.length && auNumero.length) {
    const vues = new Set();
    const choix = auNumero.filter((l) => !vues.has(l[3]) && vues.add(l[3])).slice(0, 12);
    return { resultats: [], suggestions: choix.map((l) => `${req.num} ${l[3]}`), note: lang === 'fr' ? `Rue introuvable au ${req.num} à ${muniNom}. Vouliez-vous dire :` : `Street not found at ${req.num} in ${muniNom}. Did you mean:` };
  }
  if (!cand.length) return { resultats: [], note: lang === 'fr' ? `Aucune adresse résidentielle trouvée au ${req.num} à ${muniNom}. Vérifiez le nom de la rue, ou la municipalité (une ancienne ville fusionnée porte souvent le nom de la nouvelle).` : `No residential address found at ${req.num} in ${muniNom}. Check the street name or the municipality.` };
  // Un immeuble de condos : si le logement n'est pas précisé, on demande de choisir.
  const top = cand[0].s;
  cand = cand.filter((c) => c.s >= top - 0.01).slice(0, 40);

  // Condos sans numéro de logement dans la source (N.-É.) : toutes les unités, triées par valeur,
  // pour qu'on reconnaisse la sienne d'après la valeur de son avis.
  const sansApt = cand.every((c) => !c.l[5]);
  const max = sansApt ? 40 : 12;
  if (sansApt) cand.sort((a, b) => b.l[9] - a.l[9]);
  const resultats = cand.slice(0, max).map(({ l }) => repondre(l, { prov, code, muniNom, dateValeurMuni, facteur, dateFacteur, stats, lang }));
  return { resultats, sansApt, plus: cand.length > max ? cand.length - max : 0, delai: await delai(prov, code, lang, deps), source: SOURCES[prov] };
}

function repondre(l, { prov, muniNom, dateValeurMuni, facteur, dateFacteur, stats, lang }) {
  const [num, numSup, suffixe, rue, , apt, iu, annee, aireM2, valeur, valeurAnt, dv] = l;
  const usage = USAGES[iu];
  const u = { usage, annee: annee || null, aireM2: aireM2 || null };
  const dateValeur = dv || dateValeurMuni;
  const cles = groupe(u);
  const k = cles.find((c) => stats?.groupes?.[c]);
  const g = k ? stats.groupes[k] : null;
  const hausse = valeurAnt ? valeur / valeurAnt : null;
  const m2 = aireM2 ? valeur / aireM2 : null;
  const rH = g && hausse ? rang(g.hausse, hausse) : null;
  const rM = g && m2 ? rang(g.m2, m2) : null;
  const rV = g && !m2 ? rang(g.valeur, valeur) : null;
  // Signal : le PLUS HAUT des rangs disponibles (m² d'abord, sinon la valeur brute), croisé avec la hausse.
  const principal = rM ?? rV;
  const signal = principal == null ? null : (principal >= 80 || (principal >= 65 && (rH ?? 0) >= 80)) ? 'eleve' : principal >= 60 ? 'au-dessus' : 'norme';

  // Ordre de grandeur de la valeur de marché, seulement avec une source officielle.
  let ordre = null;
  const vs = stats?.ventes?.[usage] ?? stats?.ventes?.tous;
  if (vs) {
    ordre = { methode: 'ventes', valeur: arrondir(valeur * med(vs.q)), bas: arrondir(valeur * vs.q[4]), haut: arrondir(valeur * vs.q[14]), n: vs.n, periode: vs.periode };
  } else if (prov === 'qc' && facteur && dateFacteur && facteur > 0.5 && facteur < 2.5) {
    ordre = { methode: 'facteur', valeur: arrondir(valeur * facteur), facteur, date: dateFacteur };
  }

  return {
    adresse: [num + (numSup ? `-${numSup}` : '') + (suffixe || ''), rue].join(' ') + (apt ? (lang === 'fr' ? `, app. ${apt}` : `, unit ${apt}`) : ''),
    municipalite: muniNom,
    type: LIB[lang].usage1[usage], usage, annee: annee || null, aireM2: aireM2 || null,
    valeur, valeurAnt: valeurAnt || null, dateValeur, dateValeurAnt: stats?.dateValeurAnt ?? null,
    hausse: hausse ? Math.round((hausse - 1) * 1000) / 10 : null,
    comparables: g ? {
      groupe: libelleGroupe(k, lang), n: g.n,
      hausseMediane: g.hausse ? Math.round((med(g.hausse) - 1) * 1000) / 10 : null, rangHausse: rH,
      m2Median: g.m2 ? Math.round(med(g.m2)) : null, m2: m2 ? Math.round(m2) : null, rangM2: rM,
      valeurMediane: Math.round(med(g.valeur)), rangValeur: rV,
    } : null,
    signal, ordre,
  };
}
const arrondir = (x) => Math.round(x / 5000) * 5000;

// Mentions exigées par chaque licence, mot pour mot (voir unites/<prov>-SOURCE.md).
const SOURCES = {
  qc: { nom: 'Rôles d’évaluation foncière du Québec, MAMH (Données Québec, CC BY 4.0)', url: 'https://www.donneesquebec.ca/recherche/dataset/roles-d-evaluation-fonciere-du-quebec' },
  ns: { nom: 'PVSC — Contains information licensed under the Open Data & Information Government Licence – PVSC & Participating Municipalities', url: 'https://www.thedatazone.ca/' },
  nb: { nom: 'Contains information licenced under the GeoNB Open Data Licence (Service New Brunswick)', url: 'https://geonb.snb.ca/documents/license/geonb-odl_en.pdf' },
  ab: { nom: 'Contains information licensed under the Open Government Licence – City of Calgary / City of Edmonton / Strathcona County; City of Lethbridge Open Data', url: 'https://data.calgary.ca/' },
  mb: { nom: 'City of Winnipeg — Contains information licensed under the Open Government Licence – Canada', url: 'https://data.winnipeg.ca/Assessment-Taxation-Corporate/Assessment-Parcels/d4mq-wa44' },
};

async function delai(prov, code, lang, deps) {
  try {
    if (prov === 'qc') {
      const d = await deps.feed('/api/evaluation-fonciere-quebec.json');
      const m = d.municipalites.find((x) => x.code === code);
      if (!m) return null;
      const auj = new Date().toISOString().slice(0, 10);
      const ouvert = auj <= m.echeanceRoleActuel;
      const date = ouvert ? m.echeanceRoleActuel : m.echeanceProchainRole;
      return {
        ouvert, date,
        texte: lang === 'fr'
          ? (ouvert ? `La fenêtre de révision est ouverte : demande à déposer au plus tard le ${date}.` : `La fenêtre du rôle ${m.premierExercice}-${m.dernierExercice} est fermée. Le prochain rôle entre en vigueur en ${m.prochainRole} ; date limite générale : ${date}. Une modification en cours de rôle (rénovation, erreur) rouvre un délai.`)
          : (ouvert ? `The review window is open: file by ${date}.` : `The ${m.premierExercice}-${m.dernierExercice} roll window is closed. The next roll takes effect in ${m.prochainRole}; general deadline: ${date}. A mid-roll amendment reopens a window.`),
        lien: lang === 'fr' ? 'https://payotte.com/evaluation-fonciere/calendrier-quebec' : 'https://payotte.com/en/property-assessment/quebec-review-deadlines',
      };
    }
    const d = await deps.feed('/api/evaluation-fonciere-canada.json');
    const p = d.provinces.find((x) => x.code === PROVINCES_EF[prov].code);
    return p ? { texte: p.rules.delai[lang], lien: p.hub[lang] } : null;
  } catch { return null; }
}
