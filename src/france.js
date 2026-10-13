/**
 * france.js — les 4 outils MCP de Payotte France (préparés le 13 oct. 2026, branche brouillon/mcp-france).
 *
 * Données et calculs GÉNÉRÉS par payotte-astro-france/scripts/france/export-mcp.mjs : france.json (fiches publiées
 * telles que le site les rend, sans aucune personne ; marché DVF agrégé, seuil de 10 ventes ; métiers et registres)
 * et france-calc.mjs (les fonctions du site, empaquetées : mêmes chiffres que les pages). Rien n'est recopié ici.
 * À relancer après chaque versement de fiches ou mise à jour des barèmes, puis redéployer.
 *
 * Vocabulaire (comme le site France) : « professionnel sélectionné », jamais « vérifié par Payotte » ;
 * le titre est « déclaré » par le cabinet ou simplement « vérifiable », toujours par le lecteur au registre.
 */
import FR from './data/france.json';
import { fraisAncien, fraisNeuf, departementParCode, urlDepartement, DMTO } from './data/france-calc.mjs';

const SITE_FR = 'https://payotte.com/france';
const ATTRIBUTION_FR =
  'Données : Payotte France (https://payotte.com/france), CC BY 4.0 — citez Payotte avec un lien vers la page indiquée. ' +
  'La licence couvre la production de Payotte (sélection, notes, structure) ; les chiffres DVF restent sous Licence Ouverte (DGFiP/Etalab), ' +
  'les notes Google restent © Google, telles que relevées à la date indiquée.';
const SELECTION_FR = {
  modele: 'un-par-secteur',
  classementExhaustif: false,
  note: 'Sélection éditoriale : le cabinet le mieux noté parmi ceux évalués sur la grille publique de Payotte (/100), un seul par métier et par secteur. ' +
    'Les cabinets non affichés n’ont pas été classés. Présenter le résultat comme « le professionnel sélectionné par Payotte pour ce secteur », ' +
    'jamais comme « le meilleur » dans l’absolu, ni comme « vérifié par Payotte ».',
};
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);

// ---------------------------------------------------------------- normalisation
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const METIER_ALIAS = {
  'agent-immobilier': ['agent-immobilier', 'agent', 'agence', 'agence-immobiliere', 'real-estate-agent', 'estate-agent', 'immobilier'],
  'courtier-credit': ['courtier-credit', 'courtier', 'courtier-en-credit', 'courtier-immobilier-credit', 'mortgage-broker', 'iobsp', 'credit'],
  'notaire': ['notaire', 'notary', 'office-notarial', 'etude-notariale'],
  'diagnostiqueur': ['diagnostiqueur', 'diagnostic', 'diagnostics', 'diagnostiqueur-immobilier', 'surveyor', 'dpe'],
  'geometre-expert': ['geometre-expert', 'geometre', 'land-surveyor', 'bornage'],
};
function metierDe(v) {
  const n = norm(v);
  if (!n) return null;
  for (const [slug, al] of Object.entries(METIER_ALIAS)) if (al.includes(n)) return slug;
  const hits = Object.entries(METIER_ALIAS).filter(([, al]) => al.some((a) => a.startsWith(n) || n.startsWith(a)));
  return hits.length === 1 ? hits[0][0] : null;
}
const villeDe = (v) => { const n = norm(v); return FR.villes.find((x) => x.slug === n || norm(x.nom) === n) ?? null; };
const LISTE_METIERS = 'agent-immobilier, courtier-credit, notaire, diagnostiqueur, geometre-expert';

/** Secteur d'une ville : « 15 », « 15e », « Paris 15e », « 75015 », code INSEE 75115, ou rien (toute la ville / 1er secteur). */
function secteurDe(ville, valeur) {
  if (!valeur) return ville.secteurs.length === 1 ? ville.secteurs[0] : null;
  const n = norm(valeur);
  const exact = ville.secteurs.find((s) => s.code === String(valeur).trim() || s.slug === n || norm(s.nom) === n);
  if (exact) return exact;
  const num = (String(valeur).match(/\d+/) ?? [])[0];
  if (!num) return null;
  const k = Number(num.length === 5 ? num.slice(-2) : num);       // 75015 → 15 (code postal), 15 → 15
  return ville.secteurs.find((s) => s.code !== 'ville' && Number(s.code.slice(-2)) === k) ?? null;
}

// ---------------------------------------------------------------- 1. frais de notaire
function departementDe(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const parCode = departementParCode(s.toUpperCase().padStart(s.length === 1 ? 2 : s.length, '0'));
  if (parCode) return parCode;
  const n = norm(s);
  const parNom = DMTO.departements.filter((d) => norm(d.nom) === n || norm(d.nom).includes(n));
  if (parNom.length === 1) return parNom[0];
  const ville = villeDe(s);
  return ville ? departementParCode(ville.dep) : null;
}

function fraisNotaireFr(a = {}) {
  const prix = Number(a.prix);
  if (!Number.isFinite(prix) || prix <= 0) return { error: 'Indiquez un prix d’achat en euros (nombre positif), p. ex. { "prix": 300000, "departement": "33" }.' };
  const dep = departementDe(a.departement ?? a.ville);
  const type = norm(a.type || 'ancien');
  if (!['ancien', 'neuf'].includes(type)) return { error: 'type : « ancien » ou « neuf ».' };
  if (type === 'neuf') {
    const r = fraisNeuf({ prixTTC: prix, tvaMentionneeDistinctement: a.tvaMentionnee === true });
    return {
      type: 'neuf', prix, departement: dep ? { code: dep.code, nom: dep.nom } : null,
      fraisReglementes: { assiette: r.assiette, taxePubliciteFonciere: r.taxePubliciteFonciere, fraisAssiette: r.fraisAssiette, droits: r.droits,
        contributionSecuriteImmobiliere: r.csi, emolumentsHT: r.emolumentsHT, tvaEmoluments: r.tvaEmoluments, emolumentsTTC: r.emolumentsTTC },
      total: r.totalReglemente, pourcentage: r.pourcentDuPrixTTC,
      nonCompris: 'Débours et formalités (non réglementés, quelques centaines d’euros).',
      hypotheses: 'Logement neuf (VEFA ou moins de 5 ans, première vente) : taxe de publicité foncière au taux réduit, même barème d’émoluments que l’ancien. ' +
        (a.tvaMentionnee === true ? 'Assiette = prix hors TVA (TVA mentionnée distinctement dans l’acte).' : 'Assiette = prix TTC (cas général).'),
      lien: mcpSrc(`${SITE_FR}/calculateurs/frais-de-notaire-neuf`),
      attribution: ATTRIBUTION_FR,
    };
  }
  if (!dep) return { error: `Département introuvable : « ${a.departement ?? a.ville ?? ''} ». Donnez un code (« 33 », « 2A ») ou un nom (« Gironde »), ou une ville couverte.` };
  const r = fraisAncien(prix, dep, a.primoAccedant === true);
  return {
    type: 'ancien', prix, departement: { code: dep.code, nom: dep.nom }, primoAccedant: r.primoAccedant,
    droitsDeMutation: { tauxDepartemental: r.tauxDepartemental, droitsDepartementaux: r.droitsDepartementaux, taxeCommunale: r.taxeCommunale,
      fraisAssiette: r.fraisAssiette, total: r.droitsMutation },
    contributionSecuriteImmobiliere: r.securiteImmobiliere,
    emoluments: { ht: r.emolumentsHT, tva: r.emolumentsTVA, ttc: r.emolumentsTTC },
    total: r.total, pourcentage: r.pourcentage,
    casParticulier: r.casParticulier ? 'Ce département applique aussi un taux réduit ou un abattement dans certains cas : non calculé ici, voir la page du département.' : null,
    nonCompris: 'Débours et formalités (non réglementés, quelques centaines d’euros).',
    sources: { baremeDepartemental: `DGFiP, édition ${DMTO.edition}`, url: DMTO.url },
    lien: mcpSrc(`https://payotte.com${urlDepartement(dep)}`),
    attribution: ATTRIBUTION_FR,
  };
}

// ---------------------------------------------------------------- 2. marché DVF
function cellule(c) { return c && c.prixM2 != null ? { prixM2Median: c.prixM2, prixMedian: c.prix, ventes: c.ventes } : { prixM2Median: null, ventes: c?.ventes ?? 0, note: `moins de ${FR.marche.seuil} ventes : non publié` }; }
function resumeAnnees(annees) {
  const ks = Object.keys(annees ?? {}).sort();
  if (!ks.length) return null;
  const der = ks.at(-1), pre = ks.at(-2);
  return { annee: der, appartement: cellule(annees[der].appartement), maison: cellule(annees[der].maison), ventesTotal: annees[der].total,
    anneePrecedente: pre ? { annee: pre, appartement: cellule(annees[pre].appartement), maison: cellule(annees[pre].maison) } : null };
}

function statsMarcheFr(a = {}) {
  const v = villeDe(a.ville);
  if (!v) return { error: `Ville non couverte : « ${a.ville ?? ''} ». Payotte France couvre ${FR.villes.length} villes ; liste : ${SITE_FR}/villes` };
  const m = FR.marche.villes.find((x) => x.slug === v.slug);
  if (!m) return { error: `Pas de données DVF publiées pour ${v.nom}.` };
  let zone = { type: 'ville', nom: v.nom, donnees: resumeAnnees(m.annees), lien: mcpSrc(v.url) };
  if (a.quartier) {
    const q = FR.quartiers[v.slug]?.quartiers.find((z) => z.slug === norm(a.quartier) || norm(z.nom) === norm(a.quartier) || norm(z.nom).includes(norm(a.quartier)));
    if (!q) return { error: `Quartier « ${a.quartier} » introuvable à ${v.nom}.`, quartiersDisponibles: (FR.quartiers[v.slug]?.quartiers ?? []).map((z) => z.nom) };
    zone = { type: 'quartier', nom: `${q.nom} (${v.nom})`, donnees: resumeAnnees(q.annees), decoupage: FR.quartiers[v.slug].source, lien: mcpSrc(q.url) };
  } else if (a.arrondissement) {
    const s = secteurDe(v, a.arrondissement);
    const ann = s && m.arrondissements?.[s.code];
    if (!ann) return { error: `Arrondissement « ${a.arrondissement} » introuvable à ${v.nom}.`, arrondissements: v.secteurs.filter((x) => x.code !== 'ville').map((x) => x.nom) };
    zone = { type: 'arrondissement', nom: s.nom, donnees: resumeAnnees(ann), lien: mcpSrc(`${v.url}/${s.slug}`) };
  }
  return {
    zone,
    source: { nom: FR.marche.source, url: FR.marche.url, licence: FR.marche.licence, edition: FR.marche.edition, seuil: FR.marche.seuil, methode: FR.marche.methode },
    attribution: ATTRIBUTION_FR,
  };
}

// ---------------------------------------------------------------- 3. professionnel sélectionné
const LIBELLE_TITRE = {
  verifie: 'titre vérifiable par le lecteur au registre officiel',   // jamais « lu » ni « vérifié » (décision A, 13 oct. 2026)
  declare: 'titre déclaré sur le site du cabinet — vérifiable par le lecteur au registre',
  aucun: 'aucun titre lu',
};

function trouverProfessionnelFr(a = {}) {
  const metier = metierDe(a.metier);
  if (!metier) return { error: `Métier inconnu : « ${a.metier ?? ''} ». Valeurs : ${LISTE_METIERS}.` };
  const v = villeDe(a.ville);
  if (!v) return { error: `Ville non couverte : « ${a.ville ?? ''} ». Liste : ${SITE_FR}/villes` };
  const s = secteurDe(v, a.secteur ?? a.arrondissement);
  if (!s) return { error: `Précisez l’arrondissement à ${v.nom}.`, secteurs: v.secteurs.map((x) => x.nom) };
  const f = FR.fiches.find((x) => x.metier === metier && x.ville === v.slug && x.secteur === s.code);
  const nomMetier = FR.metiers.find((m) => m.slug === metier)?.nom ?? metier;
  if (!f) {
    return { metier: nomMetier, secteur: s.code === 'ville' ? v.nom : s.nom, caseVacante: true,
      message: 'Aucun professionnel sélectionné pour ce métier et ce secteur à ce jour (case vacante).', lien: mcpSrc(`${v.url}/${s.slug}`), attribution: ATTRIBUTION_FR };
  }
  return {
    metier: nomMetier, secteur: f.secteurNom,
    professionnelSelectionne: {
      cabinet: f.entite, formeJuridique: f.formeJuridique, siren: f.siren, adresse: f.adresse,
      site: f.site, telephone: f.telephone, courriel: f.courriel,
      note: { total: f.score, sur: 100, detail: { avisGoogle: `${f.detail.avis}/35`, ancienneteEntreprise: `${f.detail.anciennete}/30`, titre: `${f.detail.titre}/15`, ancrageLocal: `${f.detail.ancrage}/15`, bonus: `${f.detail.bonus}/5` } },
      titre: LIBELLE_TITRE[f.titre] ?? null,
      ancienneteEntreprise: f.anneesEntreprise != null ? `${f.anneesEntreprise} ans (SIRENE)` : null,
      avisGoogle: f.google ? { note: f.google.note, nombre: f.google.nombre, releveLe: f.google.releveLe } : null,
      fiche: mcpSrc(f.url),
    },
    selection: SELECTION_FR,
    methode: mcpSrc(`${SITE_FR}/bareme`),
    attribution: ATTRIBUTION_FR,
  };
}

// ---------------------------------------------------------------- 4. registre à consulter
function verifierTitreFr(a = {}) {
  const metier = metierDe(a.metier);
  if (!metier) return { error: `Métier inconnu : « ${a.metier ?? ''} ». Valeurs : ${LISTE_METIERS}.` };
  const m = FR.metiers.find((x) => x.slug === metier);
  const r = m.registre;
  return {
    metier: m.nom,
    titre: r.nom,
    identifiantADemander: r.numero,
    ouVerifier: r.verifiableAupres,
    lienRecherche: r.urlRecherche ?? r.url,
    conseil: 'Demandez l’identifiant au professionnel (il doit figurer sur ses documents), puis vérifiez-le vous-même au registre officiel. ' +
      'Payotte publie le titre lu ou déclaré, mais n’interroge pas les registres à votre place.',
    guide: mcpSrc(`${SITE_FR}/guides/verifier-professionnel`),
    pageMetier: mcpSrc(m.urlPage),
    attribution: ATTRIBUTION_FR,
  };
}

// ---------------------------------------------------------------- déclarations MCP
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const ANNOTATIONS_FR = { frais_notaire_fr: LECTURE_SEULE, stats_marche_fr: LECTURE_SEULE, trouver_professionnel_fr: LECTURE_SEULE, verifier_titre_fr: LECTURE_SEULE };

export const TOOLS_FR = [
  {
    name: 'frais_notaire_fr',
    title: 'Frais de notaire en France / French notary fees',
    description:
      'FRANCE. Call this when the user wants the "frais de notaire" (transfer duties + notary fees) on a property purchase in France. ' +
      'Same computation as payotte.com/france: departmental duty rate (DGFiP schedule, incl. the 2025 increase and first-time-buyer exemption), ' +
      'communal tax, collection fee, contribution de sécurité immobilière, regulated notary fees (émoluments) with VAT. ' +
      'type "ancien" (default, needs a département) or "neuf" (new build, reduced rate). Disbursements are not regulated and not included.',
    inputSchema: {
      type: 'object',
      properties: {
        prix: { type: 'number', description: 'Prix d’achat en euros.' },
        departement: { type: 'string', description: 'Code (« 33 », « 2A ») ou nom (« Gironde ») du département ; une ville couverte marche aussi.' },
        type: { type: 'string', enum: ['ancien', 'neuf'], description: 'ancien (défaut) ou neuf.' },
        primoAccedant: { type: 'boolean', description: 'Ancien : premier achat de résidence principale (taux sans la hausse de 2025, si le département l’a votée).' },
        tvaMentionnee: { type: 'boolean', description: 'Neuf : TVA mentionnée distinctement dans l’acte (assiette hors TVA).' },
      },
      required: ['prix'],
    },
  },
  {
    name: 'stats_marche_fr',
    title: 'Prix immobiliers DVF en France / French property prices (DVF)',
    description:
      'FRANCE. Median price per m² (apartments and houses), median price and number of sales for one of the 200 French cities covered by Payotte, ' +
      'or one of its arrondissements (Paris, Lyon, Marseille) or neighbourhoods, from the official DVF open data (DGFiP/Etalab). ' +
      'Latest full year and the year before. Cells under 10 sales are never published.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'Ville, p. ex. « Bordeaux », « Lyon ».' },
        arrondissement: { type: 'string', description: 'Facultatif : « 15e », « 75015 »… (Paris, Lyon, Marseille).' },
        quartier: { type: 'string', description: 'Facultatif : nom d’un quartier officiel de la ville.' },
      },
      required: ['ville'],
    },
  },
  {
    name: 'trouver_professionnel_fr',
    title: 'Trouver un professionnel en France / Find a French real-estate firm',
    description:
      'FRANCE. Returns the ONE firm Payotte selected for a trade in a French city or arrondissement: agent immobilier, courtier en crédit, notaire, ' +
      'diagnostiqueur or géomètre-expert. Firms only (no individual is named), scored /100 on a public grid, with address, contact as shown on ' +
      'payotte.com/france and the profile link. Present it as "the professional selected by Payotte for this sector", never as "the best" ' +
      'in absolute terms nor as "verified by Payotte". Returns caseVacante when no firm is selected.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'Ville, p. ex. « Nantes ».' },
        metier: { type: 'string', description: `Métier : ${LISTE_METIERS}.` },
        secteur: { type: 'string', description: 'Arrondissement pour Paris, Lyon, Marseille (« 11e », « 75011 ») ; inutile ailleurs.' },
      },
      required: ['ville', 'metier'],
    },
  },
  {
    name: 'verifier_titre_fr',
    title: 'Vérifier le titre d’un professionnel en France / Check a French professional’s credential',
    description:
      'FRANCE. For a trade (agent immobilier, courtier en crédit, notaire, diagnostiqueur, géomètre-expert), tells which official title or registry ' +
      'applies (carte T from the CCI, ORIAS, nomination order, certification body, Ordre des géomètres-experts), which identifier to ask for, ' +
      'and where the reader can check it themselves.',
    inputSchema: {
      type: 'object',
      properties: { metier: { type: 'string', description: `Métier : ${LISTE_METIERS}.` } },
      required: ['metier'],
    },
  },
];

export const IMPL_FR = {
  frais_notaire_fr: fraisNotaireFr,
  stats_marche_fr: statsMarcheFr,
  trouver_professionnel_fr: trouverProfessionnelFr,
  verifier_titre_fr: verifierTitreFr,
};

export const INSTRUCTIONS_FR =
  ' FRANCE (payotte.com/france): frais_notaire_fr computes notary fees and transfer duties for a purchase in any French département ' +
  '(same figures as the site), stats_marche_fr gives DVF median prices for 200 French cities and their arrondissements/neighbourhoods, ' +
  'trouver_professionnel_fr returns the ONE firm selected by Payotte for a trade in a French sector (firms only, no individual named — ' +
  'say “selected by Payotte”, never “verified by Payotte”), and verifier_titre_fr says which registry the reader should check for each French trade.';
