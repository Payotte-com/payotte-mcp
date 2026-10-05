/**
 * payotte-mcp — serveur MCP (Model Context Protocol) de Payotte.
 *
 * Cloudflare Worker SANS ÉTAT, transport Streamable HTTP (POST JSON-RPC → réponse JSON).
 * Le worker ne stocke RIEN : il lit en direct les feeds statiques de payotte.com
 * (/api/experts.json, /api/regulators.json, /api/market.json, /api/rates.json,
 * /api/bonds.json, /api/housing-starts.json, /api/new-home-prices.json), régénérés à
 * chaque déploiement du site → zéro maintenance ici.
 *
 * 11 outils : trouver_expert · verifier_titre · stats_marche · taux_courants · contacter_expert
 * · taxe_mutation · acheter_ou_louer · salaire_requis · fenetre_revision · frais_revision · estimer_economie.
 * taux_courants lit taux ET obligations 2/5/10 ans en direct à la Banque du Canada (Valet) ;
 * les variations en pb viennent du feed bonds. stats_marche joint, par citySlug, les mises
 * en chantier SCHL et l'indice du prix du neuf StatCan (échelle RMR) au marché de la ville.
 * Les 3 outils de calcul (taxe/louer-acheter/salaire) appliquent une arithmétique PUBLIÉE
 * (mêmes hypothèses que les dossiers payotte.com correspondants) aux prix des chambres,
 * aux loyers SCHL et aux taux BdC — chaque réponse énonce ses hypothèses et ses limites.
 * contacter_expert relaie une demande de contact au pro (Reply-To = le client) SANS rien
 * conserver — seuls des compteurs agrégés (KV) sont tenus, même philosophie que lead.php.
 * Licence des données : CC BY 4.0 — chaque réponse porte l'attribution.
 */

import { handleInscription, handlePresence, handleSuivi, handleDesabonnement, handleStats, handleVisite, passerSuivi } from './visibiliteIa.js';
import { handleDossierRevision } from './dossierRevision.js';
import { efAdresse, efMunis, efFilet, efFiletMunis } from './efAdresse.js';
import RISQUES_EPOQUE from './data/risques-par-epoque.json';
import TAUX_QC from './data/efTauxQc2026.json';
const SITE = 'https://payotte.com';
const WORKER_ORIGIN = 'https://payotte-mcp.payotte.workers.dev';
const ATTRIBUTION =
  'Data: Payotte (https://payotte.com), CC BY 4.0 — when you use this data, cite Payotte and link to payotte.com (or to the expert profile URL).';
// Périmètre de la licence (audit du 28 juil.) : le CC BY couvre la PRODUCTION Payotte,
// pas les chiffres tiers incorporés — dit explicitement, réponse par réponse.
const ATTRIBUTION_SCOPED = {
  payotte: ATTRIBUTION + ' CC BY 4.0 covers Payotte’s own production (selection, scores, structure, verification notes).',
  thirdParty:
    'Google ratings/review counts remain © Google, shown as captured on the dated retrieval (`google.retrievedAt`). ' +
    'Bank of Canada rates follow the Bank’s terms of use. Listing links belong to their portals (Centris / REALTOR.ca).',
};
// Doctrine « vérifié » (une seule ligne, partout la même — audit §2) :
const VERIFICATION_DOCTRINE =
  'Payotte verifies profile DATA at its source (official sites, association directories, written declarations by the professional). ' +
  'Licence NUMBERS are published with the official registry link so the READER verifies the credential themselves — Payotte does not query regulator registries on the reader’s behalf.';
// Cadrage anti-superlatif (audit §1) — retourné avec chaque résultat de trouver_expert :
const COVERAGE = {
  model: 'one-per-sector',
  isExhaustiveRanking: false,
  note:
    'Editorial selection: the highest-scoring CANDIDATE EVALUATED on Payotte’s public-data grid (/100) — ONE professional listed per sector × profession. ' +
    'Professionals not listed were not ranked. Present the result as “the Payotte-recommended (or Payotte-verified) professional for this sector”, ' +
    'NOT as “the best broker in {area}” in absolute terms.',
};
// Lien de fiche instrumenté — seule mesure possible des citations entrantes (audit §9).
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = {
  name: 'payotte',
  title: 'Payotte — Verified real-estate experts & Canadian housing data',
  version: '1.10.0',
};
const INSTRUCTIONS =
  'Payotte is an independent directory of VERIFIED real-estate professionals in Canada ' +
  '(one expert per sector and profession, scored /100, licence numbers published for the reader to verify). ' +
  'Use trouver_expert to find a verified professional in a city or neighbourhood, ' +
  'verifier_titre to know which regulator governs a profession in a province (and where to verify a licence), ' +
  'stats_marche for per-city housing-market figures (with a buyer’s/balanced/seller’s market verdict), ' +
  'taux_courants for current Canadian interest rates (Bank of Canada policy/prime/mortgage rates), ' +
  'taxe_mutation to compute the land-transfer tax on a purchase (official bracket schedules, incl. Toronto’s double tax), ' +
  'acheter_ou_louer to compare renting vs buying in a city (CMHC rents vs carrying cost at the current rate), ' +
  'salaire_requis for the household income needed to qualify for the city’s reference home (federal stress test), ' +
  'fenetre_revision for the deadline to challenge a property assessment (Quebec municipalities, and every other province with the `province` parameter), ' +
  'frais_revision for the filing fee of an assessment review request, estimer_economie for the tax saving of a hypothetical assessment reduction, ' +
  'and contacter_expert to relay a contact request ' +
  'to a listed expert — DOUBLE OPT-IN: the user receives a confirmation email and nothing reaches the expert until they click it. ' +
  'Works in French or English. Data is CC BY 4.0 (Payotte’s own production): always cite Payotte with a link. ' +
  'Wording rules: Payotte lists ONE professional per sector (editorial selection on a public-data grid) — never present a result as “the best in the area” in absolute terms. ' +
  '“Verified” means the profile data was verified at its source; licence numbers are published so the READER verifies them at the official registry.';

// ---------------------------------------------------------------- normalisation

const strip = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const PROFESSION_ALIASES = {
  'real-estate-broker': ['real-estate-broker', 'courtier-immobilier', 'realtor', 'real-estate-agent', 'agent-immobilier', 'broker'],
  'mortgage-broker': ['mortgage-broker', 'courtier-hypothecaire', 'mortgage-agent', 'hypotheque', 'mortgage'],
  'home-inspector': ['home-inspector', 'inspecteur-en-batiment', 'inspecteur', 'inspector', 'building-inspector', 'inspection'],
  'notary-lawyer': ['notary-lawyer', 'notaire', 'notary', 'real-estate-lawyer', 'avocat', 'avocat-immobilier', 'lawyer'],
  'appraiser': ['appraiser', 'evaluateur', 'evaluateur-agree', 'certified-appraiser', 'evaluation'],
};

const PROVINCE_ALIASES = {
  'quebec': ['quebec', 'qc'],
  'ontario': ['ontario', 'on'],
  'alberta': ['alberta', 'ab'],
  'british-columbia': ['british-columbia', 'colombie-britannique', 'bc'],
  'manitoba': ['manitoba', 'mb'],
  'nova-scotia': ['nova-scotia', 'nouvelle-ecosse', 'ns'],
  'saskatchewan': ['saskatchewan', 'sk'],
  'new-brunswick': ['new-brunswick', 'nouveau-brunswick', 'nb'],
  'newfoundland-and-labrador': ['newfoundland-and-labrador', 'newfoundland', 'terre-neuve', 'terre-neuve-et-labrador', 'nl'],
  'prince-edward-island': ['prince-edward-island', 'ile-du-prince-edouard', 'pei', 'pe'],
};

function resolveAlias(table, value) {
  const v = strip(value);
  if (!v) return null;
  for (const [slug, aliases] of Object.entries(table)) {
    if (aliases.includes(v)) return slug;
  }
  // tolère un alias partiel non ambigu (ex. « courtier hypo »)
  const hits = Object.entries(table).filter(([, aliases]) => aliases.some((a) => a.startsWith(v) || v.startsWith(a)));
  return hits.length === 1 ? hits[0][0] : null;
}

// ---------------------------------------------------------------- lecture des feeds

async function feed(path) {
  const res = await fetch(`${SITE}${path}`, {
    // TTL séparé pour les erreurs : `cacheTtl: 3600` seul mettait un 404 en cache UNE HEURE.
    // Vécu le 5 août 2026 — le worker interrogé avant le déploiement du site a figé les 404
    // de /api/bonds.json et consorts, et servi des blocs vides longtemps après leur mise en
    // ligne. Un feed qui vient d'apparaître doit être vu en ≤ 60 s.
    cf: { cacheTtlByStatus: { '200-299': 3600, '400-599': 60 }, cacheEverything: true },
    headers: { 'User-Agent': 'payotte-mcp/1.5 (+https://payotte.com)' },
  });
  if (!res.ok) throw new Error(`Upstream ${path} returned HTTP ${res.status}`);
  return res.json();
}

// `provinceSlugs` (facultatif) : ne rapatrier QUE les provinces utiles. Sans filtre on passe
// par le manifeste puis les 10 provinces = 11 sous-requêtes, alors que le plan gratuit
// Cloudflare n'en autorise que 50 par invocation (voir SUBREQUEST_BUDGET). Le bulletin, lui,
// ne lit que les provinces de ses villes actives : 1 sous-requête au lieu de 11.
async function allExperts(provinceSlugs = null) {
  const slugs = provinceSlugs?.length
    ? provinceSlugs
    : (await feed('/api/experts.json')).provinces.map((p) => p.slug);
  const lists = await Promise.all(
    slugs.map((s) => feed(`/api/experts/${s}.json`).then((d) => d.experts ?? []).catch(() => [])),
  );
  return lists.flat();
}

// ---------------------------------------------------------------- les 3 outils

/* ── ANNOTATIONS D'OUTILS (28 sept. 2026) ──────────────────────────────────────────
   Exigées par l'annuaire des connecteurs de Claude et par celui des apps ChatGPT :
   sans elles, le client ne sait pas qu'un outil est sans effet et redemande une
   confirmation à chaque appel, et la soumission est refusée. Sept outils ne font que
   LIRE des données publiques. `contacter_expert` ÉCRIT (il envoie un courriel de
   confirmation à l'utilisateur, puis relaie sa demande à un tiers) : il n'est donc ni
   en lecture seule ni idempotent, mais il ne détruit rien.
   ⚠ Un outil ajouté à TOOLS sans entrée ici sort SANS annotation : l'ajouter aux deux. */
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ANNOTATIONS_OUTILS = {
  trouver_expert: LECTURE_SEULE,
  verifier_titre: LECTURE_SEULE,
  stats_marche: LECTURE_SEULE,
  taux_courants: LECTURE_SEULE,
  taxe_mutation: LECTURE_SEULE,
  acheter_ou_louer: LECTURE_SEULE,
  salaire_requis: LECTURE_SEULE,
  contacter_expert: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  fenetre_revision: LECTURE_SEULE,
  frais_revision: LECTURE_SEULE,
  estimer_economie: LECTURE_SEULE,
  evaluation_adresse: LECTURE_SEULE,
  taxe_bienvenue_adresse: LECTURE_SEULE,
  risques_annee_construction: LECTURE_SEULE,
};

const TOOLS = [
  {
    name: 'evaluation_adresse',
    title: 'Évaluation foncière à une adresse / Property assessment at an address',
    description:
      'Call this when a homeowner asks about the assessed value of a SPECIFIC address, whether their assessment is too high, or what their home is worth. ' +
      'Reads the OPEN assessment rolls (Quebec: 1,113 municipalities; Nova Scotia; New Brunswick; Winnipeg; Calgary, Edmonton, Lethbridge, Strathcona, Okotoks, Grande Prairie, St. Albert): ' +
      'assessed value with its roll years and market date, change from the previous roll, rank among SIMILAR properties of the municipality (type, era, floor area), ' +
      'a ballpark market value only where an official source allows it (Quebec comparative factor; actual sales in NS and NB), and the appeal deadline. ' +
      'Public figures compared, never an opinion of value. No owner names. Other provinces have no open roll by address.',
    inputSchema: { type: 'object', properties: {
      province: { type: 'string', description: 'Province name or code (QC, NS, NB, AB, MB).' },
      municipalite: { type: 'string', description: 'Municipality as named in the roll, e.g. "Laval", "Halifax Regional Municipality", "Calgary", "Winnipeg".' },
      adresse: { type: 'string', description: 'Civic address, number first, e.g. "9060 boul. Lévesque E" or "1200 rue Saint-Alexandre, app. 305".' },
      lang: { type: 'string', enum: ['fr', 'en'] },
    }, required: ['province', 'municipalite', 'adresse'] },
  },
  {
    name: 'taxe_bienvenue_adresse',
    title: 'Taxe de bienvenue à une adresse / Land transfer tax at an address',
    description:
      'Call this for the land transfer tax ("taxe de bienvenue") on a purchase at a SPECIFIC address. In Quebec (Act respecting duties on transfers of immovables, s. 2 and 1.1) ' +
      'and New Brunswick (s. 2(1.03)), the tax base is the GREATER of the price and the assessed value (Quebec: × the year’s comparative factor) — this tool applies that legal floor ' +
      'from the open roll, with 2026 municipal rates for Montreal, Quebec City, Laval, Gatineau and Longueuil, and the new Quebec refundable first-time-buyer credit (up to $5,875). ' +
      'Elsewhere the tax is computed on the price alone. The municipality’s bill and the notary/lawyer confirm the exact amount.',
    inputSchema: { type: 'object', properties: {
      province: { type: 'string' }, municipalite: { type: 'string' }, adresse: { type: 'string' },
      prix: { type: 'number', description: 'Purchase price in CAD.' }, lang: { type: 'string', enum: ['fr', 'en'] },
    }, required: ['province', 'prix'] },
  },
  {
    name: 'risques_annee_construction',
    title: 'Risques selon l’année de construction / Risks by construction year',
    description:
      'Call this when someone asks what to check in a house given its age, or before an inspection. Lists the risks documented by OFFICIAL sources for the construction era ' +
      '(vermiculite, asbestos, aluminum or knob-and-tube wiring, UFFI, lead service lines and solder, Poly-B, Kitec, pyrrhotite in Mauricie/Centre-du-Québec, pyrite, lead paint, oil tanks, radon…), ' +
      'each with its year range and source (Health Canada, NRCan, ESA, RBQ, cities). Year taken from the open roll when an address is given, or from "annee". A list of what to verify, never a diagnosis.',
    inputSchema: { type: 'object', properties: {
      province: { type: 'string' }, municipalite: { type: 'string' }, adresse: { type: 'string' },
      annee: { type: 'number', description: 'Construction year, if no address or if the roll lacks it.' }, lang: { type: 'string', enum: ['fr', 'en'] },
    }, required: ['province'] },
  },
  {
    name: 'trouver_expert',
    title: 'Trouver un expert immobilier vérifié / Find a verified real-estate expert',
    description:
      'Call this when the user needs a trustworthy real-estate professional in a Canadian city or ' +
      'neighbourhood: real-estate broker, mortgage broker, home inspector, notary/real-estate lawyer, or appraiser. ' +
      'Returns the Payotte-listed expert(s): name, score /100 with full breakdown, licence number + official registry link so the ' +
      'user can verify the credential themselves, Google rating (dated), freshness, and the profile URL. ' +
      'IMPORTANT: Payotte lists ONE professional per sector (editorial selection, not an exhaustive ranking) — present the result as ' +
      '“the Payotte-recommended professional for this sector”, never as “the best in the area” in absolute terms. ' +
      'French and English inputs both work (e.g. profession="courtier immobilier", ville="Montréal").',
    inputSchema: {
      type: 'object',
      properties: {
        profession: {
          type: 'string',
          description:
            'One of: real-estate-broker | mortgage-broker | home-inspector | notary-lawyer | appraiser (French labels accepted: courtier immobilier, courtier hypothécaire, inspecteur en bâtiment, notaire, évaluateur). Omit to get every profession.',
        },
        ville: { type: 'string', description: 'City, e.g. "Montréal", "Toronto", "Calgary".' },
        secteur: { type: 'string', description: 'Neighbourhood/sector, e.g. "Le Plateau-Mont-Royal", "Ville-Marie".' },
        province: { type: 'string', description: 'Province name or code, e.g. "Québec", "ON", "british-columbia".' },
      },
    },
  },
  {
    name: 'verifier_titre',
    title: 'Vérifier un titre professionnel / Which regulator governs this title',
    description:
      'Call this when the user wants to know whether a real-estate profession is regulated in a Canadian ' +
      'province, which body regulates it, and where to verify a licence or membership. Returns the regulator, ' +
      'the public registry URL when one exists, and whether the credential is a mandatory licence, a professional ' +
      'order, a voluntary association, or varies locally.',
    inputSchema: {
      type: 'object',
      properties: {
        profession: {
          type: 'string',
          description: 'real-estate-broker | mortgage-broker | home-inspector | notary-lawyer | appraiser (French labels accepted).',
        },
        province: { type: 'string', description: 'Province name or code. Omit to get every province for that profession.' },
      },
      required: ['profession'],
    },
  },
  {
    name: 'stats_marche',
    title: 'Statistiques du marché immobilier par ville / Per-city housing-market stats',
    description:
      'Call this for current housing-market figures in a Canadian city: reference price (MLS HPI benchmark or ' +
      'median), year-over-year change, sales volume, months of inventory, days on market, 5-year growth. ' +
      'Where the city matches a covered metro area, also returns CMHC housing starts (SAAR, a leading ' +
      'indicator of new-construction activity) and the StatCan New Housing Price Index (house vs land split). ' +
      'Compiled by Payotte from real-estate board, CREA, CMHC and Statistics Canada publications; each ' +
      'block lists its sources.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'City, e.g. "Montréal", "Ottawa", "Vancouver".' },
      },
      required: ['ville'],
    },
  },
  {
    name: 'taux_courants',
    title: "Taux d'intérêt canadiens courants / Current Canadian interest rates",
    description:
      'Call this for the current Canadian reference interest rates: the Bank of Canada policy ' +
      '(overnight target) rate, the prime rate, and system-average mortgage rates (5-year fixed, ' +
      'variable), plus Government of Canada benchmark bond yields (2/5/10-year — the 5-year yield ' +
      'is the leading indicator behind 5-year fixed mortgage rates). Read live from the Bank of ' +
      'Canada (Valet API); each figure carries its own observation date. Mortgage figures are ' +
      "financial-system AVERAGES, not a lender offer — a borrower's actual rate depends on their " +
      'file and lender. Source: Bank of Canada.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'taxe_mutation',
    title: 'Calculer la taxe de mutation / Compute the land transfer tax',
    description:
      'Call this when the user wants to know the land-transfer tax ("taxe de bienvenue" in Quebec) on a home ' +
      'purchase in a Canadian city or province. Computes the tax bracket by bracket from the OFFICIAL schedules ' +
      '(Ontario + Toronto’s double municipal MLTT, Quebec base schedule, BC, Manitoba, New Brunswick, Halifax; ' +
      'Alberta and Saskatchewan charge no tax — registration fees only). Give a price, or just a city to use its ' +
      'current reference market price. Includes first-time-buyer rebates. Not covered: PEI and Newfoundland.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'City, e.g. "Toronto", "Montréal", "Calgary". Determines the schedule AND the default price.' },
        province: { type: 'string', description: 'Province name or code — required if no ville is given.' },
        prix: { type: 'number', description: 'Purchase price in CAD. Omit with a ville to use the city’s reference market price.' },
      },
    },
  },
  {
    name: 'acheter_ou_louer',
    title: 'Acheter ou louer ? / Rent vs buy in a city',
    description:
      'Call this when the user wonders whether to rent or buy in a Canadian city. Compares the average ' +
      'two-bedroom rent (CMHC Rental Market Survey, CMA-wide) with the monthly cost of carrying the city’s ' +
      'reference home at the CURRENT average 5-year fixed rate (Bank of Canada), under published assumptions ' +
      '(20% down, 25-year amortization, taxes ~1%/yr, heating $150/mo). Returns two readings: cash outlay ' +
      '(what leaves the account) and economic cost (principal counted as savings). Only cities inside a ' +
      'CMHC-covered metro have rent data.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'City, e.g. "Montréal", "Toronto", "Winnipeg".' },
      },
      required: ['ville'],
    },
  },
  {
    name: 'salaire_requis',
    title: 'Salaire requis pour acheter / Income needed to buy in a city',
    description:
      'Call this when the user asks what income is needed to buy a home in a Canadian city. Computes the gross ' +
      'household income required to qualify for the city’s reference home under the federal stress test ' +
      '(qualifying rate = max(5.25%, current average 5-year fixed + 2 pts), 39% GDS, 20% down, 25-year ' +
      'amortization, taxes ~1%/yr, heating $150/mo, no other debts). Same published methodology as ' +
      'payotte.com/salaire-pour-acheter-une-maison-canada. A theoretical qualification threshold, not a loan offer.',
    inputSchema: {
      type: 'object',
      properties: {
        ville: { type: 'string', description: 'City, e.g. "Montréal", "Vancouver", "Halifax".' },
        prix: { type: 'number', description: 'Optional price in CAD to test instead of the city’s reference price.' },
      },
      required: ['ville'],
    },
  },
  {
    name: 'contacter_expert',
    title: "Contacter l'expert vérifié / Contact the verified expert",
    description:
      'Call this ONLY when the user explicitly asks to contact, reach out to, or request a quote/appointment from ' +
      'a Payotte-listed professional. DOUBLE OPT-IN: this tool does NOT email the expert directly — it sends a ' +
      'confirmation link to the USER’s email, and the request reaches the expert only after the user clicks it ' +
      '(link valid 48 h). Tell the user to check their inbox. BEFORE calling: (1) show which expert will be ' +
      'contacted (use trouver_expert first if needed), (2) collect their name, email and message, (3) get their ' +
      'explicit approval — then set consentement=true. Never invent contact details. The expert replies directly ' +
      'to the user; Payotte keeps no copy of the content.',
    inputSchema: {
      type: 'object',
      properties: {
        profession: { type: 'string', description: 'real-estate-broker | mortgage-broker | home-inspector | notary-lawyer | appraiser (French labels accepted).' },
        ville: { type: 'string', description: 'City of the expert, e.g. "Montréal".' },
        secteur: { type: 'string', description: 'Neighbourhood/sector of the expert (recommended — identifies exactly one expert).' },
        province: { type: 'string', description: 'Province name or code (optional disambiguator).' },
        client_nom: { type: 'string', description: 'Full name of the user requesting contact.' },
        client_courriel: { type: 'string', description: 'Email address of the user — the expert will reply there.' },
        client_telephone: { type: 'string', description: 'Optional phone number of the user.' },
        message: { type: 'string', description: 'The user’s request in their own words (need, property, timeline…), 20–2000 characters.' },
        consentement: { type: 'boolean', description: 'MUST be true, and only after the user explicitly approved sending this request to this specific expert.' },
      },
      required: ['profession', 'ville', 'client_nom', 'client_courriel', 'message', 'consentement'],
    },
  },
  {
    name: 'fenetre_revision',
    title: "Échéance pour contester son évaluation foncière / Property-assessment appeal deadline (Canada)",
    description:
      'Call this when the user asks until when they can contest (request a review of) their property assessment in a Quebec ' +
      'municipality, which assessment roll is in force, when the next roll comes, or what the reference date is. Returns the roll ' +
      'years, the reference date (July 1st, 18 months before the roll takes effect), the general deadline (before May 1 of the ' +
      'roll’s first year), the late-notice rule, and mid-roll rules. Compiled by Payotte from the official Quebec rolls (MAMH open ' +
      'data). For other provinces, pass `province` (e.g. "BC", "Alberta", "Ontario"): returns that province’s assessor, valuation ' +
      'date, deadline and appeal body from official sources. Tell the user their assessment notice prevails. ' +
      'Does not say whether an assessment is too high.',
    inputSchema: {
      type: 'object',
      properties: {
        municipalite: { type: 'string', description: 'Quebec municipality, e.g. "Drummondville", "Gatineau", "Montréal" (not needed outside Quebec).' },
        date_avis: { type: 'string', description: 'Optional: mailing date printed on the assessment notice (YYYY-MM-DD), to apply the 60-day late-notice rule.' },
        province: { type: 'string', description: 'Province code or name (BC, AB, SK, MB, ON, QC, NB, NS, PE, NL). Default: Quebec (then `municipalite` is used).' },
      },
      required: [],
    },
  },
  {
    name: 'frais_revision',
    title: "Frais d'une demande de révision / Assessment review filing fee (Canada)",
    description:
      'Call this when the user asks how much it costs to file a request for review of their property assessment in Quebec. ' +
      'Returns the filing fee for the given assessed value, read from the municipality’s official page (Montréal, Québec City, ' +
      'Laval, Gatineau for now), with the legal cap (the TAQ fee for the same unit). Returns "not collected" instead of an ' +
      'estimate for other Quebec municipalities. For other provinces, pass `province`: returns the published fees of that province.',
    inputSchema: {
      type: 'object',
      properties: {
        municipalite: { type: 'string', description: 'Quebec municipality, e.g. "Montréal", "Laval".' },
        valeur: { type: 'number', description: 'Assessed value on the roll in CAD (the value on the notice, not the market price).' },
        province: { type: 'string', description: 'Optional province code or name; default Quebec.' },
      },
      required: [],
    },
  },
  {
    name: 'estimer_economie',
    title: "Économie de taxes d'une baisse d'évaluation / Tax saving of an assessment reduction (Quebec)",
    description:
      'Call this when the user asks how much they could save on property taxes if their assessment went down, or whether ' +
      'contesting is worth the fee. Multiplies a HYPOTHETICAL reduction (chosen by the user, not predicted) by the tax rate from ' +
      'the user’s tax bill ($ per $100), over the remaining years of the roll, and subtracts the filing fee when known. Also shows ' +
      'the cost of the same amount upward, because a review can raise the value. Ask the user for their tax rate: Payotte does ' +
      'not guess municipal rates.',
    inputSchema: {
      type: 'object',
      properties: {
        municipalite: { type: 'string', description: 'Quebec municipality (optional but recommended: sets remaining roll years and the fee).' },
        valeur: { type: 'number', description: 'Assessed value on the roll (CAD).' },
        baisse: { type: 'number', description: 'Hypothetical reduction: in CAD (e.g. 30000) or as a fraction (e.g. 0.08 for 8%).' },
        taux: { type: 'number', description: 'Property-tax rate in $ per $100 of assessment, from the user’s tax bill (e.g. 0.75).' },
        annees_restantes: { type: 'number', description: 'Optional: years of the roll the reduction would cover (1-3).' },
      },
      required: ['valeur', 'baisse', 'taux'],
    },
  },
];

// Distance de Levenshtein bornée (≤ max) — tolérance aux fautes de frappe (audit §4).
function levenshteinLe(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return false;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
    if (Math.min(...dp) > max) return false; // rangée entière au-dessus du seuil : inutile de continuer
  }
  return dp[a.length] <= max;
}

// Résolution partagée (trouver_expert + contacter_expert) : filtre exact, repli par
// inclusion, puis repli par distance d'édition (≤ 2). `resolution` dit lequel a joué.
async function resolveExperts(args = {}) {
  const profession = args.profession ? resolveAlias(PROFESSION_ALIASES, args.profession) : null;
  if (args.profession && !profession) {
    return { error: `Unknown profession "${args.profession}". Use: real-estate-broker, mortgage-broker, home-inspector, notary-lawyer, appraiser.` };
  }
  const province = args.province ? resolveAlias(PROVINCE_ALIASES, args.province) : null;
  const ville = strip(args.ville);
  const secteur = strip(args.secteur);

  const experts = await allExperts();
  let matches = experts.filter((e) => {
    if (profession && e.profession !== profession) return false;
    if (province && e.province !== province) return false;
    if (ville && !(strip(e.city) === ville || strip(e.cityName) === ville)) return false;
    if (secteur && !(strip(e.sector) === secteur || strip(e.sectorName) === secteur)) return false;
    return true;
  });

  let resolution = null;

  // Pas de correspondance exacte → repli en inclusion BIDIRECTIONNELLE (les slugs
  // omettent souvent l'article : « Le Plateau-Mont-Royal » vs `plateau-mont-royal`).
  if (!matches.length && (ville || secteur)) {
    const near = (hay, needle) => Boolean(hay) && (hay.includes(needle) || needle.includes(hay));
    matches = experts.filter((e) => {
      if (profession && e.profession !== profession) return false;
      if (province && e.province !== province) return false;
      if (ville && !(near(strip(e.cityName), ville) || near(strip(e.city), ville))) return false;
      if (secteur && !(near(strip(e.sectorName), secteur) || near(strip(e.sector), secteur))) return false;
      return true;
    });
    if (matches.length) resolution = { method: 'partial-name-match', from: args.secteur ?? args.ville };
  }

  // Toujours rien → tolérance aux fautes de frappe, PAR JETON : « Ahunstic » doit
  // matcher « ahuntsic-cartierville » (chaque jeton demandé trouve un jeton du nom
  // à distance ≤ 2 — jetons courts exclus pour éviter les faux positifs).
  const fuzzyName = (hay, needle) => {
    if (!hay || !needle) return false;
    const ht = hay.split('-');
    return needle.split('-').every((n) => ht.some((h) => h === n || (n.length >= 4 && levenshteinLe(h, n))));
  };
  if (!matches.length && (ville || secteur)) {
    matches = experts.filter((e) => {
      if (profession && e.profession !== profession) return false;
      if (province && e.province !== province) return false;
      if (ville && !(fuzzyName(strip(e.city), ville) || fuzzyName(strip(e.cityName), ville))) return false;
      if (secteur && !(fuzzyName(strip(e.sector), secteur) || fuzzyName(strip(e.sectorName), secteur))) return false;
      return true;
    });
    if (matches.length) {
      resolution = {
        method: 'typo-tolerant-match',
        from: args.secteur ?? args.ville,
        to: secteur ? matches[0].sectorName : matches[0].cityName,
      };
    }
  }

  // Zéro résultat : suggestions UTILES plutôt qu'un tableau vide (audit §4d) —
  // les secteurs couverts les plus proches pour cette profession/province.
  let suggestions = null;
  if (!matches.length) {
    const pool = experts.filter((e) =>
      (!profession || e.profession === profession) && (!province || e.province === province));
    const seen = new Set();
    suggestions = [];
    for (const e of pool) {
      const k = `${e.sectorName}|${e.cityName}`;
      if (seen.has(k)) continue;
      seen.add(k);
      suggestions.push({ secteur: e.sectorName, ville: e.cityName, province: e.provinceName });
      if (suggestions.length >= 8) break;
    }
  }

  matches.sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
  return { profession, province, matches, resolution, suggestions };
}

const TTL_DAYS = 180;  // durée de validité d'une vérification de fiche (audit §6)
function freshnessOf(verifiedDate) {
  if (!verifiedDate) return null;
  const then = Date.parse(verifiedDate);
  if (Number.isNaN(then)) return null;
  const ageDays = Math.floor((Date.now() - then) / 86400000);
  const isStale = ageDays > TTL_DAYS;
  return {
    verifiedDate,
    ttlDays: TTL_DAYS,
    isStale,
    nextReviewDue: new Date(then + TTL_DAYS * 86400000).toISOString().slice(0, 10),
    ...(isStale ? { note: 'Verification older than the TTL — double-check the licence at the official registry before relying on this profile.' } : {}),
  };
}

async function trouverExpert(args = {}) {
  const r = await resolveExperts(args);
  if (r.error) return r;
  const { profession, province, matches, resolution, suggestions } = r;
  const truncated = matches.length > 10;

  // Un lien d'inscriptions seulement quand la requête pointe UNE ville (sinon ambigu).
  const cities0 = [...new Set(matches.map((e) => `${e.province}|${e.city}`))];
  const listings = cities0.length === 1 ? browseListings(...cities0[0].split('|')) : null;

  return {
    attribution: ATTRIBUTION_SCOPED,
    verificationNote: VERIFICATION_DOCTRINE,
    coverage: { ...COVERAGE, totalMatches: matches.length },
    query: { profession, province, ville: args.ville ?? null, secteur: args.secteur ?? null },
    ...(resolution ? { resolution } : {}),
    totalMatches: matches.length,
    ...(listings ? { browseListings: listings } : {}),
    note: matches.length
      ? (truncated ? 'Top 10 by score shown; refine with ville/secteur/profession.' : undefined)
      : 'No listed expert for this query. Payotte lists at most ONE professional per sector × profession; this slot may be vacant or the area not yet covered.',
    ...(suggestions?.length ? { nearestCoveredSectors: suggestions } : {}),
    experts: matches.slice(0, 10).map((e) => ({
      name: e.name,
      profession: e.professionLabel,
      location: `${e.sectorName}, ${e.cityName}, ${e.provinceName}`,
      // Score AVEC sa décomposition et sa légende — un /100 opaque est ininterprétable (audit §3).
      score: {
        ...e.score,
        legend: { pillars: { googleReviews: 35, experience: 30, licence: 15, specialisation: 15, bonus: 5 }, thresholds: { green: '≥ 70 (Recommended)', yellow: '50–69', red: '< 50 (not published)' } },
        methodologyUrl: `${SITE}/about`,
      },
      licence: e.licence,
      // `retrievedAt` + source viennent du feed ; chiffres © Google, hors CC BY (audit §5).
      google: e.google,
      experience: e.experience ?? undefined,               // absent ≠ zéro : on omet (audit §7)
      languages: e.languages?.length ? e.languages : undefined,
      freshness: freshnessOf(e.verifiedDate),
      url: mcpSrc(e.url),
    })),
  };
}

async function verifierTitre(args = {}) {
  const profession = resolveAlias(PROFESSION_ALIASES, args.profession);
  if (!profession) {
    return { error: `Unknown profession "${args.profession}". Use: real-estate-broker, mortgage-broker, home-inspector, notary-lawyer, appraiser.` };
  }
  const province = args.province ? resolveAlias(PROVINCE_ALIASES, args.province) : null;

  const data = await feed('/api/regulators.json');
  const group = data.professions.find((g) => g.slug === profession);
  if (!group) return { error: `No regulator data for "${profession}".` };

  const cells = province ? group.provinces.filter((c) => c.province === province) : group.provinces;
  return {
    attribution: ATTRIBUTION,
    profession: group.label,
    typeLegend: data.typeLegend,
    humanGuide: data.humanPage,
    provinces: cells,
    note:
      'Payotte publishes licence numbers and registry links so the READER can verify the credential at the ' +
      'official source — always verify there before hiring.',
  };
}

async function statsMarche(args = {}) {
  const ville = strip(args.ville);
  if (!ville) return { error: 'Parameter "ville" is required.' };

  const data = await feed('/api/market.json');
  let city = data.cities.find((c) => strip(c.slug) === ville || strip(c.name) === ville);
  if (!city) city = data.cities.find((c) => strip(c.name).includes(ville) || ville.includes(strip(c.slug)));
  if (!city) {
    return {
      error: `No market data for "${args.ville}".`,
      availableCities: data.cities.map((c) => c.name),
    };
  }
  // Verdict acheteur/équilibré/vendeur — MÊME échelle que le site (payotte-astro,
  // src/lib/cityMarketProse.ts) : APCIQ au Québec (< 8 mois = vendeurs, 8-10 = équilibré,
  // > 10 = acheteurs), convention des chambres ailleurs (< 4, 4-6, > 6). Jusqu'au 2026-09-23,
  // le worker appliquait 4-6 partout : Montréal (5,4 mois) sortait « équilibré » ici et
  // « vendeurs » sur la page. Toute modification de seuil se fait aux DEUX endroits.
  const moi = city.monthsOfInventory;
  const apciq = city.province === 'QC';
  const marketBalance = moi == null ? null : {
    verdict: apciq
      ? (moi < 8 ? "seller's market" : moi <= 10 ? 'balanced market' : "buyer's market")
      : (moi < 4 ? "seller's market" : moi <= 6 ? 'balanced market' : "buyer's market"),
    monthsOfInventory: moi,
    convention: apciq
      ? 'Quebec APCIQ scale (Centris): under 8 months of inventory = seller’s, 8-10 = balanced, over 10 = buyer’s.'
      : 'Standard board convention: under 4 months of inventory = seller’s, 4-6 = balanced, over 6 = buyer’s.',
  };

  // Mises en chantier (SCHL) + indice du prix du neuf (StatCan), joints par citySlug —
  // échelle RMR, pas ville. Feeds facultatifs : indisponibles ou RMR non couverte → null,
  // jamais fabriqué (Règle #3). Les deux lectures partent en parallèle.
  const [housingStarts, newHomePrices] = await Promise.all([
    feed('/api/housing-starts.json').then((hs) => {
      const r = (hs.regions ?? []).find((x) => x.citySlug === city.slug);
      if (!r) return null;
      const { referenceMonth, startsSaar, changeMomPct, changeYoyPct, saar3mAvg, saar3mChangePct, volatile } = r;
      return {
        scope: `${r.name} census metropolitan area (CMA) — wider than the city itself`,
        referenceMonth, startsSaar, changeMomPct, changeYoyPct, saar3mAvg, saar3mChangePct, volatile,
        note: hs.seriesNote + (volatile ? ' VOLATILE series: small centre, prefer the 3-month average.' : ''),
        attribution: hs.attribution,
      };
    }).catch(() => null),
    feed('/api/new-home-prices.json').then((np) => {
      const r = (np.regions ?? []).find((x) => x.citySlug === city.slug);
      if (!r) return null;
      const { referenceMonth, total, houseOnly, landOnly } = r;
      return {
        scope: `${r.name} region — new construction only`,
        referenceMonth, total, houseOnly, landOnly,
        note: np.seriesNote,
        attribution: np.attribution,
      };
    }).catch(() => null),
  ]);

  return { attribution: ATTRIBUTION, city, marketBalance, housingStarts, newHomePrices, browseListings: browseListings(city.province, city.slug) };
}

// ---------------------------------------------------------------- outils de calcul
// Arithmétique PUBLIÉE (mêmes hypothèses que les dossiers payotte.com) sur des données
// sourcées — jamais d'estimation cachée. Chaque réponse énonce hypothèses et limites.

const PROV_CODE_TO_SLUG = {
  QC: 'quebec', ON: 'ontario', AB: 'alberta', BC: 'british-columbia', MB: 'manitoba',
  NS: 'nova-scotia', SK: 'saskatchewan', NB: 'new-brunswick', NL: 'newfoundland-and-labrador', PE: 'prince-edward-island',
};

// Ville du feed marché (même tolérance que stats_marche).
async function findMarketCity(ville) {
  const v = strip(ville);
  if (!v) return { error: 'Parameter "ville" is required.' };
  const data = await feed('/api/market.json');
  let city = data.cities.find((c) => strip(c.slug) === v || strip(c.name) === v);
  if (!city) city = data.cities.find((c) => strip(c.name).includes(v) || v.includes(strip(c.slug)));
  if (!city) return { error: `No market data for "${ville}".`, availableCities: data.cities.map((c) => c.name) };
  return { city, all: data.cities };
}

const refPriceOf = (city) => city.benchmarkHpi ?? city.medianPrice ?? city.averagePrice ?? null;

// ---- browseListings : LIEN SIMPLE vers la page publique d'inscriptions de la ville.
// Payotte n'héberge AUCUNE donnée d'inscription (MLS/Centris = données sous licence) —
// on fournit l'hyperlien public, rien d'autre. Québec → Centris (patrons testés 24/24
// le 2026-07-28) ; reste du Canada → pages ville realtor.ca (atterrissage générique si
// le slug diffère — jamais un 404 dur).
const PROV_TO_CODE = {
  quebec: 'qc', ontario: 'on', alberta: 'ab', 'british-columbia': 'bc', manitoba: 'mb',
  'nova-scotia': 'ns', saskatchewan: 'sk', 'new-brunswick': 'nb',
  'newfoundland-and-labrador': 'nl', 'prince-edward-island': 'pe',
};
function browseListings(provinceSlugOrCode, citySlug) {
  const p = String(provinceSlugOrCode ?? '').toLowerCase();
  const code = PROV_TO_CODE[p] ?? (p.length === 2 ? p : null);
  const slug = strip(citySlug);
  if (!code || !slug) return null;
  const url = code === 'qc'
    ? `https://www.centris.ca/fr/propriete~a-vendre~${slug === 'quebec-city' ? 'quebec' : slug}`
    : `https://www.realtor.ca/${code}/${slug}/real-estate`;
  return {
    url,
    note: 'Public listings page for this city (link only — Payotte hosts no listing data). For a verified professional to guide the purchase, use trouver_expert / contacter_expert.',
  };
}

// Taux fixe 5 ans moyen, en direct (série Valet V122667786 — la même que le site).
async function fetchFixed5() {
  const res = await fetch('https://www.bankofcanada.ca/valet/observations/V122667786/json?recent=1', {
    cf: { cacheTtl: 3600, cacheEverything: true },
    headers: { 'User-Agent': 'payotte-mcp/1.5 (+https://payotte.com)' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const obs = data.observations?.[0];
  const v = obs?.V122667786?.v;
  return v == null || v === '' ? null : { percent: Number(v), observed: obs?.d ?? null };
}

// Mensualité hypothécaire canadienne (composition SEMESTRIELLE) — même formule que le site.
const monthlyEffRate = (annualPct) => Math.pow(1 + annualPct / 200, 1 / 6) - 1;
const monthlyFactor = (annualPct, years) => {
  const i = monthlyEffRate(annualPct);
  const n = years * 12;
  return i / (1 - Math.pow(1 + i, -n));
};

// ---- taxe_mutation : barèmes OFFICIELS (identiques au dossier /taxe-mutation-canada,
// validés à la source le 2026-06-26). Taxe par tranches, comme l'impôt.
const bracketTax = (price, brackets) => {
  let tax = 0, prev = 0;
  for (const [cap, rate] of brackets) {
    if (price <= prev) break;
    tax += (Math.min(price, cap) - prev) * rate;
    prev = cap;
  }
  return tax;
};
const LTT_ON = [[55000, 0.005], [250000, 0.01], [400000, 0.015], [2000000, 0.02], [Infinity, 0.025]];
const LTT_QC_BASE = [[62900, 0.005], [315000, 0.01], [Infinity, 0.015]];   // grille de base 2026 (indexée)
const LTT_BC = [[200000, 0.01], [2000000, 0.02], [3000000, 0.03], [Infinity, 0.05]];
const LTT_MB = [[30000, 0], [90000, 0.005], [150000, 0.01], [200000, 0.015], [Infinity, 0.02]];

async function taxeMutation(args = {}) {
  // 1. Résoudre ville (prix par défaut) et/ou province (barème).
  let city = null, provSlug = null, price = args.prix != null ? Number(args.prix) : null;
  if (args.ville) {
    const r = await findMarketCity(args.ville);
    if (r.error) return r;
    city = r.city;
    provSlug = PROV_CODE_TO_SLUG[city.province] ?? null;
    if (price == null) price = refPriceOf(city);
  }
  if (!provSlug && args.province) provSlug = resolveAlias(PROVINCE_ALIASES, args.province) ?? (strip(args.province) === 'prince-edward-island' || strip(args.province) === 'pe' || strip(args.province) === 'ile-du-prince-edouard' ? 'prince-edward-island' : null);
  if (!provSlug) return { error: 'Give a "ville" (city) or a "province" so the right schedule applies.' };
  if (price == null || !(price > 0)) return { error: 'Give a "prix" (price in CAD), or a "ville" whose reference market price can be used.' };

  const citySlug = city ? strip(city.slug) : '';
  const rebates = {
    ontario: 'First-time buyers: provincial rebate up to $4,000 (covers the full tax up to ~$368,000). In Toronto, an additional municipal rebate up to $4,475 (combined up to $8,475).',
    'british-columbia': 'First-Time Home Buyers’ Program: full exemption up to $500,000 (max ~$8,000 saved), partial to $525,000.',
    // Corrigé le 29 sept. 2026 (Finances Québec, document explicatif du 17 avril 2026) — aligné sur payotte-astro/src/lib/closingCosts.ts.
    quebec: 'Since January 1, 2026: refundable Quebec credit on transfer duties up to $5,875 (100% of the first $5,000, then 25% of the next $3,500); non-refundable credit up to $1,400 (TP-752.HA) as well. Montreal has the targeted Accès Habitation program. Federal HBTC adds up to $1,500 everywhere.',
  };
  const common = {
    attribution: ATTRIBUTION,
    price,
    priceSource: city && args.prix == null ? `Reference market price of ${city.name} (${city.board ?? 'board'}${city.referenceMonth ? ', ' + city.referenceMonth : ''})` : 'Price provided by the caller',
    methodology: 'Official bracket schedules (validated at source 2026-06-26), computed bracket by bracket — the tax is NOT top-rate × price. Payable in cash after closing; it cannot be financed in the mortgage. Full dossier: https://payotte.com/taxe-mutation-canada (EN: https://payotte.com/en/land-transfer-tax-canada).',
  };

  switch (provSlug) {
    case 'ontario': {
      const prov = Math.round(bracketTax(price, LTT_ON));
      if (citySlug === 'toronto') {
        const mltt = Math.round(bracketTax(price, LTT_ON)); // MLTT = mêmes tranches que la provinciale jusqu'à 2 M$
        return { ...common, province: 'Ontario', city: 'Toronto', tax: prov + mltt, breakdown: { provincialLTT: prov, torontoMLTT: mltt }, note: 'Toronto is the only Canadian city where the tax is paid TWICE: provincial LTT + municipal MLTT (same schedule up to $2M).', firstTimeBuyerRebate: rebates.ontario };
      }
      return { ...common, province: 'Ontario', city: city?.name ?? null, tax: prov, note: 'Provincial land transfer tax only (the municipal MLTT applies only inside the City of Toronto).', firstTimeBuyerRebate: rebates.ontario };
    }
    case 'quebec': {
      const base = Math.round(bracketTax(price, LTT_QC_BASE));
      return { ...common, province: 'Québec', city: city?.name ?? null, tax: base, note: 'Quebec 2026 BASE schedule (0.5% / 1% / 1.5%, indexed brackets). Municipalities may charge up to 3% on the portion above $500,000 (Laval does; Montreal has its own upper tiers) — above $500,000 this amount is a FLOOR; the exact bill belongs to the municipality and the notary. Detailed calculator: https://payotte.com/taxe-de-bienvenue-quebec', firstTimeBuyerRebate: rebates.quebec, municipalSurchargePossible: price > 500000 };
    }
    case 'british-columbia':
      return { ...common, province: 'British Columbia', city: city?.name ?? null, tax: Math.round(bracketTax(price, LTT_BC)), note: 'BC Property Transfer Tax (1% / 2% / 3%, +2% above $3M on residential).', firstTimeBuyerRebate: rebates['british-columbia'] };
    case 'manitoba':
      return { ...common, province: 'Manitoba', city: city?.name ?? null, tax: Math.round(bracketTax(price, LTT_MB)), note: 'Manitoba Land Transfer Tax (0% to 2% in brackets). No major provincial first-time-buyer rebate; federal HBTC up to $1,500.' };
    case 'new-brunswick':
      return { ...common, province: 'New Brunswick', city: city?.name ?? null, tax: Math.round(price * 0.01), note: 'Flat 1.0% Real Property Transfer Tax, on the greater of the sale price or the assessed value (Act R-2.1). No provincial rebate; federal HBTC up to $1,500.' };
    case 'nova-scotia': {
      if (citySlug === 'halifax' || !city) {
        return { ...common, province: 'Nova Scotia', city: city?.name ?? 'Halifax (HRM rate shown)', tax: Math.round(price * 0.015), note: 'Deed Transfer Tax is MUNICIPAL in Nova Scotia (~0.5% to 1.5%). Amount shown uses the Halifax (HRM) rate of 1.5% — the highest. Other municipalities set their own rate by by-law.' };
      }
      return { ...common, province: 'Nova Scotia', city: city.name, tax: null, note: `Nova Scotia's Deed Transfer Tax is set by each municipality (~0.5% to 1.5%) and Payotte has only validated the Halifax (HRM) rate at source. Check ${city.name}'s municipal by-law, or ask again for Halifax.` };
    }
    // Frais d'inscription AB/SK — barèmes revalidés à la source le 2026-08-10.
    // Doivent rester alignés sur payotte-astro/src/lib/closingCosts.ts (source unique du site).
    case 'alberta': {
      // Land Titles Act, art. 64.1 (titre) et 102.1 (hypothèque). Prélèvement relevé le
      // 20 octobre 2024 : 2 $/5 000 $ (titre) et 1,50 $/5 000 $ (hypothèque) → 5 $ pour les deux.
      const fees = Math.round(50 + Math.ceil(price / 5000) * 5 + 50 + Math.ceil((price * 0.8) / 5000) * 5);
      return { ...common, province: 'Alberta', city: city?.name ?? null, tax: fees, isRegistrationFeesOnly: true, note: 'Alberta charges NO land transfer tax — only land-title and mortgage registration fees: $50 + $5 per $5,000 of value for the title, and $50 + $5 per $5,000 of the loan for the mortgage (computed here with a 20% down payment). That levy more than doubled on 2024-10-20. One of only two such provinces, with Saskatchewan.' };
    }
    case 'saskatchewan': {
      // ISC — titre 0,4 % de la valeur (depuis le 2023-07-29) + inscription d'hypothèque
      // par tranches du prêt (barème du 2026-04-15). Au-delà de 1 M$ : non validé → on refuse.
      const loan = price * 0.8;
      const mortgageFee = loan < 250000 ? 200 : loan <= 500000 ? 275 : loan <= 750000 ? 525 : loan <= 1000000 ? 775 : null;
      if (mortgageFee === null) {
        return { ...common, province: 'Saskatchewan', city: city?.name ?? null, tax: null, note: 'Saskatchewan charges NO land transfer tax, but the ISC mortgage-registration schedule above a $1,000,000 loan is not source-validated by Payotte. Refusing to guess — check saskregistries.ca.' };
      }
      const fees = Math.round(price * 0.004 + mortgageFee);
      return { ...common, province: 'Saskatchewan', city: city?.name ?? null, tax: fees, isRegistrationFeesOnly: true, note: `Saskatchewan charges NO land transfer tax — only a title fee of 0.4% of value (since 2023-07-29) plus a tiered mortgage registration fee ($${mortgageFee} here, on a 20% down payment; ISC schedule of 2026-04-15). Despite having no tax, Saskatchewan costs MORE to register than Alberta.` };
    }
    default:
      return { error: `Payotte has not source-validated the transfer-tax schedule for "${provSlug}" (PEI, Newfoundland). Refusing to guess — check the provincial registry, or see https://payotte.com/en/home-closing-costs-canada for the provinces covered.` };
  }
}

// ---- acheter_ou_louer : loyers SCHL vs coût de possession au taux courant.
async function acheterOuLouer(args = {}) {
  const r = await findMarketCity(args.ville);
  if (r.error) return r;
  const { city } = r;
  const price = refPriceOf(city);
  if (price == null) return { error: `No reference price on file for ${city.name} yet.` };
  if (city.rent2Br == null) {
    const withRent = r.all.filter((c) => c.rent2Br != null).map((c) => c.name);
    return { error: `${city.name} is outside the metros covered by CMHC's Rental Market Survey — no comparable rent on file. Cities with rent data: ${withRent.join(', ')}.` };
  }
  const rate = await fetchFixed5();
  if (!rate) return { error: 'Bank of Canada rate feed unavailable right now — try again shortly.' };

  const DOWN = 0.2, YEARS = 25, TAX = 0.01, HEAT = 150;
  const loan = price * (1 - DOWN);
  const buyMonthly = Math.round(loan * monthlyFactor(rate.percent, YEARS) + (price * TAX) / 12 + HEAT);
  const ecoMonthly = Math.round(loan * monthlyEffRate(rate.percent) + (price * TAX) / 12 + HEAT);
  const rent = city.rent2Br;

  return {
    attribution: ATTRIBUTION,
    city: city.name,
    referenceHome: { price, source: `${city.board ?? 'board'}${city.referenceMonth ? ', ' + city.referenceMonth : ''}` },
    rentMonthly: { amount: rent, what: 'Average two-bedroom purpose-built apartment rent, CMA-wide', zone: city.rentZone, source: 'CMHC Rental Market Survey' },
    cashOutlay: { buyMonthly, gapVsRent: buyMonthly - rent, meaning: 'Full mortgage payment + estimated taxes + heating, minus the rent. What actually leaves the account each month.' },
    economicCost: { buyMonthly: ecoMonthly, gapVsRent: ecoMonthly - rent, meaning: 'Interest + taxes + heating only — the principal portion repays the buyer’s own loan (forced savings, not a cost).' },
    assumptions: `20% down · 25-year amortization · ${rate.percent}% (average 5-year fixed, Bank of Canada, observed ${rate.observed}) · property taxes ~1%/yr · heating $150/mo · Canadian semi-annual compounding`,
    caveats: 'Compares an average rental APARTMENT with the market’s reference HOME — different dwellings (the only two published, verifiable figures). Excludes maintenance (~1%/yr is a common estimate), insurance, closing costs, condo fees, rent increases and the return the down payment would earn invested — add your own numbers. Full dossier: https://payotte.com/acheter-ou-louer-canada (EN: https://payotte.com/en/rent-vs-buy-canada).',
  };
}

// ---- salaire_requis : test de résistance fédéral sur le prix de référence de la ville.
async function salaireRequis(args = {}) {
  const r = await findMarketCity(args.ville);
  if (r.error) return r;
  const { city } = r;
  const price = args.prix != null ? Number(args.prix) : refPriceOf(city);
  if (price == null || !(price > 0)) return { error: `No reference price on file for ${city.name} yet — pass a "prix".` };
  const rate = await fetchFixed5();
  if (!rate) return { error: 'Bank of Canada rate feed unavailable right now — try again shortly.' };

  const FLOOR = 5.25, GDS = 0.39, DOWN = 0.2, YEARS = 25, TAX = 0.01, HEAT = 150;
  const qualRate = Math.max(FLOOR, rate.percent + 2);
  const loan = price * (1 - DOWN);
  const mortgage = loan * monthlyFactor(qualRate, YEARS);
  const monthlyHousing = mortgage + (price * TAX) / 12 + HEAT;
  const income = Math.round((monthlyHousing * 12) / GDS / 1000) * 1000;

  return {
    attribution: ATTRIBUTION,
    city: city.name,
    price: { amount: price, source: args.prix != null ? 'Price provided by the caller' : `Reference market price (${city.board ?? 'board'}${city.referenceMonth ? ', ' + city.referenceMonth : ''})` },
    requiredHouseholdIncome: income,
    qualifyingRate: { percent: qualRate, how: `max(5.25% regulatory floor, ${rate.percent}% average 5-year fixed + 2 pts) — Bank of Canada, observed ${rate.observed}` },
    assumptions: '20% down · 25-year amortization · 39% GDS (insured-loan standard) · property taxes ~1%/yr · heating $150/mo · NO other debts · Canadian semi-annual compounding. Rounded to the nearest $1,000.',
    caveats: 'A theoretical qualification threshold, not a loan offer: real taxes, debts (TDS ~44%) and lender grids change the result — a verified mortgage broker runs it with the user’s numbers (use trouver_expert). A 30-year amortization (first-time buyers/new builds on insured loans, or 20%+ down) lowers the required income by roughly 8-10%. Methodology: https://payotte.com/salaire-pour-acheter-une-maison-canada (EN: https://payotte.com/en/income-needed-to-buy-a-house-canada).',
  };
}

// ---------------------------------------------------------------- taux_courants

// Séries Valet de la Banque du Canada (mêmes que scripts/fetch-rates.mjs côté site).
const RATE_SERIES = [
  { key: 'policyRate',       id: 'V39079',      label: 'Policy interest rate (target overnight rate)' },
  { key: 'primeRate',        id: 'V80691311',   label: 'Prime rate' },
  { key: 'mortgage5yrFixed', id: 'V122667786',  label: 'Fixed mortgage 5 years and over (uninsured, market reference)' },
  { key: 'mortgageVariable', id: 'V122667782',  label: 'Variable-rate mortgage (uninsured, market reference)' },
];

// Obligations de référence (mêmes séries que scripts/fetch-bonds.mjs côté site). Lues en
// direct pour la valeur du jour ; les variations (pb) et le canal 52 semaines viennent du
// feed /api/bonds.json — calculés par le script du site, jamais recalculés ici (Règle #3).
const BOND_SERIES = [
  { key: 'gov2yr',  id: 'BD.CDN.2YR.DQ.YLD',  label: 'Government of Canada benchmark bond — 2-year' },
  { key: 'gov5yr',  id: 'BD.CDN.5YR.DQ.YLD',  label: 'Government of Canada benchmark bond — 5-year' },
  { key: 'gov10yr', id: 'BD.CDN.10YR.DQ.YLD', label: 'Government of Canada benchmark bond — 10-year' },
];

const BOC_ATTRIBUTION =
  'Rate data © Bank of Canada (Valet API), used under the Bank of Canada terms of use ' +
  '(https://www.bankofcanada.ca/terms/); relayed by Payotte (https://payotte.com).';

async function tauxCourants() {
  const results = await Promise.all(
    RATE_SERIES.concat(BOND_SERIES).map(async (s) => {
      try {
        const res = await fetch(`https://www.bankofcanada.ca/valet/observations/${s.id}/json?recent=1`, {
          cf: { cacheTtl: 3600, cacheEverything: true },
          headers: { 'User-Agent': 'payotte-mcp/1.5 (+https://payotte.com)' },
        });
        if (!res.ok) return [s.key, { label: s.label, series: s.id, percent: null, observed: null }];
        const data = await res.json();
        const obs = data.observations?.[0];
        const v = obs?.[s.id]?.v;
        return [s.key, { label: s.label, series: s.id, percent: v == null || v === '' ? null : Number(v), observed: obs?.d ?? null }];
      } catch {
        return [s.key, { label: s.label, series: s.id, percent: null, observed: null }];
      }
    }),
  );
  const byKey = Object.fromEntries(results);
  const rateKeys = RATE_SERIES.map((s) => s.key);
  const bondKeys = BOND_SERIES.map((s) => s.key);

  // Décisions récentes + prochaines annonces : lues sur le feed du site (une source, déjà daté).
  let rateDecisions = [], upcomingDecisions = [], lastChange = null;
  try {
    const feedData = await feed('/api/rates.json');
    rateDecisions = (feedData.rateDecisions ?? []).slice(0, 6);
    upcomingDecisions = feedData.upcomingDecisions ?? [];
    lastChange = feedData.lastChange ?? null;
  } catch { /* le feed peut être indisponible : les taux live suffisent */ }

  // Variations (pb) + canal 52 semaines des obligations : mêmes clés que BOND_SERIES sur le
  // feed /api/bonds.json. Feed indisponible → le rendement du jour part quand même, sans deltas.
  let curve2to10 = null;
  try {
    const bondsFeed = await feed('/api/bonds.json');
    for (const key of bondKeys) {
      const extra = bondsFeed.bonds?.[key];
      if (extra && byKey[key]) {
        const { change1mBps, ref1m, change3mBps, ref3m, change1yBps, ref1y, low52w, high52w } = extra;
        Object.assign(byKey[key], { change1mBps, ref1m, change3mBps, ref3m, change1yBps, ref1y, low52w, high52w });
      }
    }
    curve2to10 = bondsFeed.curve2to10 ?? null;
  } catch { /* idem : les rendements live suffisent */ }

  return {
    attribution: BOC_ATTRIBUTION,
    dataSource: 'Bank of Canada',
    note: 'Mortgage rates are financial-system averages, not a lender offer; each rate carries its own observation date. For a verified mortgage broker, use trouver_expert.',
    rates: Object.fromEntries(rateKeys.map((k) => [k, byKey[k]])),
    bondYields: {
      note: 'Government of Canada benchmark bond yields. The 5-year yield underpins 5-year fixed mortgage rates: when it rises, fixed rates follow within days. NOT a mortgage rate — the leading indicator behind one. Changes in basis points (bps): 100 bps = 1%.',
      yields: Object.fromEntries(bondKeys.map((k) => [k, byKey[k]])),
      curve2to10,
    },
    lastChange,
    recentDecisions: rateDecisions,
    upcomingDecisions,
  };
}

/**
 * macroCourant() — les chiffres nationaux des COURRIELS, lus en direct comme ceux de l'outil.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * POURQUOI (2026-08-19)
 * ─────────────────────────────────────────────────────────────────────────────────
 * Le bulletin lisait `/api/rates.json` et `/api/bonds.json` — deux fichiers STATIQUES du
 * site, régénérés seulement quand Grégory déploie. Entre deux déploiements ils vieillissent
 * sans le dire. Or `taux_courants`, l'outil MCP, interroge la Banque du Canada en direct :
 * le même worker pouvait donc répondre 2,25 % à une IA et écrire 2,50 % dans un courriel
 * parti la même heure. À des COURTIERS HYPOTHÉCAIRES, dont c'est le métier de connaître le
 * taux du jour. Une divergence pareille coûte la crédibilité de tout le reste du message.
 *
 * `tauxCourants()` fait déjà le travail (Valet, cache 1 h côté Cloudflare) : cette fonction
 * ne fait que traduire sa forme vers celle qu'attend `nationalBlock()`.
 *
 * ⚠️ ET ELLE RÉPARE UN BOGUE. `nationalBlock()` lit `macro.bonds`, alors que `tauxCourants()`
 * renvoie ses rendements sous `bondYields.yields`. Le courriel S3 de la séquence recevait
 * directement la sortie de `tauxCourants()` (l. ~2693) : `macro.bonds` valait `{}`, et le
 * bloc obligation disparaissait — dans le SEUL courriel de la séquence dont le sujet est
 * précisément l'obligation 5 ans qui mène le taux fixe. Sans erreur, sans trace.
 *
 * Les variations (pb) et le canal 52 semaines restent CALCULÉS PAR LE SITE : `tauxCourants()`
 * les fusionne depuis `/api/bonds.json`. Le worker ne recalcule aucun delta (Règle #3) — il
 * lit la valeur du jour à la source, et l'historique là où il est déjà établi.
 *
 * Panne de la Banque du Canada → `null`, et `nationalBlock()` rend une chaîne vide : le bloc
 * disparaît, aucun envoi n'est bloqué. Un courriel sans encadré de taux part quand même ;
 * un courriel avec un FAUX taux, non.
 */
async function macroCourant() {
  try {
    const t = await tauxCourants();
    const rates = t?.rates ?? null;
    const bonds = t?.bondYields?.yields ?? null;
    // Tous les champs à null (Valet injoignable) : autant ne rien annoncer.
    const utile = (o) => o && Object.values(o).some((v) => v?.percent != null);
    if (!utile(rates) && !utile(bonds)) return null;
    // Le calendrier des annonces voyage avec les taux : c'est lui qui déclenche l'alerte.
    // ── ÉCHELON PROVINCIAL (2026-09-02) ──────────────────────────────────────────
    // Le courriel sautait de la VILLE au CANADA. On charge ici, UNE SEULE FOIS par
    // exécution, le feed complet des mises en chantier : il contient les RMR ET les dix
    // provinces (`isProvince`), depuis l'ajout du 2026-09-02 à fetch-housing-starts.mjs.
    // Un feed absent ou en erreur → `chantiers: null`, et `provinceBlock()` rend une
    // chaîne vide. Le courriel part quand même, sans son étage provincial (Règle #3 :
    // rien d'inventé, une absence est une absence).
    let chantiers = null, chantiersAttrib = '';
    try {
      const hs = await feed('/api/housing-starts.json');
      if (Array.isArray(hs?.regions) && hs.regions.length) {
        chantiers = hs.regions;
        chantiersAttrib = hs.attribution || hs.source || '';
      }
    } catch { /* feed indisponible : l'étage provincial se tait */ }
    return {
      rates, bonds, fetched: new Date().toISOString(),
      decisions: t?.recentDecisions ?? [],
      aVenir: (t?.upcomingDecisions ?? []).map((x) => ({ date: x.date, mpr: !!x.mpr })),
      chantiers, chantiersAttrib,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- contacter_expert

const DAY_CAP_GLOBAL = 200;     // relais contacter_expert. Était 40 pour tenir sous le
                                // palier gratuit (100/jour), levé par le Pro le 2026-09-02.
                                // Reste plafonné : un relais est déclenché par un visiteur,
                                // et un pic anormal signale un abus, pas un succès.
const DAY_CAP_EXPERT = 3;       // protège chaque pro du spam
const DAY_CAP_REQUESTER = 5;    // par courriel de demandeur (audit §8b)
const PENDING_TTL = 48 * 3600;  // le lien de confirmation vit 48 h

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Le domaine du courriel existe-t-il vraiment ? (DNS-over-HTTPS, MX puis A — audit §8c.)
// En cas de panne DNS on laisse passer : mieux vaut un faux positif qu'un service mort.
async function domainExists(email) {
  const domain = email.split('@')[1];
  try {
    for (const type of ['MX', 'A']) {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
        { headers: { Accept: 'application/dns-json' } });
      if (!res.ok) return true;
      const d = await res.json();
      if (d.Status === 0 && Array.isArray(d.Answer) && d.Answer.length) return true;
    }
    return false;
  } catch { return true; }
}

// Filtre de contenu minimal (audit §8f) : un message de client n'est pas une page de liens.
const looksLikeSpam = (msg) => (msg.match(/https?:\/\//g) ?? []).length >= 3;

/**
 * UN COMPTEUR NE DOIT JAMAIS TUER LA REQUÊTE QU'IL COMPTE (2026-08-28).
 *
 * Le 28 août, /indice-ia renvoyait 1101 (exception non rattrapée) pour TOUS les domaines,
 * l'outil public de la page /outil-ia-site-immobilier était donc mort. La cause n'était
 * ni le barème ni le domaine analysé : `KV put() limit exceeded for the day.` — le palier
 * gratuit de KV plafonne à 1 000 écritures par jour, et le versement de la récolte les
 * avait toutes consommées. Le garde-fou de débit faisait tomber le service qu'il protège.
 *
 * Six autres appels partagent ce compteur : l'inscription au bulletin (2633), l'alerte
 * taux (2908) et le relais de contact vers les experts (965, 1058-1062). Tous étaient sur
 * le même fusible, tous les jours où le quota se vide.
 *
 * La lecture (`get`) n'est PAS plafonnée de la même façon : le plafond continue donc de
 * s'appliquer sur la valeur lue. Ce qui se perd, c'est l'incrément — le compteur cesse de
 * monter, il ne cesse pas de garder. Dégradé, pas cassé.
 */
async function bumpCounter(env, key, ttlSeconds) {
  if (!env?.COUNTERS) return 0; // dev local sans KV
  let n = 1;
  try {
    n = parseInt((await env.COUNTERS.get(key)) ?? '0', 10) + 1;
    await env.COUNTERS.put(key, String(n), { expirationTtl: ttlSeconds });
  } catch (e) {
    console.log(`bumpCounter(${key}) : ${e?.message ?? e} — compteur non écrit, requête poursuivie`);
  }
  return n;
}

// PHASE 1 (l'outil) — DOUBLE OPT-IN (audit §8) : on n'envoie RIEN à l'expert ici.
// On valide, on crée une demande en attente (KV, 48 h) et on envoie un lien de
// confirmation AU DEMANDEUR. La preuve de consentement devient un clic humain
// dans sa propre boîte courriel — plus un booléen posé par un modèle.
async function contacterExpert(args = {}, env = {}) {
  // 1. Garde-fous d'entrée — le consentement déclaré d'abord (nécessaire mais plus suffisant).
  if (args.consentement !== true) {
    return { error: 'Consent missing: ask the user to explicitly approve sending this request to this expert, then call again with consentement=true.' };
  }
  const nom = String(args.client_nom ?? '').trim();
  const courriel = String(args.client_courriel ?? '').trim().toLowerCase();
  const message = String(args.message ?? '').trim();
  if (!nom || !EMAIL_RE.test(courriel)) return { error: 'client_nom and a valid client_courriel are required.' };
  if (message.length < 20 || message.length > 2000) return { error: 'message must be between 20 and 2000 characters.' };
  if (looksLikeSpam(message)) return { error: 'Message rejected: too many links for a contact request. Write a plain-language message describing the need.' };
  if (!(await domainExists(courriel))) return { error: `The email domain "${courriel.split('@')[1]}" does not resolve — double-check the user's email address.` };

  // 2. Résoudre UN expert, sans ambiguïté.
  const r = await resolveExperts(args);
  if (r.error) return r;
  if (!r.matches.length) return { error: 'No listed expert matches this query — use trouver_expert to explore, or broaden the search.' };
  if (r.matches.length > 1) {
    return {
      error: `Ambiguous: ${r.matches.length} experts match. Add "secteur" (and province) to identify exactly one.`,
      candidates: r.matches.slice(0, 10).map((e) => ({ name: e.name, profession: e.professionLabel, location: `${e.sectorName}, ${e.cityName}`, url: mcpSrc(e.url) })),
    };
  }
  const expert = r.matches[0];

  // 3. Retrait de l'expert (audit §8e) : respecté avant toute chose.
  if (env.COUNTERS && (await env.COUNTERS.get(`optout:${expert.slug}`))) {
    return { error: `This expert has opted out of relayed requests. The user can reach them via their profile page: ${mcpSrc(expert.url)}` };
  }

  // 4. Plafond par DEMANDEUR (audit §8b) — compteur sur empreinte HMAC, jamais l'adresse en clair.
  const day = new Date().toISOString().slice(0, 10);
  if (env.COUNTERS) {
    const rh = (await hmacHex(env, courriel)).slice(0, 16);
    const rN = await bumpCounter(env, `r:${rh}:${day}`, 3 * 86400);
    if (rN > DAY_CAP_REQUESTER) return { error: 'Daily limit reached for this requester — please try again tomorrow.' };
  }

  // 5. Modes dégradés : sans KV ou sans courriel, on répète sans rien envoyer ni stocker.
  if (!env.COUNTERS || !env.RESEND_API_KEY) {
    return {
      simulated: true,
      pendingConfirmation: true,
      note: 'DRY RUN — service not fully configured; nothing was stored or sent. In production, a confirmation link would be emailed to the user, and the request would reach the expert only after they click it (valid 48 h).',
      expert: { name: expert.name, profession: expert.professionLabel, url: mcpSrc(expert.url) },
    };
  }

  // 6. Demande en attente (KV, TTL 48 h) + lien de confirmation au DEMANDEUR.
  const token = crypto.randomUUID();
  await env.COUNTERS.put(`p:${token}`, JSON.stringify({
    slug: expert.slug, nom, courriel,
    tel: args.client_telephone ? String(args.client_telephone).trim() : null,
    message, lang: expert.lang, created: new Date().toISOString(),
    origine: args.origine === 'bandeau-ef' ? 'bandeau-ef' : 'ia',
    efType: args.ef_type ?? null, efProv: args.ef_province ?? null,
  }), { expirationTtl: PENDING_TTL });

  const frC = expert.lang === 'fr';
  const confirmUrl = `${WORKER_ORIGIN}/confirm?t=${token}`;
  const confRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
      to: [courriel],
      subject: frC
        ? `Confirmez votre demande de contact — ${expert.name} (Payotte)`
        : `Confirm your contact request — ${expert.name} (Payotte)`,
      text: (frC
        ? [
            `Bonjour ${nom},`, '',
            args.origine === 'bandeau-ef'
              ? `Vous avez rempli sur payotte.com une demande pour ${expert.name} (${expert.professionLabel}, ${expert.sectorName}, ${expert.cityName}).`
              : `Votre assistant IA a préparé, avec votre accord, une demande de contact pour ${expert.name} (${expert.professionLabel}, ${expert.sectorName}, ${expert.cityName}).`, '',
            `Votre message :`, message, '',
            `Pour la transmettre, cliquez (valide 48 h) :`, confirmUrl, '',
            `Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel — RIEN ne sera envoyé sans ce clic.`, '',
            `Payotte ne conserve pas le contenu de votre demande. https://payotte.com`,
          ]
        : [
            `Hello ${nom},`, '',
            args.origine === 'bandeau-ef'
              ? `You filled in a request on payotte.com for ${expert.name} (${expert.professionLabel}, ${expert.sectorName}, ${expert.cityName}).`
              : `Your AI assistant prepared, with your approval, a contact request for ${expert.name} (${expert.professionLabel}, ${expert.sectorName}, ${expert.cityName}).`, '',
            `Your message:`, message, '',
            `To send it, click (valid 48 h):`, confirmUrl, '',
            `If you did not initiate this request, ignore this email — NOTHING will be sent without this click.`, '',
            `Payotte keeps no copy of your request. https://payotte.com`,
          ]).join('\n'),
    }),
  });
  if (!confRes.ok) {
    await env.COUNTERS.delete(`p:${token}`);
    return { error: `Could not email the confirmation link (HTTP ${confRes.status}). The user can contact the expert from their profile page: ${mcpSrc(expert.url)}` };
  }

  return {
    pendingConfirmation: true,
    sent: false,
    expert: { name: expert.name, profession: expert.professionLabel, location: `${expert.sectorName}, ${expert.cityName}`, url: mcpSrc(expert.url) },
    note: frC
      ? `Un lien de confirmation vient d'être envoyé à ${courriel}. La demande ne sera transmise à ${expert.name} QU'APRÈS le clic (lien valide 48 h). Dites à l'utilisateur de vérifier sa boîte de réception.`
      : `A confirmation link was just emailed to ${courriel}. The request will reach ${expert.name} ONLY AFTER the click (link valid 48 h). Tell the user to check their inbox.`,
    attribution: ATTRIBUTION,
  };
}

// PHASE 2 (route /confirm) — le clic humain déclenche le relais réel vers l'expert.
async function confirmRelay(env, url) {
  const token = String(url.searchParams.get('t') ?? '');
  if (!env.COUNTERS || !/^[0-9a-f-]{36}$/.test(token)) return subPage('fr', 'Lien invalide / Invalid link', 'Ce lien de confirmation est invalide. / This confirmation link is invalid.');
  const raw = await env.COUNTERS.get(`p:${token}`);
  if (!raw) return subPage('fr', 'Lien expiré / Expired link', 'Ce lien a expiré (48 h) ou a déjà été utilisé. Redemandez à votre assistant. / This link expired (48 h) or was already used.');
  const pending = JSON.parse(raw);
  const fr = pending.lang === 'fr';
  const { nom, courriel, message } = pending;

  // L'expert et son courriel, relus à la source au moment du clic (jamais figés en KV).
  let expert = null;
  try { expert = (await allExperts()).find((e) => e.slug === pending.slug) ?? null; } catch { /* feed indispo */ }
  if (!expert) return subPage(pending.lang, fr ? 'Fiche introuvable' : 'Profile not found', fr ? "Cette fiche n'est plus publiée — la demande n'a pas été transmise." : 'This profile is no longer listed — the request was not relayed.');
  if (await env.COUNTERS.get(`optout:${expert.slug}`)) {
    await env.COUNTERS.delete(`p:${token}`);
    return subPage(pending.lang, fr ? 'Non transmis' : 'Not relayed', fr ? `${expert.name} ne reçoit plus de demandes relayées. Ses coordonnées publiques : ${expert.url}` : `${expert.name} has opted out of relayed requests. Public contact details: ${expert.url}`);
  }
  let contact = null;
  if (env.CONTACTS_TOKEN) { try { contact = (await feed(`/api/cx/${env.CONTACTS_TOKEN}.json`)).contacts?.[expert.slug] ?? null; } catch { /* annuaire indispo */ } }
  if (!contact) return subPage(pending.lang, fr ? 'Non transmis' : 'Not relayed', fr ? `Aucun courriel au dossier pour cet expert. Sa fiche : ${expert.url}` : `No email on file for this expert. Profile: ${expert.url}`);

  // Plafonds anti-abus, appliqués AU CLIC (compteurs agrégés — aucun contenu conservé).
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const gN = await bumpCounter(env, `g:${day}`, 3 * 86400);
  if (gN > DAY_CAP_GLOBAL) return subPage(pending.lang, fr ? 'Réessayez demain' : 'Try again tomorrow', fr ? 'Limite quotidienne de relais atteinte — recliquez le lien demain (il reste valide 48 h).' : 'Daily relay limit reached — click the link again tomorrow (valid 48 h).');
  const eN = await bumpCounter(env, `e:${expert.slug}:${day}`, 3 * 86400);
  if (eN > DAY_CAP_EXPERT) return subPage(pending.lang, fr ? 'Réessayez demain' : 'Try again tomorrow', fr ? 'Cet expert a atteint son maximum de demandes relayées aujourd’hui — recliquez demain.' : 'This expert reached today’s relayed-request maximum — click again tomorrow.');
  await bumpCounter(env, `m:${expert.slug}:${month}`, 400 * 86400); // futur rapport « les IA t'ont recommandé »
  if (pending.origine === 'bandeau-ef') await bumpCounter(env, `ef:c:${pending.efType}:${pending.efProv}:${month}`, 400 * 86400); // bandeau EF : demandes CONFIRMÉES
  // Trace de consentement MINIMALE (audit §8d, compatible « rien conservé ») :
  // horodatage + empreinte HMAC du courriel + expert — JAMAIS le contenu.
  await env.COUNTERS.put(`cl:${token}`, JSON.stringify({ ts: new Date().toISOString(), rh: (await hmacHex(env, courriel)).slice(0, 16), slug: expert.slug }), { expirationTtl: 400 * 86400 });

  const frX = contact.lang === 'fr';
  const subject = pending.origine === 'bandeau-ef'
    ? (frX
        ? `${pending.efType === 'contestation' ? 'Évaluation foncière contestée' : "Demande d'estimation"} via Payotte — ${nom}`
        : `${pending.efType === 'contestation' ? 'Assessment appeal' : 'Home estimate request'} via Payotte — ${nom}`)
    : frX
    ? `Nouvelle demande de contact via Payotte — ${nom}`
    : `New contact request via Payotte — ${nom}`;
  const lines = frX
    ? [
        `Bonjour ${contact.name},`, '',
        pending.origine === 'bandeau-ef'
          ? `Un propriétaire vous envoie une demande ${pending.efType === 'contestation' ? "au sujet de son évaluation foncière (il la trouve trop haute)" : "d'estimation de sa propriété"}, depuis les pages Évaluation foncière de Payotte, qui l'ont dirigé vers votre fiche (${expert.url}). Il a CONFIRMÉ sa demande lui-même (clic sur un lien reçu à son adresse). Payotte ne touche aucune commission.`
          : `Un client vous envoie une demande de contact via votre fiche Payotte (${expert.url}), préparée par son assistant IA et CONFIRMÉE par le client lui-même (clic sur un lien reçu à son adresse).`, '',
        `Nom : ${nom}`, `Courriel : ${courriel}`,
        ...(pending.tel ? [`Téléphone : ${pending.tel}`] : []), '',
        `Message :`, message, '',
        `— Répondez directement au client (bouton Répondre).`,
        `Payotte relaie sans conserver le contenu de cette demande. Pour ne plus recevoir de demandes relayées : répondez « retrait » à ce courriel. https://payotte.com`,
      ]
    : [
        `Hello ${contact.name},`, '',
        pending.origine === 'bandeau-ef'
          ? `A homeowner is sending you a request ${pending.efType === 'contestation' ? 'about their property assessment (they think it is too high)' : 'for an estimate of their home'}, from Payotte's property-assessment pages, which pointed them to your profile (${expert.url}). They CONFIRMED the request themselves (click on a link received at their address). Payotte takes no commission.`
          : `A client is sending you a contact request through your Payotte profile (${expert.url}), prepared by their AI assistant and CONFIRMED by the client themselves (click on a link received at their address).`, '',
        `Name: ${nom}`, `Email: ${courriel}`,
        ...(pending.tel ? [`Phone: ${pending.tel}`] : []), '',
        `Message:`, message, '',
        `— Reply directly to the client (Reply button).`,
        `Payotte relays this request without keeping its content. To stop receiving relayed requests: reply "opt out". https://payotte.com`,
      ];

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
      to: [contact.email],
      reply_to: courriel,
      subject,
      text: lines.join('\n'),
    }),
  });
  if (!res.ok) {
    return subPage(pending.lang, frX ? 'Échec du relais' : 'Relay failed', frX ? `L'envoi a échoué (HTTP ${res.status}) — recliquez le lien dans quelques minutes, ou joignez l'expert via sa fiche : ${expert.url}` : `Sending failed (HTTP ${res.status}) — click the link again in a few minutes, or reach the expert via their profile: ${expert.url}`);
  }

  await env.COUNTERS.delete(`p:${token}`);   // usage unique
  return subPage(pending.lang,
    frX ? 'Demande transmise ✓' : 'Request relayed ✓',
    frX
      ? `Votre demande a été transmise à ${expert.name} (${expert.professionLabel}, ${expert.cityName}). Sa réponse arrivera directement à ${courriel}. Payotte ne conserve pas le contenu de votre demande.`
      : `Your request was relayed to ${expert.name} (${expert.professionLabel}, ${expert.cityName}). The reply will arrive directly at ${courriel}. Payotte keeps no copy of your request.`,
    expert.url);
}

/* ── « LES IA VOUS ONT PRÉSENTÉ N FOIS » (28 sept. 2026) ──────────────────────────
   Compte, par expert et par mois, chaque fois que `trouver_expert` le renvoie à un
   assistant. C'est la preuve sociale du courriel de novembre aux experts, et elle ne
   peut pas se reconstituer après coup : ce qui n'est pas compté aujourd'hui est perdu.
   Clé `vu:{slug}:{AAAA-MM}` dans COUNTERS, même forme que `m:` (relais confirmés).
   Le slug se lit dans l'URL de la fiche : /canada/{prov}/{ville}/{secteur}/{profession}
   → `{profession}--{secteur}`, la forme de experts.json.
   ⚠ Un compteur qui échoue ne casse jamais la réponse (bumpCounter avale l'erreur). */
async function trouverExpertCompte(args, env) {
  const r = await trouverExpert(args);
  const mois = new Date().toISOString().slice(0, 7);
  const slugs = (r?.experts ?? []).map((e) => {
    try {
      const seg = new URL(e.url).pathname.replace(/\.html$/, '').split('/').filter(Boolean);
      return seg.length >= 5 ? `${seg[seg.length - 1]}--${seg[seg.length - 2]}` : null;
    } catch { return null; }
  }).filter(Boolean);
  await Promise.all(slugs.map((s) => bumpCounter(env, `vu:${s}:${mois}`, 400 * 86400)));
  return r;
}

// ---------------------------------------------------------------- évaluation foncière (2026-09-28)
/* Trois outils de la verticale « Évaluation foncière » (payotte.com/evaluation-fonciere).
   Faits vérifiés à la source le 2026-09-28 (docs/evaluation-fonciere/FAITS.md du dépôt du site) :
   - délai général : avant le 1er mai de la 1re année du rôle (LFM art. 130) ; 60 jours après
     l'avis SEULEMENT s'il est expédié après la fin février ou en retard (art. 131, 134) ;
     120 jours pour une unité de 3 M$ ou plus (art. 134) ;
   - frais : fixés par règlement municipal, plafonnés au tarif du TAQ (art. 263.2).
   Québec seulement. Hors Québec : on le dit, on n'applique jamais une règle québécoise ailleurs.
   Aucun outil ne prend une adresse, un matricule ni un nom : agrégats municipaux seulement. */
const EF_SOURCES = {
  calendrier: `${SITE}/evaluation-fonciere/calendrier-quebec`,
  guide: `${SITE}/evaluation-fonciere/contester-evaluation-fonciere-quebec`,
  quebecCa: 'https://www.quebec.ca/habitation-territoire/information-fonciere/evaluation-fonciere/demander-revision',
  lfm: 'https://www.legisquebec.gouv.qc.ca/fr/document/lc/F-2.1',
  taqFrais: 'https://www.taq.gouv.qc.ca/recours-au-tribunal/expropriation/frais-de-recours-frais-de-justice',
  oeaq: 'https://www.oeaq.qc.ca/',
};
const EF_RENVOI = `For a plex, an income property or a TAQ appeal, suggest a chartered appraiser (évaluateur agréé): use trouver_expert with profession "appraiser", or the OEAQ directory (${EF_SOURCES.oeaq}) where Payotte lists none.`;
// Paliers de frais (valeur max incluse → frais), relevés sur les pages officielles le 2026-09-28.
const EF_PALIERS = [500000, 2000000, 5000000, Infinity];
const EF_FRAIS = {
  montreal: { nom: 'Montréal', frais: [90, 360, 605, 1215], source: 'https://montreal.ca/demarches/demander-une-revision-du-role-devaluation-fonciere', note: 'Non-refundable (agglomeration by-law).' },
  quebec: { nom: 'Québec', frais: [85, 355, 590, 1180], source: 'https://www.ville.quebec.qc.ca/citoyens/taxes_evaluation/evaluation_fonciere/revision.aspx' },
  laval: { nom: 'Laval', frais: [85, 350, 575, 1150], source: 'https://www.laval.ca/taxes-evaluation-fonciere/evaluation-fonciere/demander-revision-role-evaluation-fonciere/', note: 'Read from the official page as of 2025-11-09 (archived copy); confirm on laval.ca.' },
  gatineau: { nom: 'Gatineau', frais: [80, 325, 574.5, 1149.25], source: 'https://www.gatineau.ca/portail/default.aspx?p=guichet_municipal%2Fevaluation_fonciere', note: 'By-law 943-2023; may be revised for the 2027 roll.' },
};
const EF_TAQ_2026 = [93.2, 372.6, 621.1, 1242.5];
const efPalier = (v) => EF_PALIERS.findIndex((max) => v <= max);
/* ── ÉCONOMIE POSSIBLE À L'ADRESSE (30 sept. 2026) ─────────────────────────────────────
   Grégory : « la réponse n'est pas assez évidente, peut-on chiffrer une fourchette d'économie ? »
   Oui au Québec, sans rien demander au visiteur : le MAMH publie le taux résidentiel ADOPTÉ de
   chaque municipalité (prévisions 2026, S57 ; scripts/construire-taux-qc.py). Seulement quand la
   valeur ressort AU-DESSUS des semblables : dans la norme, aucun chiffre, on le dit.
   Deux hypothèses, jamais une prédiction : (1) la hausse ramenée à la hausse médiane des
   semblables, propre à CETTE propriété ; (2) une baisse typique de 8 à 10 % quand une demande
   aboutit (La Presse, Montréal, sept. 2025 — donnée de presse, on le dit). La fourchette va du
   plus petit au plus grand des trois montants. Taxes municipales seulement : ni taxe scolaire, ni
   tarifs ; Montréal sans les taxes d'arrondissement (donc un minimum). */
const EF_BAISSES_TYPIQUES = [0.08, 0.10];
function efEconomie(x, codeMuni) {
  if (!x || !(x.valeur > 0)) return null;
  const taux = TAUX_QC.taux[codeMuni];
  if (!taux) return { statut: 'sans-taux' };
  // taxeAnnuelle : la part municipale de la taxe foncière à ce taux, pour la valeur au rôle (30 sept.,
  // « d'autres infos pour rendre ça plus intéressant »). Mêmes réserves : ni scolaire, ni tarifs.
  const base = { taux, annee: TAUX_QC.annee, source: TAUX_QC.source, partiel: codeMuni === '66023', taxeAnnuelle: Math.round((x.valeur / 100) * taux) };
  if (x.signal !== 'eleve' && x.signal !== 'au-dessus') return { ...base, statut: 'norme' };
  const baisses = EF_BAISSES_TYPIQUES.map((p) => Math.round(x.valeur * p));
  const c = x.comparables;
  let ecartMediane = null;
  if (x.valeurAnt > 0 && c?.hausseMediane != null) {
    const cible = x.valeurAnt * (1 + c.hausseMediane / 100);
    if (x.valeur > cible) ecartMediane = Math.round(x.valeur - cible);
  }
  const montants = [...baisses, ...(ecartMediane ? [ecartMediane] : [])];
  const an = (b) => Math.round((b / 100) * taux);
  const bas = Math.min(...montants), haut = Math.max(...montants);
  const cle = strip(x.municipalite);
  const f = EF_FRAIS[cle === 'ville-de-quebec' ? 'quebec' : cle];
  const i = efPalier(x.valeur);
  return {
    ...base, statut: 'chiffre',
    baisse: { bas, haut }, parAn: { bas: an(bas), haut: an(haut) }, annees: 3,
    surRole: { bas: an(bas) * 3, haut: an(haut) * 3 },
    ecartMediane, baissesTypiques: baisses,
    frais: f ? { montant: f.frais[i], exact: true } : { montant: EF_TAQ_2026[i], exact: false },
  };
}

const efProvinceHorsQc = (args) => {
  const p = strip(args.province);
  return p && !['qc', 'quebec'].includes(p);
};
/* Hors Québec (2026-09-28) : règles de la province depuis /api/evaluation-fonciere-canada.json,
   compilé par le site à partir des sources officielles de chaque province. */
async function efReglesProvince(province) {
  const q = strip(province);
  const data = await feed('/api/evaluation-fonciere-canada.json');
  const p = (data.provinces ?? []).find((x) => [x.code, x.name, x.nom, x.slugPayotte].some((v) => strip(v) === q));
  if (!p) return { error: `Unknown province "${province}".`, available: (data.provinces ?? []).map((x) => x.name) };
  const r = p.rules ?? {};
  const en = (b) => (b && typeof b === 'object' ? b.en : b ?? null);
  return {
    province: p.name,
    assessor: en(r.organisme), cycle: en(r.cycle), valuationDate: en(r.dateEvaluation), notices: en(r.avis),
    deadline: en(r.delai), deadlineRule: r.delaiMachine ?? null,
    firstStep: en(r.premierRecours), appeal: en(r.appel), fees: en(r.frais),
    ...(r.hausse ? { canGoUp: en(r.hausse) } : {}),
    guide: p.hub?.en, guideFr: p.hub?.fr,
    sources: (r.sources ?? []).map((s) => s.url),
    caution: 'Rules compiled from official provincial sources (checked 2026-09-28). The owner’s assessment notice prevails.',
    referral: 'For an income property, a high value or an appeal board hearing, suggest a professional appraiser: use trouver_expert with profession "appraiser".',
    attribution: data.attribution ?? ATTRIBUTION,
  };
}

async function efMunicipalite(nom) {
  const q = strip(nom);
  if (!q) return { error: 'Parameter "municipalite" is required.' };
  const data = await feed('/api/evaluation-fonciere-quebec.json');
  const liste = data.municipalites ?? [];
  let m = liste.filter((x) => strip(x.nom) === q);
  if (!m.length) m = liste.filter((x) => strip(x.nom).startsWith(q) || q.startsWith(strip(x.nom)));
  if (!m.length) return { error: `No Quebec municipality matches "${nom}".`, hint: `Check the spelling (${EF_SOURCES.calendrier}). Outside Quebec, pass the "province" parameter (e.g. "BC", "Ontario") to get that province's rules.` };
  // Homonymes (plusieurs « Saint-… ») : la plus peuplée d'abord, les autres signalées.
  m.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  return { m: m[0], autres: m.slice(1, 6).map((x) => `${x.nom} (${x.region})`), data };
}

async function fenetreRevision(args = {}) {
  if (efProvinceHorsQc(args)) return efReglesProvince(args.province);
  const r = await efMunicipalite(args.municipalite);
  if (r.error) return r;
  const { m } = r;
  const auj = new Date().toISOString().slice(0, 10);
  const deadlineCourante = m.echeanceRoleActuel;
  let regleAvis = null;
  if (args.date_avis && /^\d{4}-\d{2}-\d{2}$/.test(args.date_avis)) {
    const avis = new Date(`${args.date_avis}T12:00:00Z`);
    const finFevrier = new Date(Date.UTC(avis.getUTCFullYear(), 2, 0, 23, 59));
    if (avis > finFevrier) {
      const j60 = new Date(avis.getTime() + 60 * 86400000).toISOString().slice(0, 10);
      regleAvis = { applies: true, deadline: j60, note: 'Notice mailed after the end of February: 60 days after the notice, if later than April 30 (LFM s. 131, 134).' };
    } else {
      regleAvis = { applies: false, note: 'Notice mailed before March 1: the general deadline (before May 1) applies.' };
    }
  }
  return {
    municipalite: m.nom,
    region: m.region,
    currentRoll: { years: `${m.premierExercice}-${m.dernierExercice}`, referenceDate: m.dateReference, referenceDateNote: 'Values reflect the market on this date (LFM s. 46), not today’s market.' },
    generalDeadlineCurrentRoll: deadlineCourante,
    currentRollWindowOpen: auj <= deadlineCourante,
    nextRoll: { firstYear: m.prochainRole, generalDeadline: m.echeanceProchainRole },
    lateNoticeRule: regleAvis ?? 'If the assessment notice is mailed after the end of February (or late), the deadline is 60 days after the notice when that is later. Units assessed at $3M or more: 120 days, unless the municipality posts the roll online within 60 days of filing it.',
    midRollRules: 'After an amendment notice (avis de modification): before May 1 or 60 days after the notice, whichever is later (LFM s. 132). If the assessor failed to make a change: during the year of the event or the next (s. 131.2).',
    ...(m.reconduitProbable ? { caution: 'The reference date on this roll is older than the rule provides: the roll was probably carried over without rebalancing.' } : {}),
    ...(r.autres.length ? { otherMatches: r.autres } : {}),
    calculated: 'Roll end year, next roll and deadlines are CALCULATED from the general rule; the owner’s assessment notice prevails.',
    referral: EF_RENVOI,
    guide: EF_SOURCES.guide,
    sources: [EF_SOURCES.calendrier, EF_SOURCES.quebecCa, EF_SOURCES.lfm, r.data.dataSourceUrl].filter(Boolean),
    attribution: r.data.attribution ?? ATTRIBUTION,
  };
}

async function fraisRevision(args = {}) {
  if (efProvinceHorsQc(args)) {
    const r = await efReglesProvince(args.province);
    return r.error ? r : { province: r.province, fees: r.fees, firstStep: r.firstStep, appeal: r.appeal, guide: r.guide, sources: r.sources, caution: r.caution, attribution: r.attribution };
  }
  const valeur = Number(args.valeur);
  if (!Number.isFinite(valeur) || valeur <= 0) return { error: 'Parameter "valeur" (assessed value on the roll, CAD) is required.' };
  const q = strip(args.municipalite);
  if (!q) return { error: 'Parameter "municipalite" is required.' };
  const i = efPalier(valeur);
  const cle = q === 'quebec-city' || q === 'ville-de-quebec' ? 'quebec' : q;
  const f = EF_FRAIS[cle];
  const plafond = { taqFee2026: EF_TAQ_2026[i], note: 'By law, a municipality’s filing fee cannot exceed the TAQ fee for the same unit (LFM s. 263.2).', source: EF_SOURCES.taqFrais };
  if (!f) {
    return {
      municipalite: args.municipalite,
      assessedValue: valeur,
      fee: null,
      status: 'not collected',
      message: 'Payotte has not read this municipality’s fee by-law yet. The fee is set by municipal by-law and depends on the assessed value; check the municipality or the body responsible for assessment (city or MRC).',
      maximum: plafond,
      covered: Object.values(EF_FRAIS).map((x) => x.nom),
      attribution: ATTRIBUTION,
    };
  }
  return {
    municipalite: f.nom,
    assessedValue: valeur,
    fee: f.frais[i],
    bracket: ['$500,000 or less', '$500,001 to $2M', '$2M to $5M', 'over $5M'][i],
    feeSchedule: { '≤500000': f.frais[0], '500001-2000000': f.frais[1], '2000001-5000000': f.frais[2], '>5000000': f.frais[3] },
    ...(f.note ? { note: f.note } : {}),
    maximum: plafond,
    reminder: 'Without payment of the fee, the request is deemed not filed (LFM s. 135). One request per assessment unit.',
    sources: [f.source, EF_SOURCES.lfm],
    attribution: ATTRIBUTION,
  };
}

async function estimerEconomie(args = {}) {
  if (efProvinceHorsQc(args)) return { error: 'Province not covered yet: Quebec only.' };
  const valeur = Number(args.valeur), baisseIn = Number(args.baisse), taux = Number(args.taux);
  if (!Number.isFinite(valeur) || valeur <= 0) return { error: 'Parameter "valeur" (assessed value, CAD) is required.' };
  if (!Number.isFinite(baisseIn) || baisseIn <= 0) return { error: 'Parameter "baisse" is required: a hypothetical reduction in CAD (e.g. 30000) or as a fraction (e.g. 0.08).' };
  if (!Number.isFinite(taux) || taux <= 0 || taux > 10) return { error: 'Parameter "taux" is required: the property-tax rate in $ per $100 of assessment, as printed on the user’s tax bill (e.g. 0.75). Payotte does not guess municipal rates.' };
  const baisse = baisseIn <= 1 ? Math.round(valeur * baisseIn) : baisseIn;
  const annuelle = Math.round((baisse / 100) * taux * 100) / 100;
  let annees = Number(args.annees_restantes);
  let anneesSource = 'given';
  if (!Number.isFinite(annees) || annees <= 0 || annees > 3) {
    annees = 3; anneesSource = 'default: a reduction obtained in the first year of a roll applies to its 3 years';
    if (args.municipalite) {
      try {
        const r = await efMunicipalite(args.municipalite);
        if (!r.error) {
          const an = new Date().getUTCFullYear();
          annees = Math.max(1, Math.min(3, r.m.dernierExercice - Math.max(an, r.m.premierExercice) + 1));
          anneesSource = `remaining years of the ${r.m.premierExercice}-${r.m.dernierExercice} roll of ${r.m.nom}`;
        }
      } catch { /* calendrier indisponible : on garde 3 ans, et on le dit */ }
    }
  }
  const frais = args.municipalite ? await fraisRevision({ municipalite: args.municipalite, valeur }) : null;
  const fee = frais && typeof frais.fee === 'number' ? frais.fee : null;
  const surRole = Math.round(annuelle * annees * 100) / 100;
  return {
    assumption: `A HYPOTHETICAL reduction of $${baisse.toLocaleString('en-CA')} chosen by the user — not a prediction.`,
    taxRate: `${taux} $ per $100 (from the user’s tax bill)`,
    yearlySaving: annuelle,
    years: annees, yearsBasis: anneesSource,
    savingOverRoll: surRole,
    filingFee: fee ?? 'not collected for this municipality (see frais_revision)',
    ...(fee != null ? { netAfterFee: Math.round((surRole - fee) * 100) / 100 } : {}),
    sameAmountIncrease: { yearlyExtraTax: annuelle, note: 'A review request can also RAISE the value (municipal assessment bodies warn of it); the same amount upward would cost this much per year.' },
    context: 'Press data only (La Presse, Sept. 2025): in Montreal, about 40% of review requests lead to a decrease, typically 8–10%. Most requests do not lower the value.',
    referral: EF_RENVOI,
    guide: `${SITE}/evaluation-fonciere/cout-contestation-evaluation-fonciere`,
    attribution: ATTRIBUTION,
  };
}

// ── Outils MCP du bandeau (29 sept. 2026) : ils rappellent les routes /ef/* du worker lui-même,
// pour qu'un assistant obtienne EXACTEMENT ce que voit le visiteur du site. Nom de municipalité
// accepté (résolu contre la liste ouverte de la province), province en nom ou en code.
const EF_PROV_CODE = { quebec: 'qc', 'nova-scotia': 'ns', 'new-brunswick': 'nb', alberta: 'ab', manitoba: 'mb', ontario: 'on', 'british-columbia': 'bc', saskatchewan: 'sk', 'prince-edward-island': 'pe', 'newfoundland-and-labrador': 'nl' };
async function efAppel(chemin, params, env) {
  const u = new URL(`${WORKER_ORIGIN}${chemin}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const r = await WORKER_MAIN.fetch(new Request(u), env, { waitUntil() {} });
  return { ...(await r.json()), attribution: ATTRIBUTION, tool: `${SITE}/${chemin === '/ef/taxe' ? 'acheter' : 'mon-adresse'}` };
}
async function efResoudre(args, env) {
  const slug = resolveAlias(PROVINCE_ALIASES, args.province);
  const prov = slug ? EF_PROV_CODE[slug] : null;
  if (!prov) return { error: 'Unknown "province". Use a Canadian province name or code (QC, NS, NB, AB, MB…).' };
  if (!args.municipalite) return { prov };
  const liste = await efMunis(env, prov);
  if (!liste) return { prov, error: `No open address-level assessment data for this province. Address answers cover Quebec, Nova Scotia, New Brunswick, Winnipeg (MB) and seven Alberta cities.` };
  const n = strip(args.municipalite);
  const m = liste.find(([, nom]) => strip(nom) === n) ?? liste.find(([, nom]) => strip(nom).startsWith(n) || n.startsWith(strip(nom)));
  if (!m) return { prov, error: `Municipality "${args.municipalite}" not found in this province's open roll.` };
  return { prov, muni: m[0] };
}
async function evaluationAdresse(args = {}, env = {}) {
  const r = await efResoudre(args, env);
  if (r.error) return r;
  if (!args.adresse) return { error: 'Give "adresse" (civic number first, e.g. "1234 rue Principale, app. 5").' };
  return efAppel('/ef/adresse', { prov: r.prov, muni: r.muni, q: args.adresse, lang: args.lang, t: 'contestation' }, env);
}
async function taxeBienvenueAdresse(args = {}, env = {}) {
  const r = await efResoudre(args, env);
  if (r.error && !(args.prix && !args.adresse)) return r;
  if (!(Number(args.prix) > 0)) return { error: 'Give "prix" (purchase price in CAD).' };
  return efAppel('/ef/taxe', { prov: r.prov, muni: args.adresse ? r.muni : null, q: args.adresse, prix: args.prix, lang: args.lang }, env);
}
async function risquesAnneeConstruction(args = {}, env = {}) {
  const r = await efResoudre(args, env);
  if (r.error && !args.annee) return r;
  return efAppel('/ef/risques', { prov: r.prov, muni: r.muni, q: args.adresse, annee: args.annee, muniNom: args.municipalite, lang: args.lang }, env);
}

const TOOL_IMPL = {
  fenetre_revision: fenetreRevision,
  frais_revision: fraisRevision,
  estimer_economie: estimerEconomie,
  trouver_expert: trouverExpertCompte,
  verifier_titre: verifierTitre,
  stats_marche: statsMarche,
  taux_courants: tauxCourants,
  taxe_mutation: taxeMutation,
  acheter_ou_louer: acheterOuLouer,
  salaire_requis: salaireRequis,
  contacter_expert: contacterExpert,
  evaluation_adresse: evaluationAdresse,
  taxe_bienvenue_adresse: taxeBienvenueAdresse,
  risques_annee_construction: risquesAnneeConstruction,
};

// ---------------------------------------------------------------- bulletin de marché (audience possédée)
// Abonnement zéro-JS depuis les pages ville (POST de formulaire pur), bienvenue immédiate
// avec les stats de la ville, envoi mensuel par cron. On ne stocke QUE courriel+ville+langue
// +date de consentement (LCAP) dans KV. Désabonnement en un clic (HMAC, clé = CONTACTS_TOKEN).

const SUB_CAP_DAY = 30;   // garde-fou anti-abus sur les inscriptions
// Le plafond d'envois par exécution n'est plus un chiffre en dur : il se déduit du budget
// de sous-requêtes, plus bas (SUBREQUEST_BUDGET).

async function hmacHex(env, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.CONTACTS_TOKEN || 'dev'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function subPage(lang, title, message, cityUrl) {
  const fr = lang === 'fr';
  const back = cityUrl ? `<p><a href="${esc(cityUrl)}">${fr ? '← Retour à la page de la ville' : '← Back to the city page'}</a></p>` : `<p><a href="${SITE}">payotte.com</a></p>`;
  return new Response(
    `<!doctype html><html lang="${fr ? 'fr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1a1a1a;line-height:1.6}h1{font-size:1.4em}a{color:#C8102E}</style></head><body><h1>${esc(title)}</h1><p>${esc(message)}</p>${back}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } },
  );
}

const fmtMoney = (n, fr) => (n == null ? null : fr ? `${n.toLocaleString('fr-CA')} $` : `$${n.toLocaleString('en-CA')}`);
const fmtPct = (p, fr) => (p == null ? null : `${p >= 0 ? '+' : ''}${p.toLocaleString(fr ? 'fr-CA' : 'en-CA')} %`);

// Prix de référence du bulletin, avec la variation annuelle QUI LUI CORRESPOND.
// Piège écarté ici : afficher benchmarkYoyPct à côté d'un prix moyen accolerait la
// variation d'une mesure à la valeur d'une autre. Pour la médiane, benchmarkYoyPct
// EST la bonne variation (les villes québécoises y rangent celle de leur médiane).
const refOf = (c) => (
  c?.benchmarkHpi != null ? { valeur: c.benchmarkHpi, yoy: c.benchmarkYoyPct ?? null, genre: 'benchmark' }
  : c?.medianPrice != null ? { valeur: c.medianPrice, yoy: c.benchmarkYoyPct ?? null, genre: 'median' }
  : c?.averagePrice != null ? { valeur: c.averagePrice, yoy: c.averageYoyPct ?? null, genre: 'average' }
  : { valeur: null, yoy: null, genre: null });

const refLabelOf = (genre, fr) => (
  genre === 'benchmark' ? (fr ? 'Prix repère MLS' : 'MLS benchmark price')
  : genre === 'median' ? (fr ? 'Prix médian' : 'Median price')
  : (fr ? 'Prix moyen' : 'Average price'));

// Compose le bulletin depuis /api/market.json — champs présents seulement, rien d'inventé.
function bulletinText(city, lang, unsubUrl, welcome) {
  const fr = lang === 'fr';
  const ref0 = refOf(city);
  const refPrice = ref0.valeur;
  const refLabel = refLabelOf(ref0.genre, fr);
  const L = [];
  L.push(fr ? `Le pouls du marché — ${city.name}` : `Market pulse — ${city.name}`);
  if (city.referenceMonth) L.push(fr ? `(données de référence : ${city.referenceMonth}, ${city.board ?? 'chambre immobilière'})` : `(reference data: ${city.referenceMonth}, ${city.board ?? 'real-estate board'})`);
  L.push('');
  if (refPrice != null) L.push(`• ${refLabel} : ${fmtMoney(refPrice, fr)}${ref0.yoy != null ? ` (${fmtPct(ref0.yoy, fr)} ${fr ? 'sur un an' : 'year over year'})` : ''}`);
  if (city.sales != null) L.push(`• ${fr ? 'Ventes' : 'Sales'} : ${city.sales.toLocaleString(fr ? 'fr-CA' : 'en-CA')}${city.salesYoyPct != null ? ` (${fmtPct(city.salesYoyPct, fr)})` : ''}`);
  if (city.monthsOfInventory != null) L.push(`• ${fr ? "Mois d'inventaire" : 'Months of inventory'} : ${city.monthsOfInventory}`);
  if (city.avgDaysOnMarket != null) L.push(`• ${fr ? 'Délai de vente moyen' : 'Average days on market'} : ${city.avgDaysOnMarket} ${fr ? 'jours' : 'days'}`);
  if (city.growth5yPct != null) L.push(`• ${fr ? 'Croissance sur 5 ans' : '5-year growth'} : ${fmtPct(city.growth5yPct, fr)}`);
  L.push('');
  L.push(fr
    ? `Besoin d'un professionnel de confiance ? Un seul expert vérifié par secteur et par métier, permis publié : ${SITE}`
    : `Need a professional you can trust? One verified expert per sector and trade, licence published: ${SITE}`);
  if (Array.isArray(city.sources) && city.sources.length) L.push('', (fr ? 'Sources : ' : 'Sources: ') + city.sources.join(' · '));
  L.push('', '—');
  // ── VOIE DE CONTACT (2026-08-25) ─────────────────────────────────────────────────
  // Depuis le passage en no-reply, ces deux lignes ne sont PAS décoratives : le
  // formulaire est le SEUL moyen de joindre Payotte, et c'est lui qui satisfait
  // l'obligation LCAP d'un moyen de contact valide 60 jours (une adresse web y suffit).
  // Ne jamais les retirer sans rétablir d'abord une adresse de réponse qui reçoit.
  L.push(fr
    ? `Ce courriel part d'une adresse qui ne reçoit pas. Pour nous écrire — correction,`
    : `This message is sent from an address that does not accept replies. To reach us —`);
  L.push(fr
    ? `question, retrait — utilisez le formulaire : ${SITE}/contact`
    : `a correction, a question, a removal — use the form: ${SITE}/contact`);
  L.push('', fr
    ? `Vous recevez ce courriel parce que vous vous êtes abonné au bulletin de ${city.name} sur payotte.com.${welcome ? ' (Voici votre premier bulletin, envoyé sur-le-champ.)' : ''}`
    : `You are receiving this because you subscribed to the ${city.name} bulletin on payotte.com.${welcome ? ' (Here is your first bulletin, sent right away.)' : ''}`);
  L.push(fr ? `Se désabonner (un clic) : ${unsubUrl}` : `Unsubscribe (one click): ${unsubUrl}`);
  return L.join('\n');
}

async function sendBulletin(env, origin, email, city, lang, welcome = false) {
  const t = await hmacHex(env, `u:${email}:${city.slug}`);
  const unsubUrl = `${origin}/unsubscribe?e=${encodeURIComponent(email)}&c=${encodeURIComponent(city.slug)}&t=${t}`;
  const fr = lang === 'fr';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
      to: [email],
      reply_to: REPLY_TO,
      subject: fr ? `Le pouls du marché — ${city.name}` : `Market pulse — ${city.name}`,
      text: bulletinText(city, lang, unsubUrl, welcome),
      headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }),
  });
  return res.ok;
}

// ================================================================
// MACHINE DU BULLETIN — segmentation prospect/expert + étape + rendu HTML
// ================================================================
// S'ADAPTE AUX MODIFS DU MOIS : la machine lit l'état VIVANT à chaque envoi —
// /api/market.json (marché) et /api/experts/{prov}.json (score.color, ownerVerified,
// badgeExchange). Un prix rafraîchi, une fiche confirmée, un badge posé ou un score
// monté pendant le mois est donc reflété automatiquement au prochain 1er. Aucun état
// figé n'est mémorisé. Données = champs PRÉSENTS seulement, jamais d'analyse inventée (Règle #3).

const LOGO = 'https://payotte.com/payotte-logo-transparent.png';
// Plus de copie BCC de chaque envoi (décision proprio, 2 août 2026 : illisible à 500 courriels).
// À la place, UN récapitulatif par exécution — sans lui, un envoi raté ne laisse aucune trace.
const REPORT_TO = 'gpayotte@gmail.com';

// ⚠️ ADRESSE DE RÉPONSE — NO-REPLY ASSUMÉ (décision proprio, 2026-08-25).
//
// L'HISTOIRE. `gregory@payotte.com` a été le reply_to de TOUS les envois jusqu'au
// 2026-08-19. Or `payotte.com` n'a AUCUN enregistrement MX : le renvoi GoDaddy est mort
// (dernier courriel reçu : 26 mai 2026). Pendant au moins trois mois, chaque courriel qui
// disait « répondez à ce courriel » envoyait la réponse dans le vide — les 217
// présentations ⓪ comprises. Le 19 août, on a basculé sur `gpayotte@gmail.com` : ça
// marchait, mais ça affichait une adresse Gmail sur un annuaire qui publie des numéros
// de permis.
//
// POURQUOI PAS DE BOÎTE. Vérifié au compte GoDaddy le 2026-08-25 : l'abonnement
// Microsoft 365 a expiré le 2026-08-06 et il portait `info@recharges.ca`, pas payotte.com ;
// le produit de renvoi courriel est lié à `wheelster.com` (le formulaire « Add Forward » a
// le domaine figé, sans sélecteur) ; l'onglet « Forwarding » du domaine ne fait que du
// renvoi WEB. Aucune boîte disponible sans achat.
//
// LA DÉCISION. Plutôt que d'acheter une boîte, le contact passe par le SITE. C'est le
// modèle des grosses agences, et la LCAP l'accepte : l'article 2(2) du Règlement demande
// une adresse postale PLUS un moyen de contact valide 60 jours, et une ADRESSE WEB
// satisfait ce second point. Le formulaire est donc la voie officielle, et il doit être
// écrit NOIR SUR BLANC dans chaque message — voir `bulletinText()`, ce n'est pas
// décoratif, c'est la conformité.
//
// CE QUE ÇA COÛTE, ET C'EST ASSUMÉ. Les réponses spontanées se perdent. Elles avaient de
// la valeur : `19a27f6` — Chris Allard a répondu avec son année et son permis, sa fiche
// est passée de 66 à 94. Ce chemin-là se ferme ; celui du formulaire s'ouvre.
//
// ⚠️ CE QUI RESTE OUVERT ET QUE CECI NE RÈGLE PAS : `ADRESSE_POSTALE` est toujours absent
// (voir `adressePostale()`), et c'est l'AUTRE moitié de l'obligation LCAP. Le no-reply ne
// la remplace pas — une adresse web sans adresse postale reste non conforme.
const REPLY_TO = 'noreply@payotte.com';   // même orthographe que $FROM du contact-handler.php

// Jours entre le relevé d'une fiche (`verifiedDate`) et le droit de présenter Payotte à
// son professionnel. Voir `expertStage()`.
const QUARANTAINE_INTRO_JOURS = 7;

// Étape d'un expert d'après son état vivant. `introduced` = il a déjà reçu la présentation ⓪.
// OPT-OUT (décision proprio, 2 août 2026) : personne n'a à dire « oui ». Après la présentation,
// l'expert monte dans l'escalier ①②③④ d'office, chaque mois, jusqu'à ce qu'il dise non
// (clic sur le lien de désabonnement → clé `unsub:{slug}`, seul motif d'exclusion).
function expertStage(expert, introduced) {
  const c = expert?.score?.color;
  if (!c || c === 'red') return null;          // rouge = non publié → pas de bulletin
  // ── QUARANTAINE DE LA PRÉSENTATION (2026-08-19) ──────────────────────────────────
  // La ⓪ dit « c'est vous que j'ai retenu, sur la foi de données publiques » : elle ne
  // doit jamais partir sur une fiche qui vient d'être relevée et pas encore relue. Sept
  // jours après `verifiedDate`, c'est le délai pendant lequel une erreur de relevé se
  // corrige encore sans que personne dehors ne l'ait vue. Précédent : les deux agents qui
  // ont FABRIQUÉ une ancienneté en juillet (« licensed since 2005 » introuvable sur le
  // site cité) — une ⓪ partie le jour même aurait porté ce chiffre inventé au principal
  // intéressé. Le coût du délai est nul : l'expert entre au cycle suivant.
  // Une fiche sans `verifiedDate` n'est pas retenue en quarantaine (le champ manque sur
  // ~10 fiches anciennes) — on ne bloque pas sur une donnée absente, on ne devine pas.
  if (!introduced && expert?.verifiedDate) {
    const jours = (Date.now() - Date.parse(expert.verifiedDate)) / 86400000;
    if (Number.isFinite(jours) && jours < QUARANTAINE_INTRO_JOURS) return null;
  }
  if (!introduced) return 'intro';             // ⓪ présentation (une seule fois dans la vie)
  if (c === 'yellow') return 'yellow';         // ① monter vers le vert
  if (!expert.ownerVerified) return 'green';   // ② confirmer → Recommandé
  if (!expert.badgeExchange) return 'reco';    // ③ poser le badge
  return 'partner';                            // ④ rien à demander
}

/* ── LA PHRASE DES CITATIONS ─────────────────────────────────────────────────
 * ⚠⚠ CE QU'ELLE A REMPLACÉ, ET POURQUOI IL NE FAUT PAS Y REVENIR (8 sept. 2026).
 * Le courriel disait : « c'est elle que les IA citent quand on cherche un notaire à
 * Laval ». C'était FAUX, et mesurable comme tel. Sur les 30 jours au 8 septembre,
 * Bing Webmaster Tools (AI Performance) compte ~3 000 citations de payotte.com par
 * Copilot : les pages de prix et de coûts en tête, 77 citations vers l'annuaire, et
 * 12 citations réparties sur SIX fiches individuelles. Pour les 573 autres experts,
 * la phrase promettait quelque chose qui n'est jamais arrivé.
 * Le council du 18 août l'avait déjà écrit — risque R6, « chiffre faux envoyé à un
 * pro, réputation » — après avoir corrigé la même erreur sous une autre forme
 * (« 244 citations/sem des fiches »). Elle est revenue. D'où ce commentaire.
 *
 * LA RÈGLE : on énonce ce que le SITE reçoit, jamais ce que LA FICHE recevra. Le
 * lecteur fait le rapprochement lui-même ; nous ne le faisons pas à sa place.
 *
 * ⚠ ET LE CHIFFRE PÉRIME. `rates.json` avait un mois de retard en août pendant que
 * l'outil MCP lisait la Banque du Canada en direct (council C19) : une mesure figée
 * dans du code vieillit en silence. Passé la péremption, la phrase se retire toute
 * seule plutôt que d'expédier un chiffre de six mois. Pour la rafraîchir : Bing
 * Webmaster Tools → AI Performance → 30 D, et mettre à jour les deux constantes. */
const CITATIONS_30J = 3000;
const CITATIONS_ANNUAIRE_30J = 77;   // celles qui pointaient vers l'annuaire, pas vers les pages de coûts
const CITATIONS_LU_LE = '2026-09-08';
const CITATIONS_PEREMPTION_JOURS = 45;

/* Les deux compteurs de PREUVE SOCIALE. Ils ne sont pas décoratifs : « 76 confrères ont
 * confirmé » et « huit l'ont déjà posé » sont les seules phrases de ces courriels qui
 * disent au lecteur que d'autres l'ont fait avant lui. Ils doivent donc être VRAIS.
 * Mesurés le 8 sept. 2026 : `ownerVerified` sur experts.json = 76 ; `badgeExchange` = 8,
 * et ces 8 ont été recoupés un par un en visitant leurs sites (le lien vers payotte.com
 * y est bien présent). Ils vieillissent plus lentement que les citations, mais ils
 * vieillissent : ils portent la même date et la même péremption. */
const EXPERTS_CONFIRMES = 76;
const BADGES_POSES = 8;

function fraisDeLecture() {
  const age = (Date.now() - Date.parse(CITATIONS_LU_LE)) / 86400000;
  return Number.isFinite(age) && age <= CITATIONS_PEREMPTION_JOURS;
}

function phraseCitations(fr) {
  if (!fraisDeLecture()) return '';
  const n = CITATIONS_30J.toLocaleString(fr ? 'fr-CA' : 'en-CA');
  return fr
    ? ` Le mois dernier, Copilot a cité payotte.com environ <b>${n} fois</b>.`
    : ` Last month, Copilot cited payotte.com roughly <b>${n} times</b>.`;
}

/* ── LE CONTENU PAR ÉTAPE ────────────────────────────────────────────────────
 * ⚠⚠ CE N'EST PAS UN RETOUR AUX CINQ GABARITS DE L'ÉTÉ (8 sept. 2026). Le 2
 * septembre, cinq variantes ont été fondues en une seule, et le motif inscrit ici
 * était juste : « elles disaient toutes la même chose sous cinq formes ». Il tenait.
 * Ce qui a changé n'est pas l'avis, c'est le FOND : ces trois-là ne demandent plus la
 * même chose. Confirmer sa fiche, coller un lien, ou ne rien demander du tout sont
 * trois gestes différents, adressés à trois populations que la donnée distingue
 * déjà (`ownerVerified`, `badgeExchange`). Cinq façons de dire « regardez votre
 * fiche » méritaient d'être fondues ; trois demandes distinctes, non.
 *
 * ET L'OBJECTION D'ORIGINE EST RESPECTÉE : il n'y a toujours qu'UN gabarit. Le rendu,
 * l'en-tête, les blocs marché et taux, le pied — tout reste commun et se relit une
 * fois. Seul le CONTENU varie, dans cette table. Changer le ton se fait ici, à un
 * endroit, pas dans cinq fonctions parallèles.
 *
 * Les étapes `intro` et `yellow` n'ont PAS de contenu propre : elles retombent sur le
 * générique. C'est voulu — leur demande (« regardez votre fiche », « il vous manque
 * telle donnée ») est bien la même, et c'est exactement le cas que la fusion visait. */
function contenuExpert({ stage, expert, city, fr, url, note, ask, proWho }) {
  const nEx = EXPERTS_CONFIRMES;
  const nBa = BADGES_POSES;
  const nAn = CITATIONS_ANNUAIRE_30J;
  const frais = fraisDeLecture();
  const cite = frais
    ? (fr ? `Le mois dernier, <b>Copilot a cité payotte.com environ ${CITATIONS_30J.toLocaleString('fr-CA')} fois</b>`
          : `Last month, <b>Copilot cited payotte.com roughly ${CITATIONS_30J.toLocaleString('en-CA')} times</b>`)
    : '';

  if (stage === 'reco') {
    /* ③ Fiche confirmée, badge jamais posé. La demande est un copier-coller, et c'est
       le geste le plus rentable du système : les liens externes sont la contrainte qui
       plafonne tout le site. Le bouton mène à SA page de badge, pas à l'accueil. */
    return {
      subject: fr ? 'Plusieurs fiches ont été citées le mois dernier'
                  : 'Several profiles were cited last month',
      h3: fr ? 'Une ligne à coller' : 'One line to paste',
      corps: (fr
        ? `Vous avez confirmé votre place sur Payotte. ${cite ? cite + ', et <b>plusieurs professionnels ont été cités par leur fiche</b>, nommément.' : 'Votre fiche est publique et vérifiable.'}<br><br>Mais rien sur votre site ne dit que cette fiche, c'est vous : pour Google comme pour Copilot, les deux pages n'ont aucun rapport. Le badge est un <b>lien</b>, pas un logo — et c'est ce lien que les moteurs suivent.<br><br>${nBa} confrères l'ont déjà posé.`
        : `You confirmed your place on Payotte. ${cite ? cite + ', and <b>several professionals were cited through their own profile</b>, by name.' : 'Your profile is public and verifiable.'}<br><br>But nothing on your website says that profile is you: to Google and to Copilot, the two pages have no relationship. The badge is a <b>link</b>, not a logo — and that link is what the engines follow.<br><br>${nBa} colleagues have already posted it.`),
      gratuit: fr ? 'Gratuit, et sans contrepartie.' : 'Free, with nothing asked in return.',
      bouton: fr ? 'Copier mon badge →' : 'Copy my badge →',
      href: expert?.slug ? `${SITE}/badge/${expert.slug}` : url,
    };
  }

  if (stage === 'green') {
    /* ② Fiche publiée, jamais confirmée. Aucune persuasion à faire : l'actif existe et
       porte son nom. On signale, on ne vend pas — d'où la gratuité dite en clair. */
    return {
      subject: fr ? `Votre fiche existe. ${nEx} confrères ont confirmé la leur.`
                  : `Your profile exists. ${nEx} colleagues have confirmed theirs.`,
      h3: fr ? "La vôtre n'a jamais été confirmée" : 'Yours has never been confirmed',
      corps: (fr
        ? `Payotte ne retient <b>qu'un professionnel par secteur et par métier</b>. Pour le vôtre, c'est vous — avec votre numéro de permis publié, pour que le lecteur puisse le vérifier au registre officiel.${cite ? '<br><br>' + cite + '.' : ''}<br><br>Confirmer, c'est un clic. Ça n'achète aucun classement — seulement un profil exact et daté. ${ask ? `Et si vous ajoutez <b>${ask}</b>, je mets à jour le jour même.` : 'Si une information est fausse, dites-le : on vérifie, on date, on publie.'}`
        : `Payotte lists <b>one professional per sector and per profession</b>. For yours, that is you — with your licence number published, so a reader can check it against the official registry.${cite ? '<br><br>' + cite + '.' : ''}<br><br>Confirming takes one click. It buys no ranking — only an accurate, dated profile. ${ask ? `And if you add <b>${ask}</b>, I update the same day.` : 'If something is wrong, say so: we verify, we date it, we publish.'}`),
      gratuit: fr ? "Gratuit. Il n'y a rien à vendre ici." : 'Free. There is nothing to sell here.',
      bouton: fr ? 'Voir ma fiche →' : 'See my profile →',
      href: url,
    };
  }

  if (stage === 'partner') {
    /* ④ Fiche confirmée ET badge posé. On ne demande RIEN — c'est le seul des trois
       dans ce cas, et c'est pour ça qu'il ne porte aucune mention de gratuité : il n'y
       a rien à acheter. Le pouls du marché, au-dessus, EST le courriel. */
    return {
      subject: fr ? `Pouls du marché — ${city.name}, et votre place`
                  : `Market pulse — ${city.name}, and your place`,
      h3: fr ? 'Votre place est confirmée' : 'Your place is confirmed',
      corps: (fr
        ? `${cite ? cite + `. Sur ces citations, <b>${nAn} pointaient vers l'annuaire</b> — et plusieurs professionnels ont été cités par leur fiche.<br><br>` : ''}Votre badge est en ligne : vous êtes ${nBa} à l'avoir posé. C'est ce lien qui dit aux moteurs que la fiche et vous, c'est la même personne.<br><br>Rien à faire de votre côté. Si une donnée doit changer, répondez à ce courriel — je mets à jour le jour même.`
        : `${cite ? cite + `. Of those, <b>${nAn} pointed at the directory</b> — and several professionals were cited through their own profile.<br><br>` : ''}Your badge is live: ${nBa} of you have posted it. That link is what tells the engines the profile and you are the same person.<br><br>Nothing to do on your side. If a figure needs changing, just reply — I update the same day.`),
      gratuit: null,
      bouton: fr ? 'Voir ma fiche →' : 'See my profile →',
      href: url,
    };
  }

  return null;   // intro · yellow → le générique
}

// La donnée manquante la plus payante d'un expert (coup de coude ①/⓪), tirée du feed.
function missingAsk(expert, fr) {
  if (!expert.licence?.number && expert.licence?.body)
    return fr ? `votre numéro de permis ${expert.licence.body}` : `your ${expert.licence.body} licence number`;
  if (!expert.experience) return fr ? `l'année où vous avez commencé à exercer` : `the year you began practising`;
  if (!expert.google) return fr ? `le lien de votre profil Google` : `your Google profile link`;
  return fr ? `une distinction vérifiable (prix du secteur, mention presse)` : `a verifiable distinction (award, press mention)`;
}

const S = (label, val) => `<td width="50%" style="padding:14px 0;border-bottom:1px solid #f1ecec;font-family:Arial,Helvetica,sans-serif;"><span style="font-size:13px;color:#8a8284;">${label}</span><br><span style="font-size:16px;color:#211c1e;font-weight:bold;">${val}</span></td>`;

// Cœur commun : logo + repère + grille + source. eyebrow = texte à droite du logo.
// ── DATE DE RÉFÉRENCE LISIBLE (2026-09-02, signalé par le proprio) ──────────────
// Le gabarit servait le code brut du feed : « 2026-T1 » dans un courriel de septembre.
// Illisible, et pire, ça a l'air d'une coquille. Deux formats coexistent selon la chambre :
// « 2026-06 » (mensuel) et « 2026-T1 » (trimestriel — 17 des 73 villes).
//
// ⚠️ ON N'EFFACE PAS L'ÂGE, ON L'EXPLIQUE. Les chambres publient avec du retard : 56 des
// 73 villes sont à trois ou quatre mois, c'est le rythme normal du marché immobilier, pas
// un défaut à cacher. Au-delà de six mois en revanche, le lecteur doit le savoir — sinon
// il croit lire le mois courant. Seuil à 7 pour ne pas crier sur le régime normal (mesuré
// le 2026-09-02 : trois villes au-dessus, dont Barrie à douze mois).
const MOIS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const MOIS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function moisLisible(rm, fr, at = new Date()) {
  if (!rm) return '';
  const s = String(rm);
  let libelle = s, fin = null;
  const t = s.match(/^(\d{4})-T(\d)$/);
  if (t) {
    const an = Number(t[1]), tri = Number(t[2]);
    libelle = fr ? `${tri}${tri === 1 ? 'er' : 'e'} trimestre ${an}` : `Q${tri} ${an}`;
    fin = new Date(Date.UTC(an, tri * 3 - 1, 28));
  } else {
    const m = s.match(/^(\d{4})-(\d{2})$/);
    if (m) {
      const an = Number(m[1]), mo = Number(m[2]);
      libelle = `${(fr ? MOIS_FR : MOIS_EN)[mo - 1]} ${an}`;
      fin = new Date(Date.UTC(an, mo - 1, 28));
    }
  }
  if (!fin) return libelle;
  const mois = Math.round((at - fin) / 86400000 / 30.4);
  if (mois < 7) return libelle;
  return libelle + (fr ? ' <span style="color:#b3261e;">(donnée la plus récente publiée)</span>'
                       : ' <span style="color:#b3261e;">(latest published figure)</span>');
}

function marketCore(city, fr, eyebrow) {
  const ref0 = refOf(city);
  const ref = ref0.valeur;
  const refYoy = ref0.yoy;
  const grn = (t) => `<span style="font-size:12px;color:#1f7a44;font-weight:normal;">${t}</span>`;
  const cells = [];
  if (city.averagePrice != null && ref0.genre !== 'average') cells.push([fr ? 'Prix moyen' : 'Average price', fmtMoney(city.averagePrice, fr) + (city.averageYoyPct != null ? ' ' + grn(fmtPct(city.averageYoyPct, fr)) : '')]);
  if (city.sales != null) cells.push([fr ? 'Ventes du mois' : 'Sales', city.sales.toLocaleString(fr ? 'fr-CA' : 'en-CA') + (city.salesYoyPct != null ? ' ' + grn(fmtPct(city.salesYoyPct, fr)) : '')]);
  if (city.monthsOfInventory != null) cells.push([fr ? "Mois d'inventaire" : 'Months of inventory', String(city.monthsOfInventory)]);
  if (city.avgDaysOnMarket != null) cells.push([fr ? 'Délai de vente' : 'Days on market', city.avgDaysOnMarket + (fr ? ' jours' : ' days')]);
  let gridRows = '';
  for (let i = 0; i < cells.length; i += 2) gridRows += `<tr>${S(cells[i][0], cells[i][1])}${cells[i + 1] ? S(cells[i + 1][0], cells[i + 1][1]) : '<td width="50%"></td>'}</tr>`;
  const refLine = ref != null
    ? `<div style="font-family:Georgia,'Times New Roman',serif;font-size:34px;color:#211c1e;line-height:1;">${fmtMoney(ref, fr)}</div>
       <div style="font-size:13px;color:#6f6769;margin:9px 0 22px 0;">${fr ? 'Prix de référence' : 'Reference price'} (${ref0.genre === 'benchmark' ? (fr ? 'repère MLS' : 'MLS benchmark') : ref0.genre === 'median' ? (fr ? 'médiane' : 'median') : (fr ? 'moyenne' : 'average')})${refYoy != null ? ` &middot; <span style="color:#1f7a44;font-weight:bold;">${fmtPct(refYoy, fr)} ${fr ? 'sur un an' : 'YoY'}</span>` : ''}</div>`
    : '';
  const src = Array.isArray(city.sources) && city.sources.length ? city.sources[0] : city.board;
  return `<tr><td style="padding:26px 32px 22px 32px;border-bottom:1px solid #f1ecec;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle"><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td><td align="right" valign="middle" style="font-size:11px;letter-spacing:.5px;color:#9a9294;line-height:1.5;">${eyebrow}</td></tr></table></td></tr>
    <tr><td style="padding:28px 32px 6px 32px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.3;color:#211c1e;margin-bottom:20px;">${fr ? 'Le pouls du marché' : 'The market pulse'} &mdash; ${city.name}</div>
      ${refLine}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #f1ecec;">${gridRows}</table>
      <div style="font-size:11.5px;color:#a49c9e;margin-top:14px;">${fr ? 'Source' : 'Source'} : ${src ?? 'chambre immobilière'}${city.referenceMonth ? ` &middot; ${moisLisible(city.referenceMonth, fr)}` : ''}</div>
    </td></tr>`;
}

// ---- Bloc NATIONAL : taux et obligations ---------------------------------------------
// Identique pour tous les destinataires, donc rapatrié UNE fois par exécution et non par
// courriel : deux sous-requêtes au total, pas deux par envoi.
//
// Pourquoi l'ajouter : le bulletin ne montrait que les 5 chiffres récoltés à la main auprès
// des chambres immobilières. Les taux et les obligations sont collectés automatiquement
// depuis la Banque du Canada et ne coûtaient rien à personne — ils dormaient. Ils comptent
// surtout pour les 39 villes qui n'ont AUCUNE autre source automatique : c'est le seul
// contenu qu'on puisse leur ajouter sans nouvelle récolte.
//
// Le 5 ans a sa place ici et nulle part ailleurs : c'est ce qui fait bouger le fixe 5 ans
// quelques jours plus tard. Un courtier hypothécaire le sait ; un courtier immobilier, rarement.
// ═══════════════════════════════════════════════════════════════════════════════════
// ÉTAGE PROVINCIAL (2026-09-02, demande proprio : « son secteur, sa province et le Canada »)
// ═══════════════════════════════════════════════════════════════════════════════════
// Le courriel passait de la RMR au pays entier : un professionnel de Trois-Rivières lisait
// son marché, puis le Canada, sans jamais voir le Québec. Cet étage comble le trou.
//
// DEUX CHOSES, ET LA SECONDE EST CELLE QUI PARLE :
//   1. les mises en chantier de sa province (SAAR, variation sur un an) ;
//   2. son marché COMPARÉ à sa province — c'est le seul chiffre qui lui dise s'il est
//      au-dessus ou en dessous de chez lui, et il ne coûte aucune source de plus.
//
// AUCUNE MOYENNE FABRIQUÉE. Les provinces sont des observations publiées par la SCHL
// (cube StatCan 34-10-0156, même cube que les RMR) — pas une agrégation maison des villes
// couvertes. La somme des dix provinces égale exactement le Canada : vérifié le 2026-09-02
// (217 800 SAAR). Si la province manque au feed, le bloc ne s'affiche pas.
const PROV_NOMS = {
  'quebec': ['Québec', 'Quebec'], 'ontario': ['Ontario', 'Ontario'],
  'british-columbia': ['Colombie-Britannique', 'British Columbia'], 'alberta': ['Alberta', 'Alberta'],
  'manitoba': ['Manitoba', 'Manitoba'], 'saskatchewan': ['Saskatchewan', 'Saskatchewan'],
  'nova-scotia': ['Nouvelle-Écosse', 'Nova Scotia'], 'new-brunswick': ['Nouveau-Brunswick', 'New Brunswick'],
  'prince-edward-island': ['Île-du-Prince-Édouard', 'Prince Edward Island'],
  'newfoundland-and-labrador': ['Terre-Neuve-et-Labrador', 'Newfoundland and Labrador'],
};

function provinceBlock(macro, city, fr) {
  const regions = macro?.chantiers;
  if (!Array.isArray(regions) || !city?.province) return '';
  // ⚠️ DEUX VOCABULAIRES. `/api/market.json` donne un CODE à deux lettres (« QC ») et
  // `/api/housing-starts.json` un SLUG (« quebec ») : comparer les deux directement ne
  // rapproche jamais rien, et le bloc disparaissait en silence — vu au premier essai de
  // rendu le 2026-09-02. On traduit par PROV_CODE_TO_SLUG, la table qui existe déjà.
  const provSlug = PROV_CODE_TO_SLUG[city.province] ?? city.province;
  const prov = regions.find((r) => r.isProvince && r.province === provSlug);
  if (!prov || prov.startsSaar == null) return '';
  const nom = (PROV_NOMS[provSlug] ?? [prov.name, prov.name])[fr ? 0 : 1];
  const nb = (v) => Number(v).toLocaleString(fr ? 'fr-CA' : 'en-CA');
  const fleche = (v) => (v == null ? '' : v > 0 ? '▲' : v < 0 ? '▼' : '=');
  const teinte = (v) => (v == null ? '#6f6769' : v > 0 ? '#1f7a44' : v < 0 ? '#b3261e' : '#6f6769');
  // ⚠️ Le séparateur décimal suit la langue. Sans `toLocaleString`, un courriel français
  // affichait « +14.9 % » à des professionnels québécois — le point anglais au milieu
  // d'un texte en français. Les grands nombres étaient déjà localisés (62 324), les
  // pourcentages ne l'étaient pas (vu au test de rendu du 2026-09-02).
  const signe = (v) => `${v > 0 ? '+' : ''}${Number(v).toLocaleString(fr ? 'fr-CA' : 'en-CA', { maximumFractionDigits: 1 })} %`;

  // Le positionnement : sa RMR contre sa province, sur la MÊME série et le MÊME mois.
  // Les deux variations viennent du même feed, donc la comparaison est légitime — ce
  // n'est pas un indice composite, c'est deux observations mises côte à côte.
  const rmr = regions.find((r) => r.citySlug === city.slug);
  let compare = '';
  if (rmr && rmr.changeYoyPct != null && prov.changeYoyPct != null) {
    // ⚠️ DEUX TAUX, PAS UN ÉCART EN POURCENT. La première version disait « votre marché
    // fait +108,9 % par rapport au Québec » — un lecteur comprend « mon marché est deux
    // fois plus gros », alors qu'il s'agit de l'écart entre deux taux de croissance, en
    // POINTS. On affiche donc les deux observations côte à côte et on laisse le lecteur
    // faire la comparaison : c'est plus honnête, et c'est plus lisible.
    const mieux = rmr.changeYoyPct > prov.changeYoyPct;
    const couleur = mieux ? '#1f7a44' : '#b3261e';
    const verdict = Math.abs(rmr.changeYoyPct - prov.changeYoyPct) < 1
      ? (fr ? 'au même rythme que la province' : 'in line with the province')
      : mieux ? (fr ? 'plus vite que la province' : 'faster than the province')
              : (fr ? 'moins vite que la province' : 'slower than the province');
    // Petite RMR = série qui saute d'un mois à l'autre. Annoncer « +123 % » sans le dire
    // serait trompeur ; le feed porte déjà le drapeau, on le relaie.
    const prudence = rmr.volatile
      ? (fr ? ` <span style="color:#8a8284;">Petit marché : cette série varie fortement d’un mois à l’autre, à lire sur la tendance plutôt que sur le mois.</span>`
            : ` <span style="color:#8a8284;">Small market: this series swings month to month — read the trend, not the month.</span>`)
      : '';
    compare = `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #f1ecec;font-size:13px;line-height:1.6;color:#443e40;">`
      + (fr ? `<b>${rmr.name}</b> : ${signe(rmr.changeYoyPct)} sur un an, contre ${signe(prov.changeYoyPct)} pour l’ensemble du ${nom} — <b style="color:${couleur}">${verdict}</b>.`
            : `<b>${rmr.name}</b>: ${signe(rmr.changeYoyPct)} year over year, against ${signe(prov.changeYoyPct)} for ${nom} as a whole — <b style="color:${couleur}">${verdict}</b>.`)
      + prudence + `</div>`;
  }

  return `<tr><td style="padding:4px 32px 0 32px;">
    <div style="border:1px solid #eae5e5;border-radius:6px;padding:16px 18px;background:#fbfaf9;">
      <div style="font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#4b5f66;margin-bottom:10px;">${fr ? 'Votre province' : 'Your province'} &middot; ${nom}</div>
      <span style="font-size:13px;color:#8a8284;">${fr ? 'Mises en chantier' : 'Housing starts'}</span><br>
      <span style="font-size:17px;color:#211c1e;font-weight:bold;">${nb(prov.startsSaar)}</span>
      <span style="font-size:11px;color:#a49c9e;"> &middot; ${prov.referenceMonth}</span>
      ${prov.changeYoyPct != null ? `<span style="font-size:12px;color:${teinte(prov.changeYoyPct)};"> &middot; ${fleche(prov.changeYoyPct)} ${signe(prov.changeYoyPct)} ${fr ? 'sur un an' : 'year over year'}</span>` : ''}
      <div style="font-size:12px;line-height:1.55;color:#6f6769;margin-top:7px;">${fr
        ? 'Rythme annualisé désaisonnalisé (SCHL). C’est l’offre qui arrivera sur le marché dans 6 à 18 mois.'
        : 'Seasonally adjusted annual rate (CMHC). This is the supply reaching the market in 6-18 months.'}</div>
      ${compare}
    </div>
  </td></tr>`;
}

function nationalBlock(macro, fr) {
  if (!macro) return '';
  const r = macro.rates || {};
  const b = macro.bonds || {};
  const pct = (v) => (v == null ? null : `${v.toLocaleString(fr ? 'fr-CA' : 'en-CA')} %`);
  // CHAQUE chiffre porte sa date d'observation, parce qu'elles diffèrent de plusieurs mois :
  // le taux directeur est quotidien, mais les moyennes hypothécaires de la Banque du Canada
  // sont MENSUELLES et publiées avec du retard — au 6 août 2026, elles dataient du 1er mai.
  // Afficher « fixe 5 ans : 4,34 % » sans cette date, à des courtiers hypothécaires qui
  // connaissent le marché du jour, décrédibiliserait tout le reste du courriel.
  const daté = (v) => (v?.observed ? `<span style="font-size:11px;color:#a49c9e;font-weight:normal;"> &middot; ${v.observed}</span>` : '');
  const cells = [];
  if (r.policyRate?.percent != null) cells.push([fr ? 'Taux directeur' : 'Policy rate', pct(r.policyRate.percent) + daté(r.policyRate)]);
  if (r.primeRate?.percent != null) cells.push([fr ? 'Taux préférentiel' : 'Prime rate', pct(r.primeRate.percent) + daté(r.primeRate)]);
  if (r.mortgage5yrFixed?.percent != null) cells.push([fr ? 'Fixe 5 ans (moyenne)' : '5-yr fixed (average)', pct(r.mortgage5yrFixed.percent) + daté(r.mortgage5yrFixed)]);
  if (r.mortgageVariable?.percent != null) cells.push([fr ? 'Variable (moyenne)' : 'Variable (average)', pct(r.mortgageVariable.percent) + daté(r.mortgageVariable)]);
  const g5 = b.gov5yr;
  if (!cells.length && g5?.percent == null) return '';

  let gridRows = '';
  for (let i = 0; i < cells.length; i += 2) gridRows += `<tr>${S(cells[i][0], cells[i][1])}${cells[i + 1] ? S(cells[i + 1][0], cells[i + 1][1]) : '<td width="50%"></td>'}</tr>`;

  // L'obligation 5 ans, avec sa variation sur un mois : le signal avancé du taux fixe.
  // ── OBLIGATION 5 ANS RETIRÉE (2026-09-02, demande proprio : « inintéressant ») ──
  // Le bloc expliquait que l'obligation du Canada mène le taux fixe. C'est exact, et c'est
  // une information de salle des marchés : le courtier hypothécaire le sait déjà, les huit
  // autres métiers n'en font rien. Cinq lignes de courriel pour un chiffre que personne
  // n'utilise coûtaient plus qu'elles ne rapportaient.
  // La donnée n'est pas perdue : /api/bonds.json (le flux lu par les IA) et l'alerte de
  // taux la servent toujours. C'est son AFFICHAGE dans le pouls mensuel qui disparaît.
  const bondLine = '';

  return `<tr><td style="padding:22px 32px 6px 32px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.3;color:#211c1e;margin-bottom:16px;">${fr ? 'Les taux, partout au pays' : 'Rates, nationwide'}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #f1ecec;">${gridRows}</table>
      ${bondLine}
      <div style="font-size:11.5px;line-height:1.55;color:#a49c9e;margin-top:14px;">${fr
        ? 'Source : Banque du Canada. Chaque chiffre porte sa date d’observation — les moyennes hypothécaires sont une série mensuelle, publiée avec du retard. Ce sont des moyennes du système financier, pas une offre de prêteur.'
        : 'Source: Bank of Canada. Each figure carries its own observation date — the mortgage averages are a monthly series, published with a lag. These are financial-system averages, not a lender offer.'}</div>
    </td></tr>`;
}

const CLOSE = (bg, border, inner) => `<tr><td style="padding:20px 32px 4px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border:1px solid ${border};border-radius:12px;"><tr><td style="padding:22px 24px;">${inner}</td></tr></table></td></tr>`;
const BTN = (href, txt) => `<a href="${href}" style="display:inline-block;background:#c8102e;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;padding:11px 20px;border-radius:9px;">${txt}</a>`;
const H3 = (t) => `<div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.25;color:#211c1e;margin-bottom:10px;">${t}</div>`;
const P = (t) => `<div style="font-size:14px;line-height:1.6;color:#443e40;margin-bottom:14px;">${t}</div>`;
// ── ADRESSE POSTALE DE L'EXPÉDITEUR (2026-08-19) ──────────────────────────────────
// La LCAP l'EXIGE dans tout message commercial électronique : le Règlement (art. 2(2))
// impose « l'adresse postale » de l'expéditeur, en plus de son nom et d'un moyen de le
// joindre. Le pied ne portait que le nom et payotte.com — il manquait la pièce la plus
// simple, et c'est celle qu'un plaignant cite en premier parce qu'elle se vérifie d'un
// coup d'œil.
//
// ⚠️ ELLE N'EST PAS ÉCRITE ICI, ET C'EST VOULU. Aucune adresse de Payotte n'existe dans
// le dépôt ; en inventer une serait une fausse mention légale — bien pire que l'absence.
// Elle se pose en variable (`ADRESSE_POSTALE` dans wrangler.toml) par le propriétaire.
// Tant qu'elle manque, le pied s'affiche sans elle et `runBulletin` le crie dans le
// journal à chaque passage : mieux vaut un manque visible qu'un manque oublié.
const adressePostale = (env) => (env?.ADRESSE_POSTALE || '').trim();

// ── VOIE DE CONTACT DANS LE PIED (2026-08-25, passage en no-reply) ────────────────
// Le pied ne portait que « payotte.com » en texte brut — pas un lien, pas une voie de
// contact. Ça pouvait passer tant que le `reply_to` recevait. Depuis le no-reply, plus
// aucune adresse @payotte.com n'accepte de courrier, donc le FORMULAIRE est le seul
// moyen de joindre Payotte — et la LCAP (Règlement, art. 2(2)) exige un moyen de contact
// valide 60 jours, qu'une adresse web satisfait. Ces deux ajouts ne sont donc pas de la
// mise en page : ils portent la conformité.
//   1. un lien explicite vers /contact ;
//   2. une phrase qui DIT que l'adresse ne reçoit pas — sans elle, le professionnel
//      appuie sur « Répondre », ne reçoit rien, et conclut que Payotte l'ignore.
// ⚠️ `postale` reste vide tant qu'ADRESSE_POSTALE n'est pas posée : c'est l'AUTRE moitié
// de l'obligation, et le no-reply ne la remplace pas.
const FOOT = (why, unsubUrl, unsubTxt, postale = '', fr = true) => `<tr><td style="padding:22px 32px 26px 32px;"><div style="border-top:1px solid #f1ecec;padding-top:16px;font-size:11.5px;line-height:1.6;color:#a49c9e;">${why} <a href="${unsubUrl}" style="color:#8a8284;">${unsubTxt}</a> &middot; <a href="${SITE}/contact" style="color:#8a8284;">${fr ? 'Nous joindre' : 'Contact us'}</a> &middot; payotte.com${postale ? `<br>${postale}` : ''}</div></td></tr>`;
/* ⚠ LA LIGNE « Cette adresse ne reçoit pas les réponses » A ÉTÉ RETIRÉE LE 8 SEPT. 2026,
   parce qu'elle est devenue FAUSSE ce jour-là. `payotte.com` n'avait aucun MX : toute
   réponse partait dans le vide, et le pied disait vrai. Depuis, deux MX ImprovMX sont
   posés chez GoDaddy et `contact@`, `outreach@`, `bulletin@`, `relais@` (plus un
   attrape-tout) redirigent vers la boîte du propriétaire. Chaîne vérifiée le jour même :
   reçu de Google à 11 h 34 min 06, remis à Gmail 4 secondes plus tard, `2.0.0 OK … gsmtp`.
   NE PAS LA REMETTRE sans avoir d'abord vérifié `dig MX payotte.com`. */

// Page de la VILLE, pas l'accueil du pays. Le bouton du bulletin pointait sur /canada :
// on servait à quelqu'un le marché de Charlottetown pour le renvoyer choisir sa province
// à la main (signalé par le proprio le 2026-08-10). Les pages de ville sont publiées dans
// la langue de leur marché — une seule URL par ville, quelle que soit la langue du courriel.
/* ⚠ LA MÊME RÈGLE QUE `/api/villes-couvertes.json`, ET ELLE Y EST PUBLIÉE POUR ÇA.
   Les villes de la récolte sont écrites à la main (« montréal », « québec ») ; le
   catalogue est en slugs (« montreal », « quebec-city »). Comparer les formes brutes
   faisait passer Montréal et Québec pour non couvertes — 9 357 contacts mal classés
   au comptage du 8 septembre. Si l'une des deux règles change, l'autre doit suivre. */
const normVille = (s) => (s ?? '').toLowerCase().normalize('NFD')
  .replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const cityUrl = (city) => `${SITE}/canada/${PROV_SLUG[city?.province] ?? ''}/${city?.slug ?? ''}`;

// Zone experts : une page par métier (« visible à l'ère de l'IA »), publiée dans les deux
// langues sous des slugs différents. Sert la ligne « présence IA » du bulletin prospect.
const ZONE_EXPERTS = {
  'real-estate-broker': { fr: 'courtier-immobilier', en: 'real-estate-broker',
    lFr: 'courtiers immobiliers', lEn: 'real estate brokers' },
  'mortgage-broker': { fr: 'courtier-hypothecaire', en: 'mortgage-broker',
    lFr: 'courtiers hypothécaires', lEn: 'mortgage brokers' },
  appraiser: { fr: 'evaluateur', en: 'appraiser',
    lFr: 'évaluateurs agréés', lEn: 'certified appraisers' },
  'home-inspector': { fr: 'inspecteur-batiment', en: 'home-inspector',
    lFr: 'inspecteurs en bâtiment', lEn: 'home inspectors' },
  'notary-lawyer': { fr: 'notaire-avocat', en: 'notary-lawyer',
    lFr: 'notaires et avocats en immobilier', lEn: 'real estate lawyers and notaries' },
};

// Ligne « présence IA », adaptée au métier du destinataire quand on le connaît (les
// contacts récoltés portent leur `metier`; les abonnés du formulaire, non). Un lien
// discret sous le bouton — un seul appel à l'action dans le courriel, pas deux.
function ligneIA(metier, fr) {
  const z = ZONE_EXPERTS[metier];
  const href = z ? `${SITE}${fr ? '' : '/en'}/zone-experts/${fr ? z.fr : z.en}`
    : `${SITE}${fr ? '/ia-en-immobilier' : '/en/ai-in-real-estate'}`;
  const qui = z ? (fr ? z.lFr : z.lEn) : (fr ? 'experts immobiliers' : 'real-estate experts');
  return `<div style="font-size:12.5px;line-height:1.6;color:#6f6769;margin-top:14px;">${fr
    ? `Payotte travaille aussi la présence des <b>${qui}</b> dans les réponses des IA (ChatGPT, Copilot, Perplexity), pas seulement dans Google.`
    : `Payotte also works on how <b>${qui}</b> show up in AI answers (ChatGPT, Copilot, Perplexity), not just in Google.`}
    <a href="${href}" style="color:#c8102e;text-decoration:none;font-weight:bold;">${fr ? 'Voir comment &rarr;' : 'See how &rarr;'}</a></div>`;
}

// Rendu complet d'un courriel : {subject, html}. segment='prospect'|'expert' ; stage pour les experts.
/* ═══ GABARIT « TEST IA » (5 oct. 2026, envoi du 10 oct.) ═══════════════════════════════════
 * Maquette approuvée : https://claude.ai/artifact/17Dw1HUXeXFD6NDDgwVRBs (v17).
 * Même ordre pour tous : en-tête « Plateforme IA pour l'immobilier » + pouls de la ville, l'offre
 * « Testez gratuitement votre présence dans les IA » et son bouton vers le test (page #ia), la
 * courbe des citations Copilot, le pied légal. Objet : « Testez votre présence IA à {ville} :
 * gratuit, 30 s » puis, le 5 oct. au soir, retour à la question : « {ville} : qui l'IA recommande-t-elle comme
 * {métier} ? » (prospects) et « {prénom}, l'IA recommande-t-elle votre nom à vos clients ? » (experts). Pas de bloc provincial ni national : Grégory veut des courriels LÉGERS.
 * Une ligne de plus selon le public : place libre (ville sans personne), experts listés (forfaits),
 * recommandés sans badge (badge). Pour revenir à l'ancien pouls : GABARIT_IA = false.
 * ⚠️ CITATIONS_MOIS : chiffres Bing Webmaster Tools, à relever chaque mois (chroniques.ts). */
const GABARIT_IA = true;
const PAGE_VI = { fr: `${SITE}/visibilite-ia-professionnels-immobilier`, en: `${SITE}/en/ai-visibility-real-estate-professionals` };
// Provenance des clics du courriel (5 oct. 2026) : compteurs `vip:src:*` du worker, lus par /vi/stats.
const SRC_COURRIEL = 'courriel-oct';
const CITATIONS_MOIS = [['juin', 'Jun', 15], ['juil.', 'Jul', 84], ['août', 'Aug', 2451], ['sept.', 'Sep', 5358]];

function blocCitationsIA(fr) {
  const max = Math.max(...CITATIONS_MOIS.map((m) => m[2]));
  const barres = CITATIONS_MOIS.map(([mf, me, v], i) => {
    const h = Math.max(2, Math.round((v / max) * 40));
    return `<td valign="bottom" align="center" style="padding:0 3px;"><div style="width:18px;height:${h}px;background:${i === CITATIONS_MOIS.length - 1 ? '#c8102e' : '#eab4bd'};border-radius:2px 2px 0 0;font-size:0;line-height:0;">&nbsp;</div><div style="font-size:9px;color:#8a8284;padding-top:2px;">${fr ? mf : me}</div></td>`;
  }).join('');
  const der = CITATIONS_MOIS[CITATIONS_MOIS.length - 1][2];
  const mois = fr ? { 'sept.': 'septembre' }[CITATIONS_MOIS[CITATIONS_MOIS.length - 1][0]] || CITATIONS_MOIS[CITATIONS_MOIS.length - 1][0] : 'September';
  const texte = fr
    ? `<b>${der.toLocaleString('fr-CA')} citations par Copilot</b> en ${mois}. Quand vos clients leur posent une question, ChatGPT, Copilot, Perplexity, Claude et Gemini ne citent qu’un ou deux noms.`
    : `<b>${der.toLocaleString('en-CA')} Copilot citations</b> in ${mois}. When your clients ask them a question, ChatGPT, Copilot, Perplexity, Claude and Gemini cite only one or two names.`;
  return `<tr><td style="padding:18px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="bottom"><div style="font-size:15px;font-weight:bold;color:#211c1e;margin-bottom:3px;">${fr ? 'Les IA citent Payotte de plus en plus' : 'AI tools cite Payotte more and more'}</div><div style="font-size:13.5px;line-height:1.5;color:#443e40;">${texte}</div></td><td width="110" valign="bottom" style="padding-left:10px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right"><tr>${barres}</tr></table></td></tr></table></td></tr>`;
}

function offreTestIA({ segment, stage, city, expert, fr, villeCouverte }) {
  const coches = (fr
    ? ['Voyez qui l’IA recommande à vos clients dans votre secteur.', 'Et si c’est vous.', 'Gratuit, sans inscription&nbsp;: 30 secondes.']
    : ['See who the AI recommends to your clients in your sector.', 'And whether it is you.', 'Free, no sign-up: 30 seconds.'])
    .map((c) => `<tr><td valign="top" style="padding:3px 8px 3px 0;color:#1a7f4b;font-weight:bold;font-size:14px;">&#10003;</td><td style="padding:3px 0;font-size:14px;line-height:1.45;color:#211c1e;">${c}</td></tr>`).join('');
  const lien = (href, t) => `<a href="${href}" style="color:#c8102e;text-decoration:underline;">${t}</a>`;
  let apres = '';
  if (segment === 'prospect' && villeCouverte === false) {
    apres = fr ? `Bonne nouvelle&nbsp;: la place de votre métier est libre à ${city.name} sur Payotte.` : `Good news: your profession’s spot is open in ${city.name} on Payotte.`;
  } else if (segment !== 'prospect' && stage === 'reco' && expert?.slug) {
    apres = fr ? `Vous êtes l’expert recommandé de votre secteur&nbsp;: ${lien(`${SITE}/badge/${expert.slug}`, 'posez votre badge')} pour que les IA relient votre site à votre fiche.`
               : `You are the recommended expert in your sector: ${lien(`${SITE}/badge/${expert.slug}`, 'put up your badge')} so AI tools connect your website to your profile.`;
  } else if (segment !== 'prospect') {
    apres = fr ? `Votre fiche est déjà sur Payotte. Pour vous faire citer davantage&nbsp;: ${lien(`${PAGE_VI.fr}?src=${SRC_COURRIEL}#forfaits`, 'voir les forfaits')}.`
               : `Your profile is already on Payotte. To get cited more: ${lien(`${PAGE_VI.en}?src=${SRC_COURRIEL}#forfaits`, 'see the plans')}.`;
  }
  const inner = `<div style="font-size:15px;font-weight:bold;color:#211c1e;margin-bottom:6px;">${fr ? 'Testez gratuitement votre présence dans les IA' : 'Test your AI presence for free'}</div>`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${coches}</table>`
    + (apres ? `<div style="margin-top:8px;font-size:13px;line-height:1.5;color:#443e40;">${apres}</div>` : '')
    + `<div style="height:12px;font-size:0;line-height:0;">&nbsp;</div>${BTN(`${PAGE_VI[fr ? 'fr' : 'en']}?src=${SRC_COURRIEL}#ia`, fr ? 'Faire le test IA gratuit &rarr;' : 'Take the free AI test &rarr;')}`;
  return `<tr><td style="padding:16px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fbf3f4;border:1px solid #f1d5da;border-radius:10px;"><tr><td style="padding:14px 16px;">${inner}</td></tr></table></td></tr>`;
}

const METIER_UN = { 'real-estate-broker': ['courtier immobilier', 'real estate broker'], 'mortgage-broker': ['courtier hypothécaire', 'mortgage broker'],
  appraiser: ['évaluateur agréé', 'appraiser'], 'home-inspector': ['inspecteur en bâtiment', 'home inspector'], 'notary-lawyer': ['notaire', 'real estate lawyer'] };
// Objet des prospects, partagé par la ville, la banlieue et le provincial (5 oct. 2026).
function sujetTestIA(lieu, metier, fr) {
  const m = METIER_UN[metier]?.[fr ? 0 : 1];
  return fr ? (m ? `${lieu} : qui l’IA recommande-t-elle comme ${m} ?` : `${lieu} : qui l’IA recommande-t-elle à vos clients ?`)
            : (m ? `${lieu}: who does AI recommend as a ${m}?` : `${lieu}: who does AI recommend to your clients?`);
}
// En-tête « Plateforme IA » des variantes banlieue et provinciale, qui n'ont pas de marketCore.
const teteTestIA = (lieu, fr) => `<tr><td style="padding:26px 32px 22px 32px;border-bottom:1px solid #f1ecec;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle"><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td><td align="right" valign="middle" style="font-size:11px;letter-spacing:.5px;color:#9a9294;line-height:1.5;">${fr ? 'Plateforme IA pour l’immobilier' : 'AI platform for real estate'}<br><span style="color:#c8102e;letter-spacing:1px;">${lieu}</span></td></tr></table></td></tr>`;
// La municipalité n'a pas de page : aucune promesse de place libre, seulement l'offre et la preuve.
const finTestIA = (lieu, fr) => offreTestIA({ segment: 'prospect', stage: null, city: { name: lieu }, expert: null, fr, villeCouverte: null }) + blocCitationsIA(fr);

function renderTestIA({ segment, stage, city, expert, lang, unsubUrl, postale = '', villeCouverte = null, metier = '' }) {
  const fr = lang !== 'en';
  city = { ...city, name: nomVilleBulletin(city, fr) };   // « Montréal », pas « Montreal », en français
  const eyebrow = `${fr ? 'Plateforme IA pour l’immobilier' : 'AI platform for real estate'}<br><span style="color:#c8102e;letter-spacing:1px;">${city.name}${city.referenceMonth ? ' &middot; ' + moisLisible(city.referenceMonth, fr) : ''}</span>`;
  // Objet (Grégory, 5 oct. : « remets l'ancien, il va mieux convertir ») : la question, pas l'offre.
  let subject;
  if (segment === 'prospect') {
    subject = sujetTestIA(city.name, metier, fr);
  } else {
    // Le prénom seulement s'il ressemble à un prénom (une fiche d'équipe ou de cabinet n'en a pas).
    const nom = String(expert?.name || '').trim();
    const prenom = expert?.isTeam || !/^[A-ZÀ-Ý][a-zà-ÿ'’-]+ [A-ZÀ-Ý]/.test(nom) ? '' : nom.split(' ')[0];
    subject = fr ? `${prenom ? `${prenom}, l’IA` : 'L’IA'} recommande-t-elle votre nom à vos clients ?`
                 : `${prenom ? `${prenom}, does AI` : 'Does AI'} recommend your name to your clients?`;
  }
  const metierPhrase = (expert?.professionLabel ?? '').replace(/^./, (c) => c.toLowerCase());
  const why = segment === 'prospect'
    ? (fr ? `Vous recevez ce courriel parce que vous exercez à ${city.name}.` : `You are receiving this email because you practise in ${city.name}.`)
    : (fr ? `Vous recevez ce courriel parce que vous êtes l'expert vérifié en ${metierPhrase} pour ${city.name} sur Payotte.` : `You're receiving this because you are the verified ${metierPhrase} for ${city.name} on Payotte.`);
  const foot = FOOT(why, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe', postale, fr);
  const html = `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${marketCore(city, fr, eyebrow)}${offreTestIA({ segment, stage, city, expert, fr, villeCouverte })}${blocCitationsIA(fr)}${foot}</table></div>`;
  return { subject, html };
}

function renderPulse({ segment, stage, city, expert, lang, unsubUrl, macro = null, metier = '', postale = '', villeCouverte = null }) {
  const fr = lang !== 'en';
  if (GABARIT_IA) return renderTestIA({ segment, stage, city, expert, lang, unsubUrl, postale, villeCouverte, metier });
  const url = expert?.url || `${SITE}`;
  const eyebrow = `${fr ? 'Le pouls du marché' : 'Market pulse'}<br><span style="color:#c8102e;letter-spacing:1px;">${city.name}${city.referenceMonth ? ' &middot; ' + moisLisible(city.referenceMonth, fr) : ''}</span>`;
  let subject, close, foot;
  if (segment === 'prospect') {
    /* ── DEUX CONTENUS, SELON QUE LA VILLE EST SERVIE OU NON (8 sept. 2026) ────
       La rareté n'est pas la même des deux côtés, et la dire à l'envers ruine le
       courriel : promettre une place libre là où quelqu'un est publié se vérifie en
       un clic. `villeCouverte` vaut null quand le flux de couverture n'a pas pu être
       lu — on retombe alors sur le texte neutre, qui reste vrai partout. */
    const gratuitProspect = fr
      ? `<div style="margin-top:13px;font-size:12.5px;color:#C8102E;font-weight:bold;">Gratuit. Aucune place ne s'achète, ici.</div>`
      : `<div style="margin-top:13px;font-size:12.5px;color:#C8102E;font-weight:bold;">Free. No seat is for sale here.</div>`;
    const citeP = fraisDeLecture()
      ? (fr ? `Le mois dernier, <b>Copilot a cité payotte.com environ ${CITATIONS_30J.toLocaleString('fr-CA')} fois</b>, dont ${CITATIONS_ANNUAIRE_30J} vers l'annuaire.`
            : `Last month, <b>Copilot cited payotte.com roughly ${CITATIONS_30J.toLocaleString('en-CA')} times</b>, ${CITATIONS_ANNUAIRE_30J} of them into the directory.`)
      : '';

    if (villeCouverte === true) {
      subject = fr ? `À ${city.name}, la place de votre métier est déjà prise`
                   : `In ${city.name}, your profession's seat is already taken`;
      close = CLOSE('#fdf6f7', '#f3d9dd',
        `${H3(fr ? `Ces pages ne nomment qu'une personne` : `These pages name one person`)}` +
        `${P(fr ? `Payotte ne retient <b>qu'un professionnel par secteur et par métier</b>, et ${city.name} est déjà servie. ${citeP}<br><br>Ces pages d'annuaire ne nomment qu'un nom par secteur. Si vous pensez que ce devrait être le vôtre, la grille est publique : permis vérifié au registre, années d'exercice, transactions déclarées, données manquantes affichées comme telles.`
               : `Payotte lists <b>one professional per sector and per profession</b>, and ${city.name} is already served. ${citeP}<br><br>Those directory pages name one name per sector. If you believe it should be yours, the grid is public: licence verified against the registry, years in practice, declared transactions, and missing data shown as missing.`)}` +
        `${gratuitProspect}${BTN(cityUrl(city), fr ? `Voir qui occupe mon secteur →` : `See who holds my sector →`)}${ligneIA(metier, fr)}`);
    } else if (villeCouverte === false) {
      subject = fr ? `${city.name} n'a encore personne sur Payotte`
                   : `${city.name} has no one on Payotte yet`;
      close = CLOSE('#eef3f0', '#cfe4d7',
        `${H3(fr ? `Ouvrir une ville ne se fait qu'une fois` : `A city opens once`)}` +
        `${P(fr ? `Payotte ne retient <b>qu'un professionnel par secteur et par métier</b>. Pour ${city.name}, personne n'est encore publié. ${citeP}<br><br>Le premier d'une ville neuve est celui que la page nommera. Permis, années d'exercice, secteur réellement desservi : on vérifie, on date, on publie.`
               : `Payotte lists <b>one professional per sector and per profession</b>. For ${city.name}, nobody is published yet. ${citeP}<br><br>The first in a new city is the one the page will name. Licence, years in practice, the sector you actually serve: we verify, we date it, we publish.`)}` +
        `${gratuitProspect}${BTN(`${SITE}${fr ? '/contact' : '/en/contact'}`, fr ? `Proposer mon nom →` : `Put my name forward →`)}${ligneIA(metier, fr)}`);
    } else {
      subject = fr ? `${city.name} : le pouls du marché` : `${city.name}: your market pulse`;
      close = CLOSE('#eef3f0', '#cfe4d7', `${H3(fr ? `Les experts vérifiés de ${city.name}` : `${city.name}'s verified experts`)}${P(fr ? `Payotte a vérifié <b>un seul</b> expert de référence par secteur et par métier — sans commission, sans publicité.` : `Payotte verified <b>one</b> reference expert per sector and trade — no commission, no ads.`)}${BTN(cityUrl(city), fr ? `Voir les experts de ${city.name} →` : `See ${city.name}'s experts →`)}${ligneIA(metier, fr)}`);
    }
    foot = FOOT(fr ? `Vous recevez le pouls de ${city.name}, une fois par mois.` : `You get the ${city.name} pulse once a month.`, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe', postale, fr);
  } else {
    // ── UN SEUL CTA POUR TOUS LES EXPERTS (2026-09-02, demande proprio) ───────────
    // Cinq variantes vivaient ici (intro · yellow · green · reco · partner), chacune avec
    // son sujet, son encadré et son bouton. Elles disaient toutes la même chose sous cinq
    // formes : « votre fiche existe, regardez-la ». Cinq gabarits, c'est cinq choses à
    // relire à chaque changement de ton — et le stade de la fiche n'a jamais été ce qui
    // décide qu'on clique.
    //
    // Reste UN CTA. Ce qui change d'un expert à l'autre n'est pas sa forme, c'est la
    // PHRASE DE VALEUR : la donnée manquante la plus payante quand il y en a une
    // (`missingAsk`), la confirmation quand la fiche est déjà complète. Une seule ligne
    // conditionnelle, pas un second gabarit.
    //
    // `stage` reste en paramètre : il sert au SUIVI (expertStage, marques KV, statistiques
    // par flux), plus au rendu. Ne pas le retirer de la signature.
    const ask = expert ? missingAsk(expert, fr) : '';
    // `professionLabel` arrive capitalisé (« Courtier immobilier ») parce qu'il sert de
    // titre ailleurs. Au milieu d'une phrase, la majuscule saute aux yeux : « l'expert
    // vérifié en Courtier immobilier ». On la retire ICI seulement — l'étiquette d'origine
    // reste intacte pour les usages où elle commence une ligne.
    const metierPhrase = (expert?.professionLabel ?? '').replace(/^./, (c) => c.toLowerCase());
    const proWho = fr ? `l'expert vérifié en ${metierPhrase} pour ${city.name}` : `the verified ${metierPhrase} for ${city.name}`;
    const note = expert?.score?.total ?? null;
    subject = fr ? `Votre marché à ${city.name}, et votre fiche Payotte` : `Your ${city.name} market, and your Payotte profile`;

    /* LA TABLE DES CONTENUS. Trois étapes ont désormais leur propre demande ; les
       autres retombent sur le générique juste en dessous. Le gabarit, lui, ne change
       pas : même en-tête, même bloc marché, même pied. */
    const seg = contenuExpert({ stage, expert, city, fr, url, note, ask, proWho });
    if (seg) {
      subject = seg.subject;
      const mentionGratuit = seg.gratuit
        ? `<div style="margin-top:13px;font-size:12.5px;color:#C8102E;font-weight:bold;">${seg.gratuit}</div>`
        : '';
      close = CLOSE('#fdf6f7', '#f3d9dd',
        `${H3(seg.h3)}${P(seg.corps)}${mentionGratuit}${BTN(seg.href, seg.bouton)}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}.` : `You're receiving this because you are ${proWho}.`,
        unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe', postale, fr);
      return { subject, html: `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${marketCore(city, fr, eyebrow)}${provinceBlock(macro, city, fr)}${nationalBlock(macro, fr)}${close}${foot}</table></div>` };
    }

    const ligneValeur = ask
      ? (fr ? `Votre fiche est à <b>${note ?? '—'}/100</b>. La donnée la plus payante qui vous manque : <b>${ask}</b>. Répondez à ce courriel avec — je mets à jour le jour même.`
            : `Your profile sits at <b>${note ?? '—'}/100</b>. The most valuable missing piece: <b>${ask}</b>. Just reply — I update the same day.`)
      : (fr ? `Votre fiche est à <b>${note ?? '—'}/100</b> et ne manque de rien. Elle est publique, vérifiable, et c'est elle que l'annuaire nomme pour ${city.name}.${phraseCitations(fr)}`
            : `Your profile sits at <b>${note ?? '—'}/100</b> with nothing missing. It is public, verifiable, and it is what the directory names for ${city.name}.${phraseCitations(fr)}`);
    close = CLOSE('#faf8f7', '#eee9e8', `${H3(fr ? `Vous êtes ${proWho}.` : `You are ${proWho}.`)}${P(ligneValeur)}${BTN(url, fr ? 'Voir ma fiche →' : 'See my profile →')}`);
    foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}.` : `You're receiving this because you are ${proWho}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe', postale, fr);
  }
  const html = `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${marketCore(city, fr, eyebrow)}${provinceBlock(macro, city, fr)}${nationalBlock(macro, fr)}${close}${foot}</table></div>`;
  return { subject, html };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULLETIN PROVINCIAL — DEUX VARIANTES (branché le 23 sept. 2026, décision proprio :
// « oui je m'engage, branche les deux variantes »). DERRIÈRE `PROVINCIAL_ACTIF`, FERMÉ.
//
// À QUI. Les 5 423 clés `s:prov-{province}:{courriel}` : des professionnels récoltés
// dans une municipalité où Payotte ne publie pas de chiffres. Jusqu'ici la boucle des
// prospects les sautait (`cityBySlug` ne connaît pas « prov-quebec »).
//
// DEUX VARIANTES, choisies par la municipalité réelle du destinataire (`villeReelle`) :
//   · BANLIEUE    — la municipalité est dans le territoire publié d'une chambre que
//                   Payotte suit (table `BANLIEUES_ZONES`, Statistique Canada, recensement
//                   2021). Le courriel donne le pouls de CETTE zone et NOMME sa portée
//                   (« Chiffres de la RMR de Montréal, qui englobe Candiac »). ~1 634 adresses.
//   · PROVINCIALE — tout le reste. Statistique ACI provinciale quand elle existe (MB, NS,
//                   NB), sinon les trois grands marchés suivis dans la province, chacun
//                   avec SA chambre et SA période. ~3 789 adresses.
//
// ⚠ LE TEXTE EST CELUI DU PROTOTYPE VALIDÉ PAR GRÉGORY le 23 sept. (scratchpad
// `bulletin-provincial/rendre.mjs`, aperçu claude.ai/artifact/D2MEnj4K38u5DdFcrvF3gD).
// Seules les SOURCES changent : le prototype lisait les fichiers du dépôt du site, le
// worker lit les flux publics (/api/market.json, /api/villes-couvertes.json,
// /api/province-market.json). Toute retouche de phrase ici est une retouche du texte
// validé : la faire valider d'abord.
//
// ⚠ TORONTO, CALGARY, VICTORIA, ST. CATHARINES publient pour la VILLE SEULE : leurs
// banlieues ne sont pas dans la table et restent au provincial. C'est voulu — dire
// « chiffres de Toronto, qui englobe Vaughan » serait faux.

// Normalisation des noms de municipalités — LA MÊME que celle qui a produit la table :
// minuscules, accents retirés, « St. »/« Ste » → saint/sainte, tout le reste en espaces.
// ⚠ Pas la même que `normVille` (tirets) : c'est celle de la table, et c'est la table
// qu'on interroge.
const normMunicipalite = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/\bste\b\.?/g, 'sainte').replace(/\bst\b\.?/g, 'saint')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Banlieue → zone publiée. Clé « province|slug de la zone », valeur = municipalités
// normalisées séparées par « | ». 255 municipalités. Langley exclue (FVREB, pas GVR) ;
// Sherwood Park → edmonton (hameau de Strathcona County).
const BANLIEUES_ZONES_BRUT = {
  'alberta|edmonton':
    'alexander 134|beaumont|betula beach|bon accord|bruderheim|calmar|devon|edmonton|enoch cree nation|'
    + 'fort saskatchewan|gibbons|golden days|itaska beach|kapasiwin|lakeview|leduc|leduc county|legal|'
    + 'morinville|parkland county|point alison|redwater|saint albert|seba beach|sherwood park|spring lake|'
    + 'spruce grove|stony plain|strathcona county|sturgeon county|sundance beach|thorsby|wabamun 133a|'
    + 'wabamun 133b|warburg',
  'british-columbia|vancouver':
    'anmore|barnston island 3|belcarra|bowen island|burnaby|burrard inlet 3|capilano 5|coquitlam|'
    + 'coquitlam 1|coquitlam 2|delta|katzie 1|katzie 2|lions bay|maple ridge|matsqui 4|mcmillan island 6|'
    + 'metro vancouver a|mission 1|musqueam 2|musqueam 4|new westminster|north vancouver|pitt meadows|'
    + 'port coquitlam|port moody|richmond|semiahmoo|seymour creek 2|surrey|tsawwassen|vancouver|'
    + 'west vancouver|white rock|whonnock 1',
  'new-brunswick|moncton':
    'coverdale|dieppe|dorchester|elgin|fort folly 1|hillsborough|hopewell|memramcook|moncton|riverview|'
    + 'saint paul|salisbury',
  'newfoundland-and-labrador|st-johns':
    'bauline|bay bulls|conception bay south|flatrock|holyrood|logy bay middle cove outer cove|mount pearl|'
    + 'paradise|petty harbour maddox cove|portugal cove saint philip s|pouch cove|saint john s|torbay|'
    + 'witless bay',
  'ontario|windsor':
    'amherstburg|essex|kingsville|lakeshore|lasalle|leamington|tecumseh|windsor',
  'quebec|montreal':
    'baie d urfe|beaconsfield|beauharnois|beloeil|blainville|bois des filion|boisbriand|boucherville|'
    + 'brossard|candiac|carignan|chambly|charlemagne|chateauguay|cote saint luc|coteau du lac|delson|'
    + 'deux montagnes|dollard des ormeaux|dorval|gore|hampstead|hudson|kahnawake|kanesatake|kirkland|'
    + 'l assomption|l epiphanie|l ile cadieux|l ile dorval|l ile perrot|la prairie|laval|lavaltrie|lery|'
    + 'les cedres|les coteaux|longueuil|lorraine|mascouche|mcmasterville|mercier|mirabel|mont royal|'
    + 'mont saint hilaire|montreal|montreal est|montreal ouest|notre dame de l ile perrot|oka|'
    + 'otterburn park|pincourt|pointe calumet|pointe claire|pointe des cascades|repentigny|richelieu|'
    + 'rosemere|saint amable|saint basile le grand|saint bruno de montarville|saint colomban|saint constant|'
    + 'saint eustache|saint isidore|saint jean sur richelieu|saint jerome|saint joseph du lac|saint lambert|'
    + 'saint lazare|saint lin laurentides|saint mathias sur richelieu|saint mathieu|'
    + 'saint mathieu de beloeil|saint philippe|saint placide|saint roch de l achigan|saint sulpice|'
    + 'saint zotique|sainte anne de bellevue|sainte anne des plaines|sainte catherine|sainte julie|'
    + 'sainte marthe sur le lac|sainte therese|senneville|terrasse vaudreuil|terrebonne|varennes|'
    + 'vaudreuil dorion|vaudreuil sur le lac|vercheres|westmount',
  'quebec|quebec-city':
    'beaumont|boischatel|chateau richer|fossambault sur le lac|l ancienne lorette|l ange gardien|'
    + 'lac beauport|lac delage|lac saint joseph|levis|neuville|notre dame des anges|quebec|'
    + 'saint antoine de tilly|saint apollinaire|saint augustin de desmaures|'
    + 'saint francois de l ile d orleans|saint gabriel de valcartier|saint henri|'
    + 'saint jean de l ile d orleans|saint lambert de lauzon|saint laurent de l ile d orleans|'
    + 'saint pierre de l ile d orleans|sainte brigitte de laval|sainte catherine de la jacques cartier|'
    + 'sainte famille de l ile d orleans|sainte petronille|shannon|stoneham et tewkesbury|wendake',
  'quebec|saguenay':
    'begin|ferland et boilleau|larouche|saguenay|saint charles de bourget|saint david de falardeau|'
    + 'saint felix d otis|saint fulgence|saint honore|sainte rose du nord',
  'quebec|sherbrooke':
    'ascot corner|compton|hatley|magog|north hatley|orford|saint denis de brompton|sherbrooke|stoke|'
    + 'val joli|waterville',
  'quebec|trois-rivieres':
    'becancour|champlain|saint luc de vincennes|saint maurice|trois rivieres|wolinak|yamachiche',
};
// Index construit une fois au chargement : « province|municipalité » → slug de zone.
const BANLIEUES_ZONES = (() => {
  const m = new Map();
  for (const [cle, liste] of Object.entries(BANLIEUES_ZONES_BRUT)) {
    const [prov, zone] = cle.split('|');
    for (const muni of liste.split('|')) m.set(`${prov}|${muni}`, zone);
  }
  return m;
})();
/** Slug de la zone publiée qui englobe cette municipalité, ou null (→ provincial). */
const zoneDeBanlieue = (provSlug, villeReelle) =>
  BANLIEUES_ZONES.get(`${provSlug}|${normMunicipalite(villeReelle)}`) ?? null;

// Territoires publiés qui INCLUENT les banlieues (portée de la chambre vérifiée le 23 sept.) :
// hors de cette liste, la ville-centre ne publie que pour elle-même → bulletin provincial.
const PORTEE_RMR = {
  montreal: ['la RMR de Montréal', 'the Montréal CMA'], 'quebec-city': ['la RMR de Québec', 'the Québec CMA'],
  gatineau: ['la RMR de Gatineau', 'the Gatineau CMA'], sherbrooke: ['la RMR de Sherbrooke', 'the Sherbrooke CMA'],
  'trois-rivieres': ['la RMR de Trois-Rivières', 'the Trois-Rivières CMA'], saguenay: ['la RMR de Saguenay', 'the Saguenay CMA'],
  'st-johns': ["la RMR de St. John's", "the St. John's CMA"], moncton: ['le Grand Moncton', 'Greater Moncton'],
  windsor: ['Windsor-Essex', 'Windsor-Essex'], edmonton: ['le Grand Edmonton', 'Greater Edmonton'],
  ottawa: ['la région de la chambre d’Ottawa (OREB)', 'the Ottawa board region (OREB)'], vancouver: ['Metro Vancouver (territoire GVR)', 'Metro Vancouver (GVR area)'],
};

// Les cinq métiers de Payotte. Un arpenteur, un courtier d'assurance n'y sont pas : ils
// ne se voient promettre aucune place (voir `finProposer`).
const METIER_PLACE = { 'real-estate-broker': ['un courtier immobilier', 'one real estate broker'], 'mortgage-broker': ['un courtier hypothécaire', 'one mortgage broker'],
  'home-inspector': ['un inspecteur en bâtiment', 'one home inspector'], 'notary-lawyer': ['un notaire', 'one real estate lawyer'],
  appraiser: ['un évaluateur agréé', 'one appraiser'] };
const PROV_PREP = { quebec: 'au Québec', ontario: 'en Ontario', 'british-columbia': 'en Colombie-Britannique', alberta: 'en Alberta',
  saskatchewan: 'en Saskatchewan', manitoba: 'au Manitoba', 'nova-scotia': 'en Nouvelle-Écosse', 'new-brunswick': 'au Nouveau-Brunswick',
  'prince-edward-island': "à l'Île-du-Prince-Édouard", 'newfoundland-and-labrador': 'à Terre-Neuve-et-Labrador' };
const PROV_DU = { quebec: 'du Québec', ontario: "de l'Ontario", 'british-columbia': 'de la Colombie-Britannique', alberta: "de l'Alberta",
  saskatchewan: 'de la Saskatchewan', manitoba: 'du Manitoba', 'nova-scotia': 'de la Nouvelle-Écosse', 'new-brunswick': 'du Nouveau-Brunswick',
  'prince-edward-island': "de l'Île-du-Prince-Édouard", 'newfoundland-and-labrador': 'de Terre-Neuve-et-Labrador' };

// Noms d'affichage : /api/market.json écrit « Montreal », « Quebec », « Sudbury ». Le
// prototype lisait les noms bilingues de cities.json ; seules ces trois villes diffèrent
// (comparé le 23 sept. 2026 sur les 74 villes du flux). Les autres gardent `c.name`.
const NOMS_VILLES = {
  montreal: ['Montréal', 'Montreal'], 'quebec-city': ['Québec', 'Quebec City'],
  sudbury: ['Greater Sudbury', 'Greater Sudbury'],
};
const nomVilleBulletin = (c, fr) => NOMS_VILLES[c?.slug]?.[fr ? 0 : 1] ?? c?.name;
// Portée affichée = la CHAMBRE (sigle court), jamais geographyScope : ce champ porte parfois des
// notes de travail (« Aucun montant en $ ne concerne la ville de Hamilton seule — … »).
// Nom court de la chambre : le SIGLE entre parenthèses s'il existe (NSAR, GVR, RAE…), sinon ce
// qui précède « / » (APCIQ, TRREB, NLAR), sinon le nom s'il est court. L'ancienne règle gardait
// le premier MOT des noms longs : « Nova » pour la Nova Scotia Association of REALTORS.
const chambreCourte = (c) => {
  const b = String(c.board ?? '').trim();
  const sigle = /\(([A-Z]{2,})\)/.exec(b);
  if (sigle) return sigle[1];
  const avant = b.split('/')[0].trim();
  return avant.length <= 34 ? avant : (b.split(/[\s(]/)[0] || '');
};
const periodeLisible = (rm, fr) => { const q = /^(\d{4})-[QT](\d)$/.exec(String(rm)); if (q) return fr ? `${q[2] === '1' ? '1er' : q[2] + 'e'} trimestre ${q[1]}` : `Q${q[2]} ${q[1]}`; return moisLisible(rm, fr); };
const moisDeDate = (iso, fr) => moisLisible(String(iso).slice(0, 7), fr);

// Une phrase, et seulement tant que le relevé est frais (CITATIONS_LU_LE + 45 jours).
function citationsProv(fr) {
  if (!fraisDeLecture()) return '';
  const n = CITATIONS_30J.toLocaleString(fr ? 'fr-CA' : 'en-CA');
  // « Les IA » à la demande de Grégory ; « au moins » parce que le chiffre est celui de
  // Copilot SEUL (Bing AI Performance) — c'est un plancher, pas le total des IA.
  return fr ? ` En août, les IA ont cité payotte.com au moins <b>${n} fois</b>.`
            : ` In August, AI assistants cited payotte.com at least <b>${n} times</b>.`;
}

function finProposer({ villeReelle, metier, fr, voisins, ancre }) {
  const qui = METIER_PLACE[metier]?.[fr ? 0 : 1];
  // La rareté ne se promet qu'aux cinq métiers de Payotte : un arpenteur n'aura jamais de place.
  const rarete = qui ? (fr ? ` Une seule place par secteur et par métier : elle ne nommera qu'${qui}.` : ` One seat per sector and profession: it will name ${qui} only.`) : '';
  const texte = fr
    ? `<b>${villeReelle}</b> n'a pas encore sa page.${voisins ? ` ${ancre}, ${voisins} professionnels vérifiés ont la leur.` : ''}${rarete} Les villes les plus demandées ouvrent en premier.`
    : `<b>${villeReelle}</b> has no page yet.${voisins ? ` ${ancre}, ${voisins} verified professionals have theirs.` : ''}${rarete} The most requested cities open first.`;
  return CLOSE('#fdf6f7', '#f3d9dd', P(texte + citationsProv(fr)) +
    BTN(`${SITE}${fr ? '/contact' : '/en/contact'}`, fr ? `Proposer ${villeReelle} →` : `Put ${villeReelle} forward →`));
}

const pctBulletinProv = (v, fr) => v === 0 ? `<span style="color:#6f6769;">${fr ? 'stable' : 'flat'}</span>` : `<span style="color:${v > 0 ? '#1f7a44' : '#b3261e'};">${fmtPct(Math.round(v * 10) / 10, fr)}</span>`;
const rowBulletinProv = (g, d, sous = '') => `<tr><td style="padding:10px 0;border-bottom:1px solid #f1ecec;font-size:14px;color:#211c1e;">${g}${sous ? `<div style="font-size:11px;color:#a49c9e;">${sous}</div>` : ''}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #f1ecec;font-size:14px;font-weight:bold;color:#211c1e;white-space:nowrap;">${d}</td></tr>`;

/**
 * Variante BANLIEUE : le pouls de la zone publiée qui englobe la municipalité, portée NOMMÉE.
 * `ctx` = { cities (market.json), macro, publiesVille(slug), publiesProvince(provSlug), provMarket }.
 * Rend null si la zone n'a pas de chiffres ce mois-ci (l'appelant retombe sur le provincial).
 */
function renderBanlieue({ citySlug, villeReelle, metier, lang, unsubUrl, postale = '' }, ctx) {
  const fr = lang !== 'en';
  const c = (ctx.cities || []).find((x) => x.slug === citySlug);
  if (!c || refOf(c).valeur == null || !PORTEE_RMR[citySlug]) return null;
  const macro = ctx.macro;
  const nomRmr = nomVilleBulletin(c, fr);
  const nb = (v) => Number(v).toLocaleString(fr ? 'fr-CA' : 'en-CA');
  const pct = (v) => pctBulletinProv(v, fr);
  const row = rowBulletinProv;
  const r = refOf(c);
  let lignes = row(fr ? 'Prix de référence' : 'Reference price', `${fmtMoney(r.valeur, fr)} ${r.yoy != null ? pct(r.yoy) : ''}`, `${chambreCourte(c)} · ${periodeLisible(c.referenceMonth, fr)}`);
  if (c.sales != null) lignes += row(fr ? 'Ventes du mois' : 'Sales', nb(c.sales));
  if (c.monthsOfInventory != null) lignes += row(fr ? "Mois d'inventaire" : 'Months of inventory', String(c.monthsOfInventory).replace('.', fr ? ',' : '.'));
  const rt = macro?.rates ?? {};
  if (rt.mortgage5yrFixed?.percent != null) lignes += row(fr ? 'Taux fixe 5 ans (moyenne)' : '5-yr fixed (average)', `${rt.mortgage5yrFixed.percent.toLocaleString(fr ? 'fr-CA' : 'en-CA')} %`, `${fr ? 'Banque du Canada' : 'Bank of Canada'} · ${moisDeDate(rt.mortgage5yrFixed.observed, fr)}`);
  const zone = PORTEE_RMR[citySlug][fr ? 0 : 1];
  const portee = fr ? `Chiffres de ${zone}, qui englobe ${villeReelle}.` : `Figures for ${zone}, which includes ${villeReelle}.`;
  const subject = GABARIT_IA ? sujetTestIA(villeReelle, metier, fr) : fr ? `${villeReelle} : votre marché, ce mois-ci` : `${villeReelle}: your market, this month`;
  const tete = GABARIT_IA ? teteTestIA(villeReelle, fr) : `<tr><td style="padding:24px 32px 18px 32px;border-bottom:1px solid #f1ecec;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td><td align="right" style="font-size:11px;letter-spacing:.5px;color:#c8102e;">${villeReelle}</td></tr></table></td></tr>`;
  const corps = `<tr><td style="padding:24px 32px 4px 32px;"><div style="font-family:Georgia,'Times New Roman',serif;font-size:21px;color:#211c1e;margin-bottom:6px;">${fr ? 'Le pouls du marché' : 'The market pulse'} — ${villeReelle}</div><div style="font-size:12.5px;color:#6f6769;margin-bottom:12px;">${portee}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #f1ecec;">${lignes}</table></td></tr>`;
  const close = GABARIT_IA ? finTestIA(villeReelle, fr) : finProposer({ villeReelle, metier, fr, voisins: ctx.publiesVille(citySlug), ancre: fr ? `À ${nomRmr}` : `In ${nomRmr}` });
  const foot = FOOT(fr ? `Pouls de ${zone}, une fois par mois.` : `${zone} pulse, once a month.`, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe', postale, fr);
  return { subject, html: `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${tete}${corps}${close}${foot}</table></div>` };
}

/**
 * Variante PROVINCIALE (la « version courte » du 23 sept. : 3 marchés, chantiers et taux sur
 * une ligne chacun, fin en deux phrases, un seul bouton). La statistique ACI provinciale
 * (MB, NS, NB) passe en premier quand /api/province-market.json est là ; SANS ce flux, on
 * retombe sur les trois grands marchés suivis dans la province — jamais une moyenne maison.
 * Rend null s'il n'y a AUCUN chiffre de marché à montrer (rien à envoyer).
 */
function renderProvincial({ provSlug, villeReelle, metier, lang, unsubUrl, postale = '' }, ctx) {
  const fr = lang !== 'en';
  const nom = PROV_NOMS[provSlug]?.[fr ? 0 : 1];
  const code = PROV_TO_CODE[provSlug]?.toUpperCase();
  if (!nom || !code) return null;
  const macro = ctx.macro;
  const nb = (v) => Number(v).toLocaleString(fr ? 'fr-CA' : 'en-CA');
  const pct = (v) => pctBulletinProv(v, fr);
  const row = rowBulletinProv;
  const pm = (ctx.provMarket || []).find((x) => x.slug === provSlug);
  let lignes = '';
  if (pm?.benchmark_hpi != null) {
    lignes += row(fr ? 'Prix de référence (province)' : 'Benchmark price (province)', `${fmtMoney(pm.benchmark_hpi, fr)} ${pct(pm.benchmark_yoy_pct)}`, `${fr ? 'ACI' : 'CREA'} · ${moisLisible(pm.reference_month, fr)}`);
    lignes += row(fr ? 'Ventes du mois' : 'Sales', `${nb(pm.sales)} ${pct(pm.sales_yoy_pct)}`);
  } else {
    for (const c of (ctx.cities || []).filter((c) => c.province === code && refOf(c).valeur != null && !/aucun montant|ne concerne|seule\b/i.test(c.geographyScope ?? '')).sort((a, b) => (b.sales ?? 0) - (a.sales ?? 0)).slice(0, 3)) {
      const r = refOf(c);
      lignes += row(nomVilleBulletin(c, fr), `${fmtMoney(r.valeur, fr)} ${r.yoy != null ? pct(r.yoy) : ''}`, `${chambreCourte(c)} · ${periodeLisible(c.referenceMonth, fr)}`);
    }
  }
  if (!lignes) return null;
  const hs = macro?.chantiers?.find((r) => r.isProvince && r.province === provSlug);
  if (hs?.startsSaar != null) lignes += row(fr ? 'Mises en chantier (rythme annuel)' : 'Housing starts (annual rate)', `${nb(hs.startsSaar)} ${hs.changeYoyPct != null ? pct(hs.changeYoyPct) : ''}`, `${fr ? 'SCHL' : 'CMHC'} · ${moisDeDate(hs.referenceMonth, fr)}`);
  const r = macro?.rates ?? {};
  if (r.mortgage5yrFixed?.percent != null) lignes += row(fr ? 'Taux fixe 5 ans (moyenne)' : '5-yr fixed (average)', `${r.mortgage5yrFixed.percent.toLocaleString(fr ? 'fr-CA' : 'en-CA')} %`, `${fr ? 'Banque du Canada' : 'Bank of Canada'} · ${moisDeDate(r.mortgage5yrFixed.observed, fr)}`);

  const lieu = villeReelle || nom;
  const subject = GABARIT_IA ? sujetTestIA(lieu, metier, fr) : fr ? `Le marché ${PROV_PREP[provSlug]}, ce mois-ci` : `${nom}’s market, this month`;
  const tete = GABARIT_IA ? teteTestIA(lieu, fr) : `<tr><td style="padding:24px 32px 18px 32px;border-bottom:1px solid #f1ecec;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td><td align="right" style="font-size:11px;letter-spacing:.5px;color:#c8102e;">${nom}</td></tr></table></td></tr>`;
  const corps = `<tr><td style="padding:24px 32px 4px 32px;"><div style="font-family:Georgia,'Times New Roman',serif;font-size:21px;color:#211c1e;margin-bottom:12px;">${fr ? 'Le pouls du marché' : 'The market pulse'} — ${nom}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #f1ecec;">${lignes}</table></td></tr>`;
  const close = GABARIT_IA ? finTestIA(lieu, fr) : finProposer({ villeReelle, metier, fr,
    voisins: ctx.publiesProvince(provSlug),
    ancre: fr ? `Ailleurs ${PROV_PREP[provSlug]}` : `Elsewhere in ${nom}` });
  const foot = FOOT(fr ? `Pouls ${PROV_DU[provSlug]}, une fois par mois.` : `${nom}'s pulse, once a month.`, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe', postale, fr);
  return { subject, html: `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${tete}${corps}${close}${foot}</table></div>` };
}

/**
 * Point d'entrée unique : choisit la variante et la rend. Rend { subject, html, variante,
 * zone } ou null (rien de vrai à dire → on n'envoie pas).
 */
function renderBulletinProvincial({ provSlug, villeReelle, metier, lang, unsubUrl, postale = '' }, ctx) {
  const zone = zoneDeBanlieue(provSlug, villeReelle);
  if (zone) {
    const b = renderBanlieue({ citySlug: zone, villeReelle, metier, lang, unsubUrl, postale }, ctx);
    if (b) return { ...b, variante: 'banlieue', zone };
  }
  const p = renderProvincial({ provSlug, villeReelle, metier, lang, unsubUrl, postale }, ctx);
  return p ? { ...p, variante: 'provincial', zone: null } : null;
}

// Resend limite à 2 requêtes/seconde (429 au-delà). La boucle du bulletin tire en rafale :
// on espace les appels pour rester sous la barre. 600 ms ≈ 1,6 envoi/s.
const RESEND_MIN_GAP_MS = 600;

// ═══════════════════════════════════════════════════════════════════════════════════
// SÉQUENCE DE SIX SEMAINES (2026-08-19)
// ═══════════════════════════════════════════════════════════════════════════════════
//
// CE QUE C'EST. Une suite FINIE de six courriels hebdomadaires à un expert publié, chacun
// portant SON chiffre à lui. Elle ne remplace pas l'escalier mensuel : elle le suspend le
// temps qu'elle dure, puis l'expert y retourne.
//
// L'ÉQUILIBRE, ET C'EST LA RAISON D'ÊTRE DE L'ORDRE. Quatre des six semaines donnent
// quelque chose sans rien demander ; une seule vend. Une première version en avait quatre
// qui parlaient de Payotte — un pro n'a aucune raison de lire ça. Chaque semaine « pour
// eux » doit rester utile même s'ils ne confirment jamais leur fiche.
//
//   S1  le virage IA de SON métier ............ contenu pur, aucune demande
//   S2  la lisibilité IA de SON site .......... diagnostic de son bien à lui
//   S3  le marché de SON secteur + les taux ... contenu pur, aucune demande
//   S4  sa fiche : confirmer .................. première demande, légère
//   S5  le badge .............................. un outil pour lui (lien retour)
//   S6  la tribune ............................ la seule offre payante
//
// TROIS RÈGLES QUI NE SE NÉGOCIENT PAS, chacune payée par une erreur passée :
//
//  1. ON NE DIT JAMAIS QUE SA FICHE EST CITÉE. Au relevé du 14 août, AUCUNE fiche
//     individuelle n'apparaît dans les pages citées par Copilot — ce sont les pages de
//     coûts en anglais et deux hubs. On écrit « le site est cité », jamais « votre fiche ».
//     (Règle #3, et la phrase serait fausse le jour où le pro la vérifie.)
//
//  2. RÈGLE NAZAR — S6 ne propose JAMAIS une tribune dans le secteur où le destinataire
//     est classé. Vendre une tribune à celui qu'on classe N° 1 de ce même secteur, c'est
//     exactement ce que le council du 12 août a interdit. S6 dit d'emblée « pas dans votre
//     secteur, par construction ».
//
//  3. ON N'ANNONCE JAMAIS LA FIN. Pas de « dernier courriel », pas de compte à rebours.
//     Le lien de désabonnement est là depuis S1 : qui veut sortir sort. Annoncer la fin
//     transforme une suite de courriels utiles en entonnoir de vente affiché.
//
// L'ÉTAT VIVANT PRIME SUR LE SCRIPT. À chaque envoi on relit la fiche : si le pro a
// confirmé entre S2 et S4, S4 devient un remerciement. La séquence ne rejoue pas un script
// écrit d'avance devant quelqu'un qui a déjà répondu.

/** Le chiffre du virage IA, par métier. Chaque valeur porte sa source et son année. */
const IA_METIER = {
  'real-estate-broker': {
    fr: { n: '36 %', quoi: 'des vendeurs trouvent leur courtier en ligne — le double de 2018',
          src: 'NAR, Profile of Home Buyers and Sellers 2024' },
    en: { n: '36%', quoi: 'of sellers find their agent through online channels — double 2018',
          src: 'NAR, Profile of Home Buyers and Sellers 2024' } },
  'mortgage-broker': {
    fr: { n: '83 %', quoi: 'des recherches ne mènent à AUCUN site quand un résumé IA s’affiche',
          src: 'Bain–Dynata Generative AI Consumer Survey, 2024' },
    en: { n: '83%', quoi: 'of searches lead to NO site at all when an AI summary appears',
          src: 'Bain–Dynata Generative AI Consumer Survey, 2024' } },
  'home-inspector': {
    fr: { n: '46 %', quoi: 'des recherches Google ont une intention locale (« près de moi », nom de quartier)',
          src: 'Google / BrightLocal, Local SEO Statistics 2025' },
    en: { n: '46%', quoi: 'of Google searches carry local intent (“near me”, neighbourhood names)',
          src: 'Google / BrightLocal, Local SEO Statistics 2025' } },
  'notary-lawyer': {
    fr: { n: '87 %', quoi: 'des consommateurs consultent les avis en ligne pour juger un professionnel local',
          src: 'BrightLocal, Local Consumer Review Survey 2024' },
    en: { n: '87%', quoi: 'of consumers use online reviews to judge a local professional',
          src: 'BrightLocal, Local Consumer Review Survey 2024' } },
  appraiser: {
    fr: { n: '+30 à 40 %', quoi: 'de chances d’être cité par une IA pour une page en données structurées',
          src: 'Frase.io, GEO Playbook 2025' },
    en: { n: '+30 to 40%', quoi: 'more likely to be cited by an AI when a page carries structured data',
          src: 'Frase.io, GEO Playbook 2025' } },
};

/** Les cinq piliers de l'Indice IA, pour nommer celui qui coûte le plus. */
const PILIERS_IA = [
  { cle: 'structure', max: 25, fr: 'données structurées (JSON-LD)', en: 'structured data (JSON-LD)' },
  { cle: 'acces', max: 30, fr: 'accès des robots d’IA', en: 'AI crawler access' },
  { cle: 'aeo', max: 20, fr: 'réponse prélevable', en: 'extractable answer' },
  { cle: 'ancrage', max: 15, fr: 'ancrage local lisible', en: 'machine-readable local anchoring' },
  { cle: 'technique', max: 10, fr: 'hygiène technique', en: 'technical hygiene' },
];

/** Le pilier au plus gros écart — celui qu'on nomme, jamais une liste de cinq reproches. */
function pilierLePlusCher(ia, fr) {
  if (!ia) return null;
  let pire = null;
  for (const p of PILIERS_IA) {
    const v = Number(ia[p.cle] ?? 0);
    const manque = p.max - v;
    if (!pire || manque > pire.manque) pire = { ...p, v, manque };
  }
  return pire && pire.manque > 0 ? { nom: fr ? pire.fr : pire.en, v: pire.v, max: pire.max } : null;
}

/**
 * Rend l'étape `etape` (1..6) de la séquence. Même gabarit visuel que le pouls mensuel.
 * `seq.ia` vient de l'enrôlement (ai-readiness.csv) ; `expert` est relu à chaque envoi.
 */
function renderSequence({ etape, expert, city, seq, lang, unsubUrl, macro = null, postale = '' }) {
  const fr = lang !== 'en';
  const url = expert?.url || SITE;
  const nom = expert?.professional?.name || expert?.name || '';
  const prenom = String(nom).trim().split(/\s+/)[0] || '';
  const salut = fr ? (prenom ? `Bonjour ${prenom},` : 'Bonjour,') : (prenom ? `Hello ${prenom},` : 'Hello,');
  const secteur = expert?.sectorName || city?.name || '';
  const metier = expert?.professionLabel || '';
  const eyebrow = `${fr ? 'Espace professionnels' : 'For professionals'}<br><span style="color:#c8102e;letter-spacing:1px;">${secteur}</span>`;
  const sig = P(fr ? `À bientôt,<br><span style="font-family:Georgia,serif;font-style:italic;">Grégory</span>`
                  : `Best,<br><span style="font-family:Georgia,serif;font-style:italic;">Grégory</span>`);
  const pied = (quoi) => FOOT(quoi, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe', postale, fr);
  const pourquoi = fr
    ? `Vous recevez ce courriel parce que vous êtes le ${metier} vérifié de ${secteur} sur Payotte.`
    : `You are receiving this because you are the verified ${metier} for ${secteur} on Payotte.`;

  // L'état VIVANT commande : confirmé entre-temps → S4 remercie au lieu de redemander.
  const confirme = expert?.ownerVerified === true;
  const badgePose = expert?.badgeExchange === true;

  let subject, corps;

  if (etape === 1) {
    const st = IA_METIER[expert?.profession] ?? IA_METIER['real-estate-broker'];
    const d = fr ? st.fr : st.en;
    subject = fr ? `${secteur} : ${d.n} — ce qui a changé dans la façon dont on vous trouve`
                 : `${secteur}: ${d.n} — what changed in how people find you`;
    corps = CLOSE('#faf8f7', '#eee9e8',
      `${P(salut)}${H3(fr ? 'Quand l’IA répond, elle ne nomme qu’un seul expert' : 'When AI answers, it names one expert')}`
      + P(fr ? `Un chiffre de votre métier, pour commencer : <b>${d.n}</b> ${d.quoi}.`
             : `One figure from your trade: <b>${d.n}</b> ${d.quoi}.`)
      + P(fr ? `La recherche ne se partage plus entre dix liens : elle se résume en une réponse, et cette réponse nomme <b>un</b> professionnel. Ce n’est pas le classement qui décide qui elle nomme — c’est ce qu’une machine peut vérifier sur vous.`
             : `Search no longer spreads across ten links: it collapses into one answer, and that answer names <b>one</b> professional. What decides is not ranking — it is what a machine can verify about you.`)
      + BTN(`${SITE}${fr ? '/ia-en-immobilier' : '/en/ai-in-real-estate'}`, fr ? 'Le virage IA, pour votre métier →' : 'The AI shift, for your trade →')
      + sig);
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(`${pourquoi} ${fr ? `Source : ${d.src}.` : `Source: ${d.src}.`}`), macro, false) };
  }

  if (etape === 2) {
    const ia = seq?.ia;
    const pire = pilierLePlusCher(ia, fr);
    subject = ia?.score != null
      ? (fr ? `${ia.domaine} : ${ia.score}/100 pour les moteurs de réponse` : `${ia.domaine}: ${ia.score}/100 for answer engines`)
      : (fr ? `Ce que les IA voient de votre site` : `What AI engines see of your site`);
    corps = CLOSE('#fdf6e9', '#f2e4c4',
      `${P(salut)}${H3(fr ? 'Ce que ChatGPT et Copilot voient de votre site' : 'What ChatGPT and Copilot see of your site')}`
      + P(ia?.score != null
        ? (fr ? `J’ai passé <b>${ia.domaine}</b> dans le protocole de notre étude sur 446 cabinets : <b>${ia.score}/100</b>, pour une médiane de 49. Ce n’est pas un jugement sur votre pratique — c’est une mesure de ce que le CODE de vos pages rend lisible à une machine, pas à un humain.`
              : `I ran <b>${ia.domaine}</b> through the protocol of our study of 446 firms: <b>${ia.score}/100</b>, against a median of 49. This is not a judgement on your practice — it measures what the CODE of your pages makes readable to a machine, not to a human.`)
        : (fr ? `Notre étude a mesuré 446 cabinets sur 100 points de lisibilité par les moteurs de réponse. La médiane est de 49.`
              : `Our study measured 446 firms on 100 points of answer-engine readability. The median is 49.`))
      + (pire ? P(fr ? `Le pilier qui vous coûte le plus : <b>${pire.nom}</b>, à ${pire.v}/${pire.max}. C’est aussi le plus rapide à corriger.`
                     : `The pillar costing you most: <b>${pire.nom}</b>, at ${pire.v}/${pire.max}. It is also the quickest to fix.`) : '')
      + BTN(`${SITE}${fr ? '/etudes/lisibilite-ia-experts-immobiliers' : '/en/studies/ai-readiness-real-estate-experts'}`,
            fr ? 'L’étude complète, méthode incluse →' : 'The full study, method included →')
      + sig);
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, false) };
  }

  if (etape === 3) {
    subject = fr ? `Le marché de ${city?.name ?? secteur} — et les taux` : `${city?.name ?? secteur}'s market — and rates`;
    corps = CLOSE('#f3f6f8', '#dde6ea',
      `${P(salut)}`
      + P(fr ? `Les chiffres du mois pour votre marché, et les taux qui les commandent. Rien à faire de votre côté : c’est de la matière pour vos conversations de la semaine.`
             : `This month's figures for your market, and the rates that drive them. Nothing to do on your side: it is material for your conversations this week.`)
      + P(fr ? `Ces chiffres sont publics et structurés — le genre de donnée qu’une IA cite directement quand un client lui demande comment va le marché.`
             : `These figures are public and structured — the kind of data an AI cites directly when a client asks how the market is doing.`)
      + BTN(cityUrl(city), fr ? `Les chiffres de ${city?.name ?? secteur} →` : `${city?.name ?? secteur} figures →`)
      + sig);
    // Seule étape qui porte la grille de marché ET le bloc taux : c'est son contenu.
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, true) };
  }

  if (etape === 4) {
    if (confirme) {
      subject = fr ? `Votre fiche est confirmée — merci` : `Your profile is confirmed — thank you`;
      corps = CLOSE('#eef5f0', '#cfe4d7',
        `${P(salut)}${H3(fr ? 'C’est fait, et c’est le plus haut niveau du site.' : 'Done — and it is the site’s highest tier.')}`
        + P(fr ? `Votre fiche est confirmée : elle porte le statut <b style="color:#1f7a44;">Recommandé N° 1</b>, avec vos sources vérifiables et votre numéro de permis publié pour que le lecteur le contrôle lui-même.`
               : `Your profile is confirmed: it carries the <b style="color:#1f7a44;">Recommended #1</b> status, with your verifiable sources and your licence number published for readers to check themselves.`)
        + BTN(url, fr ? 'Voir votre fiche →' : 'See your profile →') + sig);
    } else {
      const manque = missingAsk(expert, fr);
      subject = fr ? `Votre fiche à ${secteur} : ${expert?.score?.total ?? ''}/100` : `Your ${secteur} profile: ${expert?.score?.total ?? ''}/100`;
      corps = CLOSE('#eef5f0', '#cfe4d7',
        `${P(salut)}${H3(fr ? 'Vous êtes déjà la référence vérifiée du secteur' : 'You are already the sector’s verified reference')}`
        + P(fr ? `Votre fiche est à <b>${expert?.score?.total ?? ''}/100</b>. Elle n’est pas encore confirmée par vous : c’est la seule chose qui vous sépare du niveau <b style="color:#1f7a44;">Recommandé N° 1</b> — et du jeu de données le plus complet qu’une machine puisse lire à votre sujet.`
               : `Your profile sits at <b>${expert?.score?.total ?? ''}/100</b>. It is not yet confirmed by you: that is the only thing between you and <b style="color:#1f7a44;">Recommended #1</b> — and the most complete data set a machine can read about you.`)
        /* « Répondez à ce courriel » EST REDEVENU VRAI le 8 sept. 2026, et pas avant.
           Ce matin-là, `payotte.com` n'avait AUCUN MX : la demande était impossible et
           le pied de page se contredisait deux lignes plus bas. MX ImprovMX posés
           depuis, chaîne vérifiée de bout en bout (Gmail → mx1 → Gmail, 4 secondes).
           ⚠ Si quelqu'un retire les MX un jour, CETTE PHRASE REDEVIENT UN MENSONGE :
           la repasser par /contact. Le council notait « aucune réponse de ces 550 »
           après juillet — il se peut que ce silence ait été un trou de plomberie, pas
           un problème d'angle. Le prochain envoi le dira. */
        + P(fr ? `La donnée qu’on ne peut pas confirmer nous-mêmes : <b>${manque}</b>. Répondez à ce courriel avec, je mets à jour le jour même, daté et sourcé.`
               : `The one piece we cannot confirm ourselves: <b>${manque}</b>. Just reply and I update the same day, dated and sourced.`)
        + BTN(url, fr ? 'Voir ma fiche →' : 'See my profile →') + sig);
    }
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, false) };
  }

  if (etape === 5) {
    if (badgePose) {
      subject = fr ? `Votre badge est en ligne — merci` : `Your badge is live — thank you`;
      corps = CLOSE('#fbedef', '#f0d3d9',
        `${P(salut)}${H3(fr ? 'Le lien est posé.' : 'The link is live.')}`
        + P(fr ? `Votre badge est en ligne sur votre site. C’est un lien retour permanent vers votre fiche — et l’un des rares signaux qu’une machine relie durablement à votre nom. Rien d’autre à faire.`
               : `Your badge is live on your site. It is a permanent link back to your profile — one of the few signals a machine ties durably to your name. Nothing else to do.`)
        + sig);
    } else {
      subject = fr ? `Le badge de ${secteur} : le code, prêt à coller` : `The ${secteur} badge: code ready to paste`;
      corps = CLOSE('#fbedef', '#f0d3d9',
        `${P(salut)}${H3(fr ? 'Un actif pour votre site, pas une récompense' : 'An asset for your site, not a reward')}`
        + P(fr ? `Le badge fait deux choses à la fois : un <b>lien retour</b> vers votre fiche depuis votre propre domaine — bon pour votre référencement — et un second signal structuré qu’une machine peut relier à votre nom. C’est exactement le levier dont parlait le courriel sur les données structurées.`
               : `The badge does two things at once: a <b>backlink</b> to your profile from your own domain — good for your SEO — and a second structured signal a machine can tie to your name. It is precisely the lever the structured-data email described.`)
        + P(fr ? `Le code est prêt à coller, ou à transmettre à qui gère votre site. Deux minutes. C’est gratuit, et ça le restera : le classement ne s’achète pas, c’est ce qui lui donne sa valeur.`
               : `The code is ready to paste, or to forward to whoever runs your site. Two minutes. It is free and will stay free: ranking is not for sale, which is what gives it value.`)
        + BTN(`${SITE}/badge/${expert?.slug ?? ''}`, fr ? 'Obtenir mon badge →' : 'Get my badge →') + sig);
    }
    return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, false) };
  }

  // S6 — la seule offre payante. RÈGLE NAZAR : jamais dans son propre secteur.
  subject = fr ? `La tribune — la seule chose que Payotte facture` : `The column — the only thing Payotte charges for`;
  corps = CLOSE('#f8f0dc', '#e9d9ad',
    `${P(salut)}${H3(fr ? 'Depuis cinq semaines, rien ne vous a été facturé' : 'For five weeks, nothing has been billed to you')}`
    + P(fr ? `Votre fiche, votre score et votre rang ne sont pas à vendre — à personne. Le seul service que Payotte facture est la <b>tribune commanditée</b> : une chronique signée de votre nom, marquée comme commanditée, qui ne touche jamais au classement.`
           : `Your profile, your score and your rank are not for sale — to anyone. The only service Payotte charges for is the <b>sponsored column</b>: a piece signed by you, labelled as sponsored, which never touches the ranking.`)
    + P(fr ? `Et pour être clair : <b>pas dans votre secteur</b>, par construction. Vous y êtes déjà la référence classée ; vous y vendre une tribune reviendrait à vendre la place que vous occupez déjà. Les secteurs voisins de votre ville, eux, sont ouverts.`
           : `And to be clear: <b>not in your own sector</b>, by construction. You are already the ranked reference there; selling you a column there would mean selling the place you already hold. Neighbouring sectors in your city are open.`)
    + BTN(`${SITE}${fr ? '/tribunes' : '/en/sponsored-columns'}`, fr ? 'Le tarif, sans engagement →' : 'Pricing, no commitment →') + sig);
  return { subject, html: enveloppe(city, fr, eyebrow, corps, pied(pourquoi), macro, false) };
}

/** Enveloppe commune — même coquille que le pouls mensuel (logo, largeur, bordures). */
function enveloppe(city, fr, eyebrow, corps, pied, macro, avecMarche) {
  const tete = avecMarche && city ? marketCore(city, fr, eyebrow) : `<tr><td style="padding:26px 32px 22px 32px;border-bottom:1px solid #f1ecec;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle"><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td>
      <td align="right" valign="middle" style="font-size:11px;letter-spacing:.5px;color:#9a9294;line-height:1.5;">${eyebrow}</td>
    </tr></table></td></tr>`;
  const taux = avecMarche ? nationalBlock(macro, fr) : '';
  return `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${tete}${taux}${corps}${pied}</table></div>`;
}

let lastPulseAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Envoi par LOTS (Resend /emails/batch — jusqu'à 100 courriels en UN appel).
//
// PAS de copie BCC (elle noyait la boîte du proprio) : la trace, c'est le récapitulatif de
// fin d'exécution, plus l'échantillon du jour. Renvoie TOUJOURS l'issue réelle par
// courriel — l'appelant DOIT la lire : un envoi raté qui passerait pour réussi marquerait
// l'expert comme servi et le priverait de son courriel du mois.
//
// Pourquoi : un envoi = une sous-requête, et Cloudflare en autorise 50 par réveil du
// worker. À l'unité, l'architecture plafonnait donc à ~45 courriels par passage quoi
// qu'on fasse — un mur de tuyauterie, pas de forfait. Par lots de 100, mille envois ne
// coûtent que dix sous-requêtes : le plafond quotidien redevient une décision (forfait
// Resend + réputation du domaine), plus une contrainte technique.
//
// `headers` et `reply_to` sont acceptés par l'API batch (vérifié à la doc le 2026-08-10) :
// le List-Unsubscribe un clic — exigé par la LCAP et par Gmail — survit au passage en lot.
// Les pièces jointes, elles, n'y sont pas supportées : le bulletin n'en a jamais.
//
// Renvoie un tableau ALIGNÉ sur `envois` : `{ ok }` par courriel. Si l'appel entier échoue,
// rien n'est parti — tout le lot repart demain (on ne marque `sent:` que sur acceptation).
//
// ── EXPÉDITEUR PAR FLUX (2026-08-19) ───────────────────────────────────────────────
// `from` était figé sur MAIL_FROM_BULLETIN : TOUT partait de la même adresse — le
// bulletin opt-in de 2 132 abonnés, les prospects récoltés (non sollicités), et
// l'escalier expert. Un seul mauvais mardi de prospection abîmait donc la réputation
// du flux que des gens ont DEMANDÉ à recevoir, et celle du relais client↔pro qui est
// le produit.
// Trois expéditeurs, trois réputations :
//   bulletin@   abonnés du formulaire — ils ont dit oui
//   outreach@   prospects récoltés, escalier expert, séquence — non sollicité
//   relais@     mise en contact client↔pro (double opt-in) — inchangé, à ne jamais mêler
// La séparation ne rend pas une plainte inoffensive (le domaine organisationnel reste
// lié) : elle empêche qu'un flux en tue deux autres. C'est une mitigation, pas un mur.
async function sendPulseBatch(env, envois, { from: fromDemande } = {}) {
  if (!envois.length) return [];
  if (!env.RESEND_API_KEY) return envois.map(() => ({ ok: false, simulated: true }));
  const wait = RESEND_MIN_GAP_MS - (Date.now() - lastPulseAt);
  if (wait > 0) await sleep(wait);
  lastPulseAt = Date.now();
  const from = fromDemande || env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>';

  // ── QUARANTAINE DES ADRESSES INVALIDES (2026-08-13) ────────────────────────────────
  // Resend valide le lot ENTIER : une seule adresse malformée le fait répondre 422, et
  // TOUS les courriels du lot sont perdus. C'est arrivé le 12 août : la fiche
  // `appraiser--north-end-fairview` porte deux adresses dans un seul champ
  // (« Geoff.Coderre@gmail.com ; SjBest@Eastlink.ca » — même convention que son
  // téléphone). Elle a emporté 10 prospects parfaitement valides avec elle, et elle
  // échouait déjà seule chaque jour depuis le 7 août.
  // On écarte donc les adresses invalides AVANT l'appel : elles sont signalées une par
  // une dans le rapport (motif explicite, pas un « HTTP 422 » opaque) et le reste du lot
  // part normalement. Coût : zéro sous-requête.
  const valides = [], resultats = new Array(envois.length);
  envois.forEach((e, i) => {
    if (EMAIL_RE.test(String(e.to ?? '').trim())) valides.push({ e, i });
    else resultats[i] = { ok: false, status: 0, error: 'adresse invalide — écartée avant envoi' };
  });
  if (!valides.length) return resultats;

  let res, corps;
  try {
    res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(valides.map(({ e }) => ({
        from, to: [e.to], reply_to: REPLY_TO,
        subject: e.subject, html: e.html,
        // ── L'ÉTIQUETTE (2026-08-19) ───────────────────────────────────────────────
        // Sans elle, le webhook apprend qu'« un courriel a été ouvert » sans savoir
        // lequel. On ne pourrait donc rien conclure sur un flux précis — or toute la
        // question est « est-ce que l'alerte taux marche mieux que le reste ? ».
        // Resend impose des étiquettes en [A-Za-z0-9_-] : on assainit.
        tags: [{ name: 'flux', value: String(e.sousFlux ?? e.flux ?? e.segment ?? 'bulletin').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) }],
        ...(e.unsubUrl ? { headers: { 'List-Unsubscribe': `<${e.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
      }))),
    });
    corps = await res.json().catch(() => null);
  } catch (err) {
    valides.forEach(({ i }) => { resultats[i] = { ok: false, status: 0, error: String(err?.message ?? err) }; });
    return resultats;
  }
  if (!res.ok) {
    valides.forEach(({ i }) => { resultats[i] = { ok: false, status: res.status }; });
    return resultats;
  }
  // Réponse acceptée : `data[i]` correspond au courriel `i` de la requête. Une entrée
  // absente ou sans `id` = ce courriel-là n'a pas été pris ; il repassera demain. On ne
  // suppose JAMAIS le succès d'un envoi qu'on ne voit pas confirmé.
  // `data[k]` correspond au k-ième courriel ENVOYÉ (donc au k-ième valide), pas au k-ième
  // de `envois` : les indices divergent dès qu'une adresse a été mise en quarantaine.
  const data = Array.isArray(corps?.data) ? corps.data : [];
  valides.forEach(({ i }, k) => {
    resultats[i] = { ok: Boolean(data[k]?.id), status: res.status, id: data[k]?.id };
  });
  return resultats;
}

// Villes ACTIVES du bulletin = TOUTES celles dont on publie un prix de référence
// (décision proprio, 2 août 2026 : « le maximum de villes où j'ai des stats »). Aucun
// slug à tenir à jour : une ville entre dans le bulletin le jour où son prix entre dans
// cityMarket.json, et en sort si la donnée disparaît. Le courriel s'ouvre sur ce prix —
// sans lui, il n'y a rien à envoyer.
// 2026-08-21 : le prix MOYEN devient un repère de dernier recours. Les rapports
// mensuels d'AREA (5 villes albertaines) et l'infographie de la BDAR (Barrie) ne
// publient NI repère NI médiane — que des moyennes. Le portier les écartait donc
// alors que la donnée existait, officielle et mensuelle : 305 adresses récoltées
// restaient injoignables faute d'un champ. L'ordre reste repère > médiane > moyenne,
// et le gabarit ÉTIQUETTE le prix affiché pour ce qu'il est (voir refOf).
const hasMarketStats = (c) => (c?.benchmarkHpi ?? c?.medianPrice ?? c?.averagePrice) != null;



// Code province de market.json → slug du feed /api/experts/{slug}.json.
const PROV_SLUG = {
  QC: 'quebec', ON: 'ontario', AB: 'alberta', BC: 'british-columbia', MB: 'manitoba',
  NS: 'nova-scotia', SK: 'saskatchewan', NB: 'new-brunswick',
  NL: 'newfoundland-and-labrador', PE: 'prince-edward-island',
};

// Budget de sous-requêtes. Plan gratuit Cloudflare : 50 par invocation — la run du
// 1er août 2026 est morte PILE à 50 (13 feeds + 37 envois), laissant 17 experts sur le
// carreau sans le moindre signal. Désormais l'exécution COMPTE ses sous-requêtes et
// s'arrête d'elle-même ; ce qui n'est pas parti aujourd'hui part demain (cron quotidien).
// Les opérations KV n'entrent pas dans ce budget (vérifié sur la run du 1er août).
const SUBREQUEST_BUDGET = 50;
const SUBREQUEST_MARGIN = 3;   // récapitulatif de fin + coussin
// Budget d'opérations KV par invocation. Plafond Cloudflare : 1 000 opérations sur un
// service externe, Workers KV compris — un plafond DISTINCT des 50 sous-requêtes
// ci-dessus, et que rien ne surveillait avant le 14 septembre 2026. Au niveau module
// parce que `sendRunReport` l'affiche : déclaré dans `runBulletin`, il y était hors
// de portée et le récapitulatif aurait planté à l'envoi.
// ⚠ MARGE ÉLARGIE À 180 APRÈS LE PASSAGE DE 17 H LE 14 SEPT. 2026. Un budget de 900 n'a
// pas protégé : le compteur ignorait l'écriture `dom:` faite à chaque destinataire, donc il
// affichait ~800 quand le worker en avait réellement fait 1 000, et le garde-fou n'a jamais
// eu l'occasion de se déclencher. Les écritures sont désormais comptées ET groupées, mais
// une quinzaine d'opérations de service (témoins `run:`, lectures `stop:`/`plainte:`,
// `prov-done:`) restent hors compteur. La marge les couvre. NE PAS la réduire en la croyant
// inutile : un compteur qui sous-estime rend le garde-fou décoratif.
// Remonté de 820 à 880 le 14 sept. 2026 au soir : les écritures étant groupées, presque
// toutes les opérations restantes sont des LECTURES, et elles sont toutes comptées. La
// marge de 120 couvre les opérations de service encore hors compteur (témoins `run:`,
// lectures `stop:`/`plainte:`, `prov-done:`).
const KV_BUDGET = 880;
// Cohorte pré-opt-out, mémorisée en UNE clé. Voir le bloc qui la lit dans `runBulletin`.
const CLE_COHORTE = 'cohorte:pre-optout';
// Bascule vers l'opt-out : une clé `intro:` antérieure à cette date appartient à la cohorte
// de l'ANCIENNE présentation, celle qui promettait « aucune suite sans votre accord ».
const OPT_OUT_SWITCH = '2026-08-02';
// Taille d'un lot Resend (maximum de l'API). Depuis le passage aux lots (2026-08-10),
// un passage de 1 000 courriels ne coûte que 10 sous-requêtes : le budget Cloudflare
// n'est plus le facteur limitant, le forfait Resend et la réputation du domaine le sont.
const TAILLE_LOT = 100;
const RESEND_DAY_CAP = 6000;   // plafond dur. Le compte est passé au forfait Resend Pro le
                               // 2026-09-02 : 50 000/mois, AUCUNE limite journalière. Ce
                               // chiffre ne borne donc plus la FACTURE mais la RÉPUTATION —
                               // c'est le sommet de la rampe de septembre, pas un quota.
                               // 3 000 → 6 000 le 18 sept. 2026 (décision proprio). Il
                               // bridait `dailySendCap` (6 000 au palier du 18) sans que
                               // rien ne le dise : le plus petit des deux gagne, donc le
                               // palier du jour n'avait aucun effet. 6 000/jour × 22 jours
                               // ouvrables = 132 000, bien au-delà des 50 000 du forfait —
                               // ce n'est donc plus lui le garde-fou de la facture, c'est
                               // `OUTREACH_RAMPE` et les seuils plaintes/rebonds.
// Rythme choisi (décision proprio, 3 août 2026) : un petit filet tous les jours plutôt qu'une
// rafale, sans jamais approcher les limites de Resend, et le domaine (37 courriels dans sa
// vie au 1er août) monte en charge doucement — c'est ce qui décide si les prochains
// atterrissent en boîte ou en spam.
// 2026-08-08 (décision proprio) : 20 → 35. Les ~296 prospects de la récolte entrent dans le
// circuit (clés s:) et s'ajoutent aux ~455 experts — 20/jour ne bouclait plus le mois.
// 2026-08-09 (décision proprio, objectif 2 800 destinataires au 31 août) : montée en
// PALIERS DATÉS — 50 maintenant, 70 dès le 15 août, 90 dès le 22 (le max sous le palier
// gratuit Resend : 90 × 30 + ~210 rapports ≈ 2 910 < 3 000/mois). Les paliers hebdo sont
// le profil de montée en charge que les filtres anti-spam tolèrent ; un saut direct
// 20 → 90 sur un domaine jeune est le profil type qui finit en spam.
// Ramp accélérée le 2026-08-13 (décision proprio, objectif de fin de mois). Les paliers
// 70 et 90 avancent de deux et quatre jours ; le SOMMET NE BOUGE PAS.
// ⚠️ [HISTORIQUE — VRAI JUSQU'AU 2026-09-02, plus depuis : voir la rampe de septembre plus
// bas. Le compte est au forfait Pro, il n'y a plus de limite journalière.]
// ⚠️ 90 est un plafond, pas une timidité : le forfait gratuit Resend coupe à 100/jour, et
// les rapports d'exécution envoyés au proprio consomment le MÊME quota. Aller à 100 ferait
// refuser les derniers courriels du jour sans qu'on sache lesquels.
// L'arithmétique du 13 août : même à 90/jour jusqu'au 31, août plafonne autour de 2 090
// envois — or l'audience disponible n'est que d'environ 2 080 personnes (1 512 prospects
// + ~568 experts, un seul courriel par personne et par cycle). Cette ramp épuise donc
// à peu près tout le carnet. Le chiffre de 3 000 n'est PAS atteignable en août : il
// demanderait 137/jour (au-dessus du gratuit) ET un carnet d'adresses qui n'existe pas.
// ── RAMPE DE SEPTEMBRE (décision proprio, 2026-09-02) ────────────────────────────
// Le forfait Pro lève la limite journalière ; ce qui commande désormais est la RÉPUTATION
// du domaine, et elle ne s'achète pas. Les paliers d'août plafonnaient à 90 sous l'ancien
// palier gratuit de 100/jour — cette contrainte n'existe plus.
//
// Objectif : écouler les ~12 900 adresses en KV sans déclencher les filtres. Chaque palier
// DOUBLE au plus, tous les 3-4 jours ; c'est le profil que les filtres anti-spam tolèrent,
// et c'est la même doctrine qu'en août (« un saut direct est le profil type qui finit en
// spam »), simplement à une autre échelle. Total prévu sur septembre : ~30 000 envois,
// sous les 50 000 du forfait.
//
// ⚠️ CE N'EST PAS UN ENGAGEMENT DE DÉBIT. Les seuils de `runBulletin` posent `stop:outreach`
// tout seuls si les plaintes passent 0,3 % (ou 3 en 24 h) ou les rebonds durs 4 %. Un
// palier qui déclenche l'arrêt N'EST PAS à forcer : c'est le domaine qui dit non, et il a
// raison. Reprendre au palier précédent, pas au suivant.
// ── PAS D'ENVOI LA FIN DE SEMAINE (décision proprio, 2026-09-02) ─────────────────
// Les destinataires sont des professionnels : un courriel reçu le samedi est lu le lundi
// dans une pile, ou pas du tout. Le cron tourne pourtant TOUS les jours (crons =
// "0 12-18 * * *") — sans cette règle, la rampe aurait envoyé samedi et dimanche sans que
// personne l'ait décidé. Ce qui ne part pas la fin de semaine n'est pas perdu : la file
// reste, le lundi la reprend.
// ⚠️ Effet de bord assumé : la banque remonte de deux nuits de récolte (~2 000 adresses)
// pendant la pause, ce qui charge le lundi. C'est prévu dans le plan.
const FIN_DE_SEMAINE = (at) => { const j = at.getUTCDay(); return j === 0 || j === 6; };

// ── RAMPE DE SEPTEMBRE (décision proprio, 2026-09-02, révisée le même jour) ───────
// Le forfait Pro lève la limite journalière ; ce qui commande désormais est la RÉPUTATION
// du domaine. Les paliers d'août plafonnaient à 90 sous l'ancien palier gratuit de
// 100/jour — cette contrainte n'existe plus.
//
// Objectif : écouler les ~12 900 adresses en KV en deux semaines, du lundi 7 au vendredi 18.
// Projeté avec la récolte qui continue de verser ~1 027 adresses par nuit : la banque
// MONTE jusqu'au 14 (la rampe envoie moins que la récolte ne verse), bascule le 15, et
// tombe à zéro le 18 avec une balance de ~3 963 — sous le palier du jour. Total ~25 200
// envois sur le mois, la moitié du forfait.
//
// Chaque palier double au plus, SAUF 4 000 → 6 000 le 16 (×1,5 après seulement 24 h de
// recul sur le 4 000). C'est le seul saut qui sorte de la doctrine d'août ; il a été
// accepté en connaissance de cause.
//
// ⚠️ CE N'EST PAS UN ENGAGEMENT DE DÉBIT. Les seuils de `runBulletin` posent `stop:outreach`
// tout seuls si les plaintes passent 0,3 % (ou 3 en 24 h) ou les rebonds durs 4 %. Un
// palier qui déclenche l'arrêt N'EST PAS à forcer : c'est le domaine qui dit non, et il a
// raison. Reprendre au palier précédent, pas au suivant. À regarder en particulier le
// 15 au matin, AVANT de laisser partir les 6 000 du 16.
//
// ✅ REPRISE LE 8 SEPTEMBRE 2026. La pause du 2 septembre est levée ; voir le bloc de
// commentaire dans `dailySendCap` pour ce qui a changé et justifiait de rouvrir.
//
// LES PALIERS ONT ÉTÉ REDATÉS de deux jours le 8 septembre : la rampe partait du 7, et
// rien n'était parti ce jour-là. C'est exactement l'avertissement que portait l'ancienne
// note (« vérifier que la première date est encore dans le futur, sinon la montée en
// charge saute »). Il s'est réalisé, il a été corrigé, et il se réalisera encore au
// prochain report — ces dates sont ABSOLUES, tout comme celles d'OUTREACH_RAMPE dans
// wrangler.toml, et LES DEUX doivent être redatées ensemble.
//
// POUR REFERMER : remettre `return 0;` en première ligne de `dailySendCap`. Les paliers
// restent alors intacts, inertes et lisibles — c'est le point du court-circuit, et il a
// prouvé sa valeur : six jours de pause n'ont rien coûté du calibrage.
const dailySendCap = (at = new Date()) => {
  /* ⛔ LA PAUSE DU 2 SEPTEMBRE A ÉTÉ LEVÉE LE 8 SEPTEMBRE 2026, sur décision explicite
     du propriétaire. Elle avait été posée parce que « l'angle ne fonctionne pas ».
     Ce qui a changé entre les deux dates, et qui justifiait de rouvrir :
       · les courriels portaient DEUX affirmations fausses — « c'est elle que les IA
         citent » (mesure : 12 citations sur 6 fiches, pas 573) et « répondez à ce
         courriel » alors que le domaine n'avait AUCUN MX. Les deux sont corrigées ;
       · la réception fonctionne enfin (MX ImprovMX, chaîne vérifiée en 4 secondes) —
         il se peut que le « aucune réponse de ces 550 » de juillet ait été ce trou-là ;
       · trois demandes distinctes remplacent le CTA unique côté experts, et deux
         contenus prospects distinguent ville servie et ville vierge.
     POUR REFERMER : remettre `return 0;` en première ligne. Rien d'autre. Les paliers
     ci-dessous restent calibrés et n'ont pas besoin d'être touchés. */
  if (FIN_DE_SEMAINE(at)) return 0;
  const d = at.toISOString().slice(0, 10);
  /* ⚠ RAMPE REDATÉE LE 8 SEPT. 2026 — elle repart de 250 le mercredi 9.
     L'ancienne était calibrée pour un départ le 7 septembre. La pause du 2 septembre
     l'a laissée courir dans le vide : au 8 septembre elle était déjà rendue à 500, et
     au 18 elle serait passée à 100 000 D'UN COUP. Reprendre à ce moment-là aurait
     sauté toute la montée en charge et brûlé la réputation du domaine — le pire
     moment pour une liste bâtie au consentement tacite.
     La FORME est conservée telle qu'elle avait été calibrée (au plus un doublement
     par palier, les fins de semaine à zéro par FIN_DE_SEMAINE) ; seules les dates
     bougent, de deux jours, ce qui reporte la balance au mardi 22.
     ⚠ ET LE PROBLÈME VA REVENIR : ces dates sont ABSOLUES. Si l'envoi ne reprend pas
     le 9, il faudra les redater encore. Le jour où ça se reproduit une troisième
     fois, remplacer ces bornes par un décalage en jours ouvrables depuis une seule
     constante de départ — c'est le vrai correctif, il n'a pas été fait aujourd'hui. */
  if (d >= '2026-09-22') return 100000;  // la balance : ce qui reste part
  if (d >= '2026-09-18') return 6000;
  if (d >= '2026-09-17') return 4000;
  if (d >= '2026-09-16') return 2000;
  if (d >= '2026-09-14') return 1000;
  if (d >= '2026-09-11') return 750;
  if (d >= '2026-09-10') return 500;
  if (d >= '2026-09-09') return 250;     // première vague du forfait Pro
  if (d >= '2026-08-18') return 90;
  if (d >= '2026-08-13') return 70;
  return 50;
};
// Durée de vie des marques de cycle (`sent:`, `prov-done:`) : ~100 jours. Elles ne servent
// qu'au mois courant et se nettoient toutes seules. `intro:` et `unsub:`, eux, sont éternels.
const CYCLE_TTL = 100 * 24 * 3600;

// Toutes les clés d'un préfixe (KV plafonne à 1000 par page ; l'annuaire les dépassera).
async function kvKeys(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await kv.list({ prefix, cursor });
    for (const k of r.keys) out.push(k.name.slice(prefix.length));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

const expertUnsubUrl = async (env, origin, slug) =>
  `${origin}/unsubscribe?x=${encodeURIComponent(slug)}&t=${await hmacHex(env, `x:${slug}`)}`;

// ---- 10 h CHEZ LE DESTINATAIRE (décision proprio, 5 août 2026) ----------------------
// Une heure UTC unique envoyait à 9 h HE… donc 6 h du matin sur la côte Ouest : un courriel
// professionnel qui arrive avant le lever se lit à la va-vite ou pas du tout. Le cron tourne
// désormais À CHAQUE HEURE de la fenêtre 12-18 h UTC, et chaque exécution ne sert QUE les
// provinces où il est 10 h passé. Personne d'autre n'est touché ce tour-là.
//
// Fuseaux IANA, pas de décalages en dur : l'heure avancée s'applique toute seule, et la
// Saskatchewan (America/Regina, qui ne la suit JAMAIS) se règle sans cas particulier.
const PROV_TZ = {
  QC: 'America/Toronto',   ON: 'America/Toronto',    MB: 'America/Winnipeg',
  SK: 'America/Regina',    AB: 'America/Edmonton',   BC: 'America/Vancouver',
  NS: 'America/Halifax',   NB: 'America/Moncton',    PE: 'America/Halifax',
  NL: 'America/St_Johns',
};
/* ── LES HEURES LOCALES D'ENVOI (22 sept. 2026, décision du propriétaire) ─────────
   C'ÉTAIT UNE HEURE, C'EST MAINTENANT TROIS. `SEND_LOCAL_HOUR = 10` traitait 10 h
   comme une règle ; c'était une prudence, pas une obligation. 11 h et 14 h locales sont
   des heures ouvrables aussi banales que 10 h, et chacune ajoute un passage par fuseau.

   ⚠ CE QUI EST PROTÉGÉ RESTE PROTÉGÉ, et c'est tout l'intérêt de garder un filtre par
   HEURE LOCALE plutôt que par heure UTC : quelle que soit la province, personne n'est
   servi avant 10 h ni après 15 h chez lui. Ne JAMAIS y mettre une heure hors de cette
   plage — c'est la seule chose qui empêche d'écrire à quelqu'un à 6 h du matin, et
   c'est l'accident que tout ce mécanisme existe pour éviter.

   ⚠ ET C'EST UN LEVIER DE DÉBIT, PAS DE CONFORT. Le frein réel est le budget KV d'UNE
   invocation (880 opérations, plafond Cloudflare à 1 000) : mesuré aujourd'hui, ça donne
   ~135 destinataires par passage. Trois heures locales au lieu d'une, c'est trois fois
   plus de passages qui ont du travail — pas un passage plus gros. */
const HEURES_LOCALES_ENVOI = new Set([10, 11, 14]);
/* Conservé pour les quelques lectures qui veulent « l'heure de référence ». */
const SEND_LOCAL_HOUR = 10;
// Dernière heure UTC où le cron tourne — doit rester en phase avec `crons` de wrangler.toml
// ("0,30 12-21 * * *"). Sert à savoir combien de passages restent dans la journée pour
// partager le plafond quotidien entre les fuseaux (voir « part équitable » dans runBulletin).
// ⚠ PORTÉE DE 18 À 21 LE 22 SEPT. : sans ça, 14 h locale en Colombie-Britannique (21 h UTC)
// n'aurait jamais de passage. Toute modification des `crons` doit se refléter ICI, sinon le
// partage du plafond compte des passages qui n'existent pas — ou en oublie qui existent.
const CRON_DERNIERE_HEURE_UTC = 21;
/* ⚠ PASSAGES AUX 10 MINUTES (29 sept. 2026). Un SECOND déclencheur
   ("10,20,40,50 18-19 * * *") a été déployé à 17 h 46 UTC. Cloudflare l'affichait
   dans les schedules du script, mais ne l'a JAMAIS invoqué : l'analytique
   `workersInvocationsScheduled` n'a montré que 18 h 00 et 18 h 30. Il n'y a donc plus
   qu'UN déclencheur, toutes les 10 minutes de 12 h à 21 h UTC, et c'est le code qui choisit les minutes :
   :00 et :30 toute la journée, les 10 minutes seulement aux heures de ce jeu. */
const CRON_HEURES_10_MIN_UTC = new Set([18, 19]);
/* Réglage DATÉ (30 sept. 2026, demande de Grégory) : `DIX_MIN_DU_JOUR = "AAAA-MM-JJ:17,18,19"`
   remplace le jeu ci-dessus pour ce jour-là seulement ; le lendemain, il est inerte. */
const heuresDixMin = (at, env) => {
  const brut = String(env?.DIX_MIN_DU_JOUR || '');
  if (brut.slice(0, 10) !== at.toISOString().slice(0, 10) || brut[10] !== ':') return CRON_HEURES_10_MIN_UTC;
  return new Set(brut.slice(11).split(',').map((x) => Number(x.trim())).filter(Number.isFinite));
};
const creneauCron = (at, env) => {
  const pas = heuresDixMin(at, env).has(at.getUTCHours()) ? 10 : 30;
  return Math.floor(at.getUTCMinutes() / pas) * pas;
};
const passageCronActif = (at, env) =>
  at.getUTCMinutes() % 30 < 10 || heuresDixMin(at, env).has(at.getUTCHours());

const localHour = (tz, at) =>
  Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', hour12: false }).format(at));

// Provinces dont l'heure locale est dans la tranche des 10 h. On teste l'HEURE, pas la minute :
// la tranche dure 60 minutes, ce qui garantit qu'un cron horaire tombe toujours dedans — y
// compris à Terre-Neuve, dont le décalage d'une demi-heure ferait rater un test à la minute
// près (10 h 00 à St. John's = 12 h 30 UTC, une heure qui n'existe pas au calendrier du cron ;
// c'est le passage de 13 h UTC, soit 10 h 30 locale, qui la sert).
/* ── PASSAGES DE RENFORT (18 sept. 2026) ──────────────────────────────────────────
   LE FREIN N'EST PAS UN PLAFOND, C'EST LE BUDGET KV D'UNE INVOCATION. Mesuré le
   18 septembre : `KV_BUDGET` vaut 880 opérations, la boucle des prospects paie UNE
   lecture par candidat EXAMINÉ (`kvLot` sur la tranche de 40), le démarrage en mange
   ~80 et la réserve experts en gèle 120. Un passage ne peut donc regarder qu'environ
   680 candidats, quoi qu'on écrive dans `RESEND_DAY_CAP` ou `OUTREACH_RAMPE`. Ce
   jour-là : 4 800 autorisés, 703 partis — et le passage de 14 h UTC, qui porte le
   Québec et l'Ontario (5 534 personnes en attente, 70 % du carnet restant), en a sorti
   189.

   La règle des 10 h locales ne donne qu'UN passage par province et par jour. Or le cron
   tourne de 12 à 18 h UTC : les heures 12 et 18 ne servent PERSONNE (aucune province
   n'est à 10 h locale) et repartent avec leur budget de 880 intact. C'est de la capacité
   déjà payée qui dort.

   Ce réglage rouvre ces heures-là pour des provinces nommées. Ce n'est PAS le forçage de
   `PROVINCES_DU_JOUR` : celui-ci est daté et remplace le filtre pour toute la journée ;
   celui-là est permanent, s'AJOUTE aux provinces déjà à 10 h, et ne vaut que pour les
   heures qu'on lui donne.

   ⚠ L'HEURE LOCALE RESTE LA SEULE CHOSE QUI COMPTE. 18 h UTC = 14 h à Montréal et
   Toronto, en plein milieu de l'après-midi ouvrable : c'est l'esprit de la règle des
   10 h, pas une entorse. 12 h UTC = 8 h de l'Est, tôt mais ouvrable — et 7 h une fois
   l'heure d'hiver revenue, ce qui ne l'est plus. NE PAS y mettre une province de
   l'Ouest : 12 h UTC = 5 h du matin en Colombie-Britannique.

   Format : « HH:PROV,PROV;HH:PROV » en heures UTC. Vide = personne, comportement d'avant. */
function renfortA(heureUTC, env, at = new Date()) {
  /* Réglage DATÉ (30 sept. 2026) : `RENFORT_DU_JOUR = "AAAA-MM-JJ|HH:PROV,PROV;HH:PROV"`
     REMPLACE `HEURES_RENFORT` pour ce jour-là seulement ; le lendemain, il est inerte. */
  const jour = String(env?.RENFORT_DU_JOUR || '');
  const brut = jour.slice(0, 10) === at.toISOString().slice(0, 10) && jour[10] === '|'
    ? jour.slice(11) : String(env?.HEURES_RENFORT || '');
  const out = new Set();
  for (const bloc of brut.split(';').map((x) => x.trim()).filter(Boolean)) {
    const [h, provs] = bloc.split(':');
    if (Number(h) !== Number(heureUTC) || !provs) continue;
    for (const p of provs.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)) out.add(p);
  }
  return out;
}

function zonesAt10h(at = new Date()) {
  return new Set(Object.entries(PROV_TZ)
    .filter(([, tz]) => HEURES_LOCALES_ENVOI.has(localHour(tz, at)))
    .map(([code]) => code));
}

// Orchestration du CYCLE MENSUEL, étalée sur autant de jours qu'il faut.
//
// Le cron tourne CHAQUE HEURE de 12 à 18 h UTC mais l'unité de compte reste le mois : un
// destinataire servi porte la clé `sent:{AAAA-MM}:{slug}` et n'est plus rappelé avant le mois
// suivant. Chaque exécution ne regarde QUE les provinces où il est 10 h locale, repart de la
// liste des « pas encore servis ce mois-ci », en envoie autant que le budget le permet, et
// s'arrête. Quand tout le monde a reçu, les exécutions suivantes du mois ne font plus rien
// (3 lectures KV, 1 feed) jusqu'au 1er. C'est ce qui remplace le « tout d'un coup » impossible
// sur le plan gratuit : ~490 courriels passent en une douzaine de jours, sans jamais dépasser
// ni Cloudflare, ni Resend, ni la prudence élémentaire pour la réputation du domaine.
//
// Le plafond quotidien est GLOBAL, pas par exécution : sept passages par jour × 20 auraient
// fait 140 courriels et pulvérisé la montée en charge du domaine. Le compte du jour vit en KV.
//
// OPT-OUT : plus de `sub:` à poser à la main. Seule une clé `unsub:{slug}` exclut quelqu'un.
// dryRun=true → aucun envoi, rapport d'audience seulement (et TOUS les fuseaux, sinon le
// rapport ne montrerait que la tranche horaire du moment).
/* ── REPRISE DES MARQUES PERDUES — UN PAS (29-30 sept. 2026) ─────────────────────────
   Voir le commentaire dans `runBulletin`. Sortie de `runBulletin` le 30 sept. pour que
   les créneaux de 10 min HORS des heures actives (qui repartent sans rien envoyer)
   fassent avancer la lecture : à :00/:30 seulement, elle aurait pris 5 h 30 au lieu de
   1 h 30. Un pas = ~12 s de lecture de `GET /emails` (≈ 20 pages), état en KV.
   La clé d'envoi (`RESEND_API_KEY`) est « Sending access » : Resend répond 401 à la
   lecture, d'où la clé « Full access » à part, `RESEND_LECTURE_KEY`. */
async function pasRepriseResend(env, cycle, { maxSubs = 40, dureeMs = 12000, pauseMs = 520 } = {}) {
  const cleLecture = env.RESEND_LECTURE_KEY || env.RESEND_API_KEY;
  if (!env.SUBSCRIBERS || !cleLecture) return { actif: false };
  const CLE_REPRISE = `reprise-resend:${cycle}`;
  let kvUtilisees = 1, subsUtilisees = 0;
  let etat = null;
  try { etat = JSON.parse((await env.SUBSCRIBERS.get(CLE_REPRISE)) || 'null'); } catch { etat = null; }
  etat = etat || { apres: null, emails: [], pages: 0, fini: false };
  if (!etat.fini) {
    delete etat.erreur;          // on retente à chaque pas : une clé corrigée doit suffire
    const vus = new Set(etat.emails);
    const debutCycle = `${cycle}-01`;
    const t0 = Date.now();
    let finLecture = false;
    // ~2 appels/s chez Resend, et le passage doit rester loin des 30 s.
    while (!finLecture && Date.now() - t0 < dureeMs && subsUtilisees < maxSubs) {
      const q = new URLSearchParams({ limit: '100' });
      if (etat.apres) q.set('after', etat.apres);
      subsUtilisees++;
      const r = await fetch(`https://api.resend.com/emails?${q}`, {
        headers: { Authorization: `Bearer ${cleLecture}` },
      });
      if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1100)); continue; }
      if (!r.ok) { etat.erreur = `Resend GET /emails HTTP ${r.status}`; break; }
      const j = await r.json();
      const lignes = Array.isArray(j?.data) ? j.data : [];
      for (const m of lignes) {
        if (String(m.created_at || '').slice(0, 10) < debutCycle) { finLecture = true; continue; }
        for (const to of [].concat(m.to || [])) vus.add(String(to).trim().toLowerCase());
      }
      etat.pages++;
      if (lignes.length) etat.apres = lignes[lignes.length - 1].id;
      if (!j?.has_more || !lignes.length) finLecture = true;
      await new Promise((ok) => setTimeout(ok, pauseMs));
    }
    etat.emails = [...vus];
    if (finLecture && !etat.erreur) {
      const carnet = await kvKeys(env.SUBSCRIBERS, 's:');
      kvUtilisees += Math.max(1, Math.ceil(carnet.length / 1000));
      const ids = carnet.filter((k) => vus.has(k.slice(k.lastIndexOf(':') + 1).toLowerCase()))
        .map((k) => `prospect:${k}`);
      kvUtilisees++;
      await env.SUBSCRIBERS.put(`servi:${cycle}:reprise-resend`, JSON.stringify(ids), { expirationTtl: CYCLE_TTL });
      etat.fini = true;
      etat.marques = ids.length;
    }
    etat.maj = new Date().toISOString();
    kvUtilisees++;
    await env.SUBSCRIBERS.put(CLE_REPRISE, JSON.stringify(etat), { expirationTtl: CYCLE_TTL });
  }
  return { ...etat, actif: true, kvUtilisees, subsUtilisees };
}

async function runBulletin(env, { dryRun = false, at = new Date() } = {}) {
  const origin = WORKER_ORIGIN;
  const cycle = at.toISOString().slice(0, 7);      // AAAA-MM
  const dayKey = at.toISOString().slice(0, 10);    // AAAA-MM-JJ (jour comptable = UTC)
  // Compteur de sous-requêtes de CETTE exécution (feeds + appels Resend). Les opérations KV
  // n'y entrent pas. `left()` est ce qui reste de disponible.
  const ctr = { subs: 0, kv: 0 };
  const F = async (path) => { ctr.subs++; return feed(path); };
  const left = () => SUBREQUEST_BUDGET - SUBREQUEST_MARGIN - ctr.subs;
  /* ── BUDGET D'OPÉRATIONS KV (2026-09-14) ───────────────────────────────────────────
     DEUXIÈME plafond Cloudflare, distinct des sous-requêtes et jamais compté nulle part :
     un Worker ne peut faire que 1 000 opérations sur un service externe — Workers KV
     compris — par invocation. Le commentaire de `SUBREQUEST_BUDGET` dit vrai (« les
     opérations KV n'entrent pas dans ce budget ») et c'est exactement ce qui a trompé :
     elles n'entrent pas dans CELUI-LÀ, elles ont le LEUR, et rien ne le surveillait.
     C'est lui qui a tué les passages du 14 septembre à 22,8 s — sous la limite des 30 s,
     donc invisible à l'analyse qui avait servi le 9. Voir la boucle des prospects. */
  const kvLeft = () => KV_BUDGET - ctr.kv;
  const kvLot = async (cles) => {   // lectures EN PARALLÈLE, et comptées
    ctr.kv += cles.length;
    return Promise.all(cles.map((c) => env.SUBSCRIBERS.get(c)));
  };
  const kvListe = async (prefixe) => {   // un `list()` rend 1 000 clés par opération
    const r = await kvKeys(env.SUBSCRIBERS, prefixe);
    ctr.kv += Math.max(1, Math.ceil(r.length / 1000));
    return r;
  };
  // Ce que les exécutions PRÉCÉDENTES du jour ont déjà consommé (les 7 passages horaires se
  // partagent un seul plafond quotidien).
  const daySoFar = Number((env.SUBSCRIBERS ? await env.SUBSCRIBERS.get(`day:${dayKey}`) : 0) || 0);
  // `PLAFOND_DU_JOUR = "AAAA-MM-JJ:8000"` : remplace RESEND_DAY_CAP pour ce jour-là seulement,
  // inerte le lendemain (30 sept. 2026, Grégory : finir le cycle de septembre dans la journée).
  const plafondJour = String(env.PLAFOND_DU_JOUR || '');
  const capResend = plafondJour.slice(0, 10) === dayKey && plafondJour[10] === ':'
    ? Number(plafondJour.slice(11)) : RESEND_DAY_CAP;
  let dayCap = Math.min(dailySendCap(at), capResend);

  // ── COUPE-CIRCUIT ET SEUILS (2026-08-19) ─────────────────────────────────────────
  // Deux mécanismes, et ils ne se confondent pas :
  //
  //   `stop:all`      arrêt MANUEL de tout. Posé à la main quand quelque chose cloche
  //                   (`wrangler kv key put --remote stop:all 1`). Aucune automatisation
  //                   ne l'écrit : c'est la main sur le disjoncteur, elle reste humaine.
  //   `stop:outreach` arrêt de la PROSPECTION seule. Peut être posé automatiquement par
  //                   les seuils ci-dessous. Le bulletin opt-in continue.
  //
  // Les seuils lisent les compteurs du webhook (/resend-webhook). Ils regardent les
  // 24 h écoulées, pas un cumul depuis toujours : une mauvaise journée doit se voir tout
  // de suite, et une bonne semaine ne doit pas la masquer.
  // Ce que la journée a DÉJÀ envoyé en prospection, tous passages horaires confondus —
  // la rampe est un plafond quotidien, pas un plafond par passage.
  // Adresse postale LCAP : lue une fois, criée si absente (voir `adressePostale`).
  const postale = adressePostale(env);
  /* ── INTERRUPTEUR DU BULLETIN PROVINCIAL (23 sept. 2026) — FERMÉ PAR DÉFAUT ─────────
     Absent, ou toute valeur autre que "1" : les clés `s:prov-*` sont sautées comme avant,
     au caractère près. Ouvert : elles entrent dans la boucle des prospects, par le MÊME
     chemin (gardes, rampe, plafonds, marques `servi:`, désabonnement, adresse LCAP).
     ⚠ POURQUOI FERMÉ : le compte est au palier GRATUIT de Workers KV (1 000 écritures par
     jour, ~910 déjà consommées en moyenne en septembre). 5 423 destinataires de plus,
     c'est plus de clics, de rebonds et de désabonnements — donc d'écritures du webhook et
     de `/unsubscribe` — et un quota crevé fait ÉCHOUER les désabonnements (LCAP art. 11).
     Ouvrir SEULEMENT après le passage au palier payant :
        wrangler.toml [vars] → PROVINCIAL_ACTIF = "1"   puis   npx wrangler deploy */
  const provincialActif = env.PROVINCIAL_ACTIF === '1';
  if (!postale && !dryRun) {
    console.log('[bulletin] ⚠️ ADRESSE POSTALE MANQUANTE — exigée par la LCAP (Règlement art. 2(2)). '
      + 'Poser ADRESSE_POSTALE dans wrangler.toml. Les envois continuent, la mention légale est incomplète.');
  }
  const dejaOutreach = Number((await env.SUBSCRIBERS?.get(`day:${dayKey}:outreach`)) || 0);
  const stopTout = env.SUBSCRIBERS ? await env.SUBSCRIBERS.get('stop:all') : null;
  if (stopTout && !dryRun) {
    console.log(`[bulletin] ARRÊT MANUEL (stop:all = ${stopTout}) — aucun envoi.`);
    return { arrete: 'stop:all', motif: String(stopTout) };
  }
  const hier = new Date(at.getTime() - 86400000).toISOString().slice(0, 10);
  /* ⚠ ON COMPTE DES CLÉS, ON NE LIT PLUS DE COMPTEUR (2026-09-16). Voir la note du
     webhook : les compteurs agrégés perdaient des incréments sous rafale — un sur trois
     le 14 septembre — et ce sont ces chiffres-là qui décident d'arrêter le programme.
     `list()` sur `rebondj:{jour}:` rend une clé par adresse touchée ce jour-là : pas de
     course possible, et le nombre est exact par construction.
     Le coût est compté dans le budget KV comme le reste (`kvListe` incrémente `ctr.kv`),
     et il est d'une opération par jour regardé tant qu'on reste sous 1 000 rebonds. */
  const somme = async (prefixe) => (await kvListe(`${prefixe}:${dayKey}:`)).length
                                 + (await kvListe(`${prefixe}:${hier}:`)).length;
  const envoyes24 = Number((await env.SUBSCRIBERS?.get(`day:${dayKey}:outreach`)) || 0)
                  + Number((await env.SUBSCRIBERS?.get(`day:${hier}:outreach`)) || 0);
  const plaintes = env.SUBSCRIBERS ? await somme('plaintej') : 0;
  const rebonds = env.SUBSCRIBERS ? await somme('rebondj') : 0;
  /* ── DEUX PLANCHERS, PAS UN (2026-09-14) ─────────────────────────────────────────
     Le plancher unique de 200 a arrêté tout le programme le 11 septembre sur UNE seule
     plainte : 1 sur 321 = 0,311 %, juste au-dessus des 0,300 %. Le commentaire d'origine
     avait le bon raisonnement et le mauvais chiffre — il protégeait contre « une plainte
     à 0,5 % » sans voir que la zone 200-333 laisse exactement le même accident arriver.

     LE PLANCHER SE DÉDUIT DU SEUIL, il ne se choisit pas. Pour que le pourcentage ne soit
     jamais plus nerveux que le garde-fou absolu de 3 plaintes, il faut que les deux
     coïncident à la frontière :  3 ÷ 0,003 = 1 000.
       · sous 1 000 envois sur 24 h → seul `plaintes >= 3` décide ;
       · à partir de 1 000        → 0,3 % exige DÉJÀ 3 plaintes ou plus.
     Aucune discontinuité, et la détection n'est jamais plus faible qu'avant : 3 plaintes
     arrêtent tout, à n'importe quel volume. 400 aurait encore déclenché sur 2 plaintes
     entre 400 et 666 envois — plus strict que le garde-fou absolu, donc le même piège.

     LES REBONDS GARDENT 200, et c'est délibéré. Leur seuil est 4 %, pas 0,3 % : un rebond
     isolé pèse 0,5 % à 200 envois, très loin de déclencher. Monter ce plancher-là à 1 000
     aurait aveuglé le seul garde-fou qui voit une liste pourrie — il n'existe AUCUN
     compte brut de secours pour les rebonds, contrairement aux plaintes. */
  /* SEUILS DU 2 OCT. 2026 (décision de Grégory) : Resend tolère 4 % de rebonds et 0,08 % de
     plaintes ; on s'arrête AVANT, à 3 % et 0,05 %. Le plancher des plaintes se recalcule
     selon la règle ci-dessus : 3 ÷ 0,0005 = 6 000 envois sur 24 h. */
  const SEUIL_PLAINTES = 0.0005;
  const SEUIL_REBONDS = 0.035; // 3 % → 3,5 % le 5 oct. 2026 (Grégory), sous les 4 % de Resend
  const PLANCHER_PLAINTES = Math.round(3 / SEUIL_PLAINTES);   // 6 000
  const PLANCHER_REBONDS = 200;     // seuil à 3 % : un plancher bas ne produit pas de faux positif
  const tauxP = envoyes24 >= PLANCHER_PLAINTES ? plaintes / envoyes24 : 0;
  const tauxR = envoyes24 >= PLANCHER_REBONDS ? rebonds / envoyes24 : 0;
  let stopOutreach = env.SUBSCRIBERS ? await env.SUBSCRIBERS.get('stop:outreach') : null;
  /* ⚠ LE COMPTE BRUT DE 3 PLAINTES EST UN FILET DE PETIT VOLUME, PAS UNE RÈGLE GÉNÉRALE.
     Sans la borne `envoyes24 < PLANCHER_PLAINTES`, il domine tout le reste pour toujours :
     à 6 000 envois sur 24 h — le régime de la fin septembre — 3 plaintes valent 0,05 %,
     un taux EXCELLENT, et le programme s'arrêterait quand même. On aurait remplacé
     l'accident du 11 septembre par le même accident un cran plus haut dans la rampe.
     Il ne sert donc que là où le pourcentage ne peut rien dire : sous le plancher. */
  if (!stopOutreach && !dryRun && (tauxP >= SEUIL_PLAINTES
                                   || (envoyes24 < PLANCHER_PLAINTES && plaintes >= 3)
                                   || tauxR >= SEUIL_REBONDS)) {
    const motif = plaintes >= 3 && tauxP < SEUIL_PLAINTES
      ? `${plaintes} plaintes en 24 h`
      : tauxR >= SEUIL_REBONDS ? `rebonds durs ${(tauxR * 100).toFixed(1)} %`
        : `plaintes ${(tauxP * 100).toFixed(2)} %`;
    await env.SUBSCRIBERS?.put('stop:outreach', `auto ${dayKey} — ${motif}`);
    stopOutreach = `auto ${dayKey} — ${motif}`;
    console.log(`[bulletin] ARRÊT AUTOMATIQUE de la prospection : ${motif}`);
  } else if (!stopOutreach && (tauxP >= SEUIL_PLAINTES * 0.6 || tauxR >= SEUIL_REBONDS * 0.66)) {   // alerte : 0,03 % / 2 %
    // Palier d'alerte : on ralentit de moitié au lieu d'arrêter. Le but est de laisser le
    // temps de regarder, pas de tout figer sur un frisson.
    dayCap = Math.max(1, Math.floor(dayCap / 2));
    console.log(`[bulletin] ralenti ×0,5 — plaintes ${plaintes}, rebonds ${rebonds} sur ${envoyes24} envois`);
  }

  // ── PART ÉQUITABLE DU PLAFOND QUOTIDIEN (2026-08-17) ──────────────────────────────
  // LE FUSEAU LE PLUS À L'OUEST MOURAIT DE FAIM. Le plafond du jour est GLOBAL et les
  // fuseaux passent l'un après l'autre — Atlantique 13 h UTC, Est 14 h, Centre 15 h,
  // Prairies/Montagnes 16 h, Pacifique 17 h. Servis dans cet ordre sur une réserve
  // commune, les premiers la vidaient avant que les derniers n'aient leur tour.
  //
  // Mesuré le 2026-08-17 sur le cycle en cours, et la pente ne laisse aucun doute :
  //   QC 198/874 · ON 83/415 (14 h UTC)   → servis
  //   SK 11/201 · AB 31/75  (16 h UTC)   → à peine entamés
  //   BC 0/333              (17 h UTC)   → PAS UN SEUL COURRIEL DE TOUT LE MOIS
  // Plus un fuseau est à l'ouest, plus il est affamé. Ce n'était pas un bug visible :
  // le worker n'a jamais rien signalé, et sans le tableau par province du récapitulatif
  // personne ne l'aurait vu.
  //
  // LA RÉSERVE. Chaque passage ne prend plus que SA PART de ce qui reste au jour,
  // divisée par le nombre de passages qui ont encore des fuseaux à servir aujourd'hui
  // (celui-ci compris). Le dernier passage du jour hérite donc de tout le reliquat.
  // Le total quotidien ne bouge pas : on ne change QUE le partage.
  //
  // Auto-correcteur : un fuseau qui n'utilise pas sa part ne la gaspille pas — `daySoFar`
  // ne compte que les tentatives réelles, donc le passage suivant divise un reste plus
  // gros par un diviseur plus petit et récupère la mise.
  // ── RAMPE DE L'EXPÉDITEUR DE PROSPECTION (2026-08-19) ────────────────────────────
  // `outreach@payotte.com` n'a aucun historique d'envoi propre. Une adresse neuve qui
  // passe de 0 à 400 courriels/jour se fait classer en pourriel — la montée doit être
  // progressive et CONDITIONNELLE. Les paliers sont datés dans wrangler.toml
  // (OUTREACH_RAMPE) ; à défaut, on reste au plancher. Le passage au palier suivant n'est
  // PAS automatique dans le temps : il exige que le webhook n'ait vu ni plainte ni rebond
  // au-delà des seuils (voir `fluxCoupe()` plus bas) — sinon le plafond reste où il est.
  // ⚠ REMONTÉ ICI LE 9 SEPT. 2026 : `partPassage` en a besoin (voir juste en dessous), et
  // une `const` ne se lit pas avant sa déclaration.
  const rampeOutreach = () => {
    const brut = env.OUTREACH_RAMPE || '';        // ex. « 2026-08-20:100,2026-08-27:200 »
    let plafond = Number(env.OUTREACH_PLANCHER ?? 50);
    for (const p of brut.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [d, n] = p.split(':');
      if (d && n && dayKey >= d.trim()) plafond = Number(n);
    }
    return Math.max(0, plafond);
  };

  /* ⚠ LE CRON TOURNE AUSSI À LA DEMIE (22 sept. 2026). Le compte se fait donc par pas de
     30 minutes, sinon il annonce moitié moins de passages qu'il n'y en aura et chaque
     passage se croit autorisé à dépenser le double de sa part.
     Une invocation à 14 h 30 voit la MÊME heure locale qu'à 14 h — c'est voulu : elle ne
     sert pas d'autres provinces, elle apporte un second budget KV de 880 opérations aux
     mêmes. C'est là qu'est le débit. */
  const passagesRestants = (() => {
    let n = 0;
    const depart = at.getUTCHours() * 60 + at.getUTCMinutes();
    for (let m = 0; m <= CRON_DERNIERE_HEURE_UTC * 60 + 50; m += 10) {
      if (m < depart) continue;
      const u = Math.floor(m / 60);
      if (u > CRON_DERNIERE_HEURE_UTC) break;
      if (m % 30 && !heuresDixMin(at, env).has(u)) continue;   // pas de passage à cette minute
      const d = new Date(at); d.setUTCHours(u, m % 60, 0, 0);
      // Une heure de RENFORT sert désormais des provinces : elle compte dans le partage,
      // sinon les passages d'avant se répartiraient le plafond comme si elle n'existait pas
      // et le renfort n'hériterait que du reliquat.
      if (zonesAt10h(d).size || renfortA(u, env, d).size) n++;
    }
    return Math.max(1, n);
  })();
  // ── LE PLAFOND EFFECTIF, PAS LE PLAFOND AFFICHÉ (9 sept. 2026) ────────────────────
  // `dayCap` borne TOUT ; `rampeOutreach()` borne la seule prospection. Or la prospection
  // est ~100 % du trafic : le 9 septembre, `day:2026-09-09:outreach` valait 50 sur 50
  // envois. Partager 250 entre cinq passages quand seuls 75 pouvaient partir a donné 50
  // au premier fuseau (NS/NB/PE/NL, six villes) et 25 à partager entre les six autres
  // provinces — dont l'Ontario et ses 3 466 adresses. La part se calcule donc sur le plus
  // petit des deux, et chaque fuseau reçoit une part qu'il peut réellement dépenser.
  //
  // ⚠️ EFFET SUR LE BULLETIN OPT-IN : lui n'est pas soumis à la rampe, et cette part le
  // freine aussi. C'est assumé tant que les abonnés du formulaire sont une poignée face
  // aux adresses récoltées ; le jour où le bulletin redevient le gros du volume, il lui
  // faudra sa propre part, pas ce raccourci.
  const capJourEffectif = Math.min(dayCap, rampeOutreach());
  // `PART_PASSAGE_DU_JOUR = "AAAA-MM-JJ:500"` : PLANCHER daté de la part d'un passage, toujours borné
  // par ce qui reste du plafond du jour ; inerte le lendemain (30 sept. 2026, demande de Grégory).
  const partMinJour = String(env.PART_PASSAGE_DU_JOUR || '');
  const partMin = partMinJour.slice(0, 10) === dayKey && partMinJour[10] === ':' ? Number(partMinJour.slice(11)) : 0;
  const partPassage = Math.max(1, Math.min(capJourEffectif - daySoFar,
    Math.max(partMin, Math.floor((capJourEffectif - daySoFar) / passagesRestants))));

  // En dry-run rien n'est consommé : l'audience complète du mois doit apparaître au rapport.
  // File d'envoi (2026-08-10) : on n'appelle plus Resend courriel par courriel, on EMPILE
  // et on vide par lots de 100 — un seul appel, donc UNE sous-requête, par lot.
  const file = [];
  const lotsAPrevoir = () => Math.ceil((file.length + 1) / TAILLE_LOT);
  /* Déclarés ICI, et pas près de leur calcul, parce que `viderFile` (défini plus bas mais
     APPELÉ dès la boucle des prospects) doit pouvoir retirer un slug de la cohorte au
     moment où il réécrit sa clé `intro:`. Déclarés après, ils seraient dans la zone morte
     temporelle du `let` et la première vidange lèverait une ReferenceError. */
  // Identité du lot dans la clé `servi:` — l'heure ET LA MINUTE du passage, un suffixe
  // propre à l'exécution, et un rang qui monte.
  // ⚠ DOUBLONS DU 22 AU 29 SEPT. 2026 : la clé ne portait que l'heure (« le cron est
  // horaire »). Il ne l'était plus : passages à :00 et :30, puis aux 10 min de 18 h à 19 h.
  // Le passage de :30 réécrivait `…-18-0`, `…-18-1`… par-dessus ceux de :00, leurs marques
  // disparaissaient, et ces destinataires repartaient au passage suivant. Mesuré dans
  // Resend : 21 067 envois pour 16 294 destinataires, 4 515 en trop (jusqu'à 6 fois la même
  // personne). Ne jamais retirer la minute ni le suffixe de cette clé.
  const heureUTC = String(at.getUTCHours()).padStart(2, '0')
    + String(at.getUTCMinutes()).padStart(2, '0') + '-' + crypto.randomUUID().slice(0, 6);
  let lotNo = 0;
  const reIntro = new Set();      // rempli plus bas, une fois les experts atteints
  let cohorteConnue = false;      // a-t-on une cohorte FIABLE en main ?
  let cohorteDirty = false;       // faut-il la réécrire en fin d'exécution ?
  // ── PART RÉSERVÉE AUX EXPERTS (2026-08-19) ─────────────────────────────────────────
  // MESURÉ le 18 août en KV : `sent:2026-08:` = 623 prospects contre 217 experts, et le
  // compte des experts est FIGÉ depuis le 13 août. 351 experts publiés n'ont rien reçu du
  // mois. Surtout : les 217 `intro:` sont tous restés à l'étape ⓪ — pas UN SEUL courriel
  // ② « confirmez votre fiche » n'est jamais parti, alors que c'est l'étape qui produit
  // les Recommandés, donc les badges, donc les liens retour — le seul levier d'autorité
  // du site (10 liens externes pour 1 962 pages).
  //
  // LA CAUSE, dans ce fichier : la boucle des prospects (plus haut) s'exécute AVANT celle
  // des experts et partage le même `canSend()`. Les prospects sont ~2 300 et grossissent
  // de ~150/nuit par la récolte ; les experts sont ~625 et ne bougent pas. À part égale
  // dans une file unique, les premiers mangent tout : ce n'est pas un bug, c'est l'ordre
  // des boucles qui devient une famine dès que la récolte dépasse le catalogue.
  //
  // LE CORRECTIF, minimal : les prospects ne peuvent plus consommer que (1 − EXPERTS_SHARE)
  // de la part du passage ; les experts gardent l'accès à la part entière. On ne change ni
  // le plafond du jour, ni le partage entre fuseaux, ni l'ordre des boucles — seulement le
  // droit de tirage des prospects.
  //
  // Ce n'est PAS un gaspillage quand il n'y a pas d'expert à servir : la réserve non
  // utilisée n'est pas consommée, donc `daySoFar` ne monte pas, et l'auto-correcteur
  // décrit plus haut (reste plus gros ÷ diviseur plus petit) la rend au passage suivant.
  // `EXPERTS_SHARE_DU_JOUR = "AAAA-MM-JJ:0"` : dérogation datée, inerte le lendemain (30 sept. 2026 :
  // experts tous servis, la réserve de 30 % bridait chaque passage à 195 prospects sur 279).
  const partJour = String(env.EXPERTS_SHARE_DU_JOUR || '');
  const EXPERTS_SHARE = partJour.slice(0, 10) === dayKey && partJour[10] === ':'
    ? Number(partJour.slice(11)) : Number(env.EXPERTS_SHARE ?? 0.30);
  const partProspects = Math.max(1, Math.floor(partPassage * (1 - EXPERTS_SHARE)));

  // `kind` vaut 'expert' ou 'prospect'. Défaut 'expert' : un appel non qualifié garde le
  // comportement d'avant (part entière) plutôt que de se retrouver bridé en silence.
  // Vrai tant que la reprise des marques perdues (voir `repriseResend`) n'a pas fini : les
  // prospects attendent, les experts (marqués par `intro:`) continuent.
  let repriseBloque = false;
  const canSend = (kind = 'expert') => dryRun
    || (!(kind === 'prospect' && repriseBloque)
        && left() - lotsAPrevoir() >= 0
        && report.attempts < (kind === 'prospect' ? partProspects : partPassage)
        && daySoFar + report.attempts < dayCap);         // et jamais plus que le jour

  // ── ESPACEMENT PAR DOMAINE (2026-08-12) ────────────────────────────────────────────
  // Le plafond « par firme » du versement a été retiré : il comptait des NOMS DE FIRME
  // alors que le risque se joue sur les DOMAINES. Mesuré le 2026-08-12 avec un plafond
  // de 5 en vigueur : pmegatineau.ca 26 adresses en base, mortgagealliance.com 21,
  // royallepage.ca 19 — les bannières franchisées regroupent des dizaines de firmes
  // juridiquement distinctes sur un domaine unique et passaient au travers.
  //
  // Or les clés sont parcourues dans l'ordre `s:{ville}:{courriel}` : les 26 adresses
  // d'un même cabinet de Gatineau sont contiguës et partaient dans le MÊME lot, le même
  // jour. Un serveur d'entreprise lit ça comme une rafale, et une seule plainte peut
  // faire bloquer le domaine entier — on perdrait les 26 d'un coup, plus la réputation.
  //
  // La protection est ICI et pas à la collecte : personne n'est écarté de la base, le
  // reste passe simplement au lendemain. Compteur par jour et par domaine en KV (TTL 3 j),
  // partagé par les sept passages horaires.
  //
  // ⚠️ LE COMPTE MONTE À LA MISE EN FILE, pas à l'acceptation : l'envoi étant différé,
  // compter à l'acceptation laisserait une seule exécution empiler les 26 avant que le
  // premier lot ne parte.
  // `MAX_PAR_DOMAINE_DU_JOUR = "AAAA-MM-JJ:50"` : dérogation datée, inerte le lendemain (30 sept. 2026).
  const domJour = String(env.MAX_PAR_DOMAINE_DU_JOUR || '');
  const MAX_PAR_DOMAINE = domJour.slice(0, 10) === dayKey && domJour[10] === ':'
    ? Number(domJour.slice(11)) : Number(env.MAX_PAR_DOMAINE || 5);
  const domaineDe = (email) => String(email || '').split('@')[1]?.toLowerCase() || '?';
  /* ── LES MESSAGERIES GRAND PUBLIC NE SONT PAS DES FIRMES (28 sept. 2026, demande proprio) ──
     Le plafond de 5 existe pour les bannières : 26 adresses d'un même cabinet sur UN serveur
     d'entreprise. gmail.com ou hotmail.com, ce sont des milliers de personnes sans lien entre
     elles, sur des serveurs qui encaissent des millions de messages par heure. Au 28 sept.,
     1 545 adresses restantes (gmail 951, hotmail 456, outlook 138) attendaient 5 par jour :
     jusqu'à 190 jours pour gmail seul. Le compteur continue de monter (le rapport les voit),
     il ne bloque simplement plus. */
  const MESSAGERIES_PUBLIQUES = new Set([
    'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.ca', 'outlook.com', 'live.com',
    'live.ca', 'msn.com', 'yahoo.com', 'yahoo.ca', 'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'protonmail.com', 'proton.me',
  ]);
  const plafondDomaine = (dom) => (MESSAGERIES_PUBLIQUES.has(dom) ? Infinity : MAX_PAR_DOMAINE);
  /* ── UNE CLÉ PAR JOUR, PAS UNE PAR DOMAINE (2026-09-14, palier gratuit) ───────────
     `dom:{jour}:{domaine}` coûtait une LECTURE par domaine et une ÉCRITURE par domaine et
     par lot. Sur le palier gratuit Workers KV — 1 000 écritures par JOUR pour tout le
     compte — c'était le deuxième poste de dépense après les marques `sent:`, et le
     programme plafonnait à ~250 courriels par jour.

     Tout tient maintenant dans `dom:{jour}` : un objet {domaine: compte}, lu UNE fois au
     début du passage, réécrit UNE fois par lot. Coût : ~0,01 écriture par courriel au
     lieu de ~0,8.

     ⚠ CE COMPTEUR EST UN FREIN, PAS UN REGISTRE. Si un passage meurt avant sa réécriture,
     le pire est que le passage suivant reparte d'un compte un peu bas et laisse passer
     quelques adresses de plus sur un gros domaine. On perd de la précision, jamais une
     adresse : le registre de qui a été servi, lui, est `sent:`/`servi:`. */
  const domCache = new Map();                    // domaine -> déjà servi/en file aujourd'hui
  let domCharge = false;
  const chargerDom = async () => {
    if (domCharge || !env.SUBSCRIBERS) { domCharge = true; return; }
    domCharge = true;
    ctr.kv++;
    try {
      const brut = await env.SUBSCRIBERS.get(`dom:${dayKey}`);
      const j = brut ? JSON.parse(brut) : null;
      if (j && typeof j === 'object') for (const [d, n] of Object.entries(j)) domCache.set(d, Number(n) || 0);
    } catch { /* clé abîmée : on repart d'un compte vide, le frein est simplement plus lâche */ }
  };
  // true = on peut servir cette adresse aujourd'hui ; réserve le créneau au passage.
  const prendreCreneauDomaine = async (email) => {
    if (dryRun) return true;
    await chargerDom();
    const dom = domaineDe(email);
    const n = domCache.get(dom) ?? 0;
    if (n >= plafondDomaine(dom)) { report.reportesDomaine = (report.reportesDomaine || 0) + 1; return false; }
    domCache.set(dom, n + 1);
    return true;
  };

  // Échantillon du jour (décision proprio, 2026-08-09) : la PREMIÈRE fois qu'un courriel
  // part dans la journée, une copie conforme (même HTML, même sujet) file au proprio,
  // sujet préfixé « [échantillon → destinataire] ». Une seule par jour (clé KV, TTL 3 j),
  // hors plafond quotidien — c'est de l'observation, pas de l'audience.
  let sampleSent = dryRun || !env.SUBSCRIBERS
    || Boolean(await env.SUBSCRIBERS.get(`sample:${dayKey}`));
  const envoyerEchantillon = async (aQui, subject, html) => {
    if (sampleSent) return;
    sampleSent = true;
    ctr.subs++;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
        to: [REPORT_TO],
        subject: `[échantillon → ${aQui}] ${subject}`,
        html,
      }),
    }).catch(() => { /* l'échantillon n'est jamais bloquant */ });
    ctr.kv++;
    await env.SUBSCRIBERS.put(`sample:${dayKey}`, new Date().toISOString(),
      { expirationTtl: 3 * 24 * 3600 });
  };

  // Vidage de la file, par lots de 100. On ne marque `sent:` (ni `intro:`) qu'APRÈS
  // acceptation par Resend, courriel par courriel : un refus repart demain, intact — la
  // règle n'a pas bougé, seul le moment où on la vérifie a changé.
  const echecsParProv = {};
  const viderFile = async () => {
    while (file.length) {
      const lot = file.splice(0, TAILLE_LOT);
      const marquesDuLot = [];         // identifiants servis, écrits d'un bloc en fin de lot
      lotNo++;
      ctr.subs++;
      // Un lot peut mêler prospects et experts : on n'envoie donc pas le lot entier sous un
      // seul expéditeur, on le fend par flux. Deux appels au pire, toujours ≤ 2 sous-requêtes.
      const parFlux = new Map();
      for (const e of lot) {
        const f = e.flux === 'bulletin' ? 'bulletin' : 'outreach';
        (parFlux.get(f) ?? parFlux.set(f, []).get(f)).push(e);
      }
      const reponses = new Array(lot.length);
      for (const [flux, sousLot] of parFlux) {
        const fromFlux = flux === 'bulletin'
          ? (env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>')
          : (env.MAIL_FROM_OUTREACH || env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>');
        const r = await sendPulseBatch(env, sousLot, { from: fromFlux });
        sousLot.forEach((e, k) => { reponses[lot.indexOf(e)] = r[k]; });
        // Compteur par flux — c'est lui que la rampe et les seuils de plainte lisent.
        const cle = `day:${dayKey}:${flux}`;
        if (env.SUBSCRIBERS) ctr.kv += 2;          // la lecture ci-dessous + l'écriture qui suit
        const dejaFlux = Number((await env.SUBSCRIBERS?.get(cle)) || 0);
        await env.SUBSCRIBERS?.put(cle, String(dejaFlux + sousLot.length), { expirationTtl: 3 * 24 * 3600 });
        /* Dénominateur MENSUEL de /flux-stats, désormais tenu par l'expéditeur : une
           écriture par LOT de 100 au lieu d'une par destinataire côté webhook. C'est ce
           qui permet au webhook de ne plus compter `email.sent` ni `email.delivered` —
           voir le bloc « NE COMPTER QUE LE RARE ». On compte les TENTATIVES : un refus
           Resend est rare, et majorer le dénominateur va dans le sens prudent (il baisse
           les taux de plainte plutôt que de les gonfler). */
        const cleMois = `stat:${flux}:${dayKey.slice(0, 7)}:envoyes`;
        if (env.SUBSCRIBERS) ctr.kv += 2;
        const dejaMois = Number((await env.SUBSCRIBERS?.get(cleMois)) || 0);
        await env.SUBSCRIBERS?.put(cleMois, String(dejaMois + sousLot.length), { expirationTtl: 400 * 24 * 3600 });
      }
      for (let i = 0; i < lot.length; i++) {
        const e = lot[i];
        const r = reponses[i];
        if (!r?.ok) {
          report.failed++;
          if (e.prov) echecsParProv[e.prov] = (echecsParProv[e.prov] || 0) + 1;
          report.errors.push(`${e.etiquette} — Resend HTTP ${r?.status ?? '?'}${r?.error ? ` (${r.error})` : ''}`);
          continue;
        }
        marquesDuLot.push(e.cle);      // groupées : une seule écriture pour tout le lot
        if (e.stage === 'intro') {
          if (env.SUBSCRIBERS) ctr.kv++;
          await env.SUBSCRIBERS?.put(`intro:${e.cle}`, new Date().toISOString());
          // La clé vient de passer à AUJOURD'HUI : ce slug quitte la cohorte pré-opt-out.
          // C'est la SEULE porte de sortie, et elle est ici — d'où les déclarations
          // anticipées de `reIntro` / `cohorteDirty` en tête de `runBulletin`.
          if (reIntro.delete(e.cle)) cohorteDirty = true;
        }
        report.sent++;
        await envoyerEchantillon(e.to, e.subject, e.html);
      }
      /* ── DEUX ÉCRITURES PAR LOT, POINT (2026-09-14, palier gratuit) ─────────────────
         C'est tout ce que coûte un lot de 100 courriels, contre ~180 auparavant.

         `servi:` porte les identifiants du lot dans UNE clé. Le registre reste écrit
         APRÈS acceptation par Resend, lot par lot : ce qui n'est pas confirmé repart au
         passage suivant. Une perte reste possible si le passage meurt entre l'envoi et
         cette ligne — mais elle est bornée à un lot, exactement comme avant.

         ⚠ LES ANCIENNES MARQUES `sent:{cycle}:{id}` RESTENT LUES (voir la construction de
         `done`). Elles ne sont plus écrites, mais les 623 déjà posées ce cycle-ci valent
         toujours : les ignorer réexpédierait à tout le monde. Ne pas « nettoyer » ce
         double chemin avant le 1er octobre, quand le cycle repart de zéro. */
      if (env.SUBSCRIBERS && marquesDuLot.length) {
        ctr.kv++;
        await env.SUBSCRIBERS.put(`servi:${cycle}:${dayKey}-${heureUTC}-${lotNo}`,
          JSON.stringify(marquesDuLot), { expirationTtl: CYCLE_TTL });
      }
      if (env.SUBSCRIBERS) {
        ctr.kv++;
        await env.SUBSCRIBERS.put(`dom:${dayKey}`, JSON.stringify(Object.fromEntries(domCache)),
          { expirationTtl: 3 * 24 * 3600 });
      }
    }
  };

  // `attempts` = appels Resend tentés (ils consomment le budget, réussis ou non) ;
  // `sent` = acceptés par Resend ; `failed`/`errors` = refusés ; `pending` = ce qui reste
  // à faire ce mois-ci et repassera au prochain passage.
  const report = {
    dryRun, cycle, attempts: 0, sent: 0, failed: 0, pending: 0,
    // Reportés au lendemain parce que leur domaine avait déjà eu ses MAX_PAR_DOMAINE
    // du jour. À zéro tant qu'aucune bannière ne sature : c'est le témoin de l'espacement.
    reportesDomaine: 0,
    // Envois de PROSPECTION mis en file à ce passage — sert à faire respecter la rampe du
    // sous-domaine neuf sans relire le compteur KV à chaque courriel.
    outreachEnvoyes: 0,
    prospects: 0, experts: { intro: 0, yellow: 0, green: 0, reco: 0, partner: 0 },
    activeCities: 0, errors: [], skipped: [], recipients: [], budgetUsed: 0,
    zones: [], dayUsedBefore: daySoFar, dayCap, capJourEffectif, partPassage, passagesRestants,
    /* ── LES CHIFFRES QUI PEUVENT ARRÊTER LE PROGRAMME (2026-09-16) ────────────────
       Ils décidaient de tout et ne paraissaient nulle part : ni dans le rapport, ni
       dans l'essai à blanc. On ne pouvait donc pas VÉRIFIER un correctif du comptage
       autrement que par déduction — c'est ce qui vient d'arriver. Ils sortent
       maintenant avec le reste, et l'essai à blanc les montre avant tout envoi.
       `sur24h` couvre aujourd'hui ET hier, comme les seuils eux-mêmes. */
    sante: {
      envoyes24, plaintes, rebonds,
      tauxPlaintes: envoyes24 ? `${(100 * plaintes / envoyes24).toFixed(3)} %` : '—',
      tauxRebonds: envoyes24 ? `${(100 * rebonds / envoyes24).toFixed(2)} %` : '—',
      seuils: { plaintes: '0,300 % (plancher 1 000) ou 3 en brut sous le plancher', rebonds: '4 % (plancher 200)' },
      stopOutreach: stopOutreach ? String(stopOutreach) : null,
    },
  };

  // Fuseaux servis à ce passage. En dry-run on ne filtre pas : le rapport doit montrer
  // l'audience du mois entier, pas la seule tranche de 10 h en cours.
  // 10 h locales + provinces de RENFORT de cette heure-ci (voir `renfortA`). Le renfort
  // s'AJOUTE, il ne remplace rien : une province déjà à 10 h reste servie normalement.
  const renfort = renfortA(at.getUTCHours(), env, at);
  const zones = new Set([...zonesAt10h(at), ...renfort]);
  if (renfort.size && !dryRun) console.log(`[bulletin] renfort ${at.getUTCHours()} h UTC : ${[...renfort].join(' ')}`);
  report.zones = [...zones];
  report.renfort = [...renfort];

  const market = await F('/api/market.json').catch(() => ({ cities: [] }));
  /* MOIS_MARCHE_MIN (5 oct. 2026, Grégory : « envoie seulement ceux qui sont à jour pour
     septembre ») : une ville dont le dernier mois publié est plus ancien n'est PAS servie.
     Ses prospects et ses experts restent en attente, rien n'est marqué : ils partiront le
     jour où la collecte des villes aura versé le mois. Un trimestre (« 2026-T2 ») ne passe pas.
     Vide = pas de filtre. */
  const moisMin = String(env.MOIS_MARCHE_MIN || '');
  const moisOK = (m) => !moisMin || (/^\d{4}-\d{2}$/.test(m ?? '') && m >= moisMin);
  const allActive = (market.cities || []).filter((c) => hasMarketStats(c) && moisOK(c.referenceMonth));
  // Le filtre par fuseau s'applique ICI, sur les villes : tout le reste (prospects comme
  // experts) passe par `cityBySlug`, donc personne hors tranche ne peut être servi.
  /* ⚠ DÉROGATION DATÉE À LA RÈGLE DES 10 H LOCALES (8 sept. 2026, demande proprio).
     Le bulletin ne sert normalement que les provinces où il est 10 h : c'est une bonne
     règle, elle fait arriver le courriel à une heure ouvrable partout, et elle REPREND
     d'elle-même dès le lendemain. Mais elle a un effet de bord que la journée du
     8 septembre a révélé : la plage de cron (12-18 UTC) ne couvre les provinces qu'UNE
     FOIS chacune, entre 13 et 17 UTC — et le passage de 18 UTC ne sert personne. Les
     verrous ayant été levés à 15 h 59 et 16 h 47 UTC, il ne restait qu'une seule
     province servable dans la journée. D'où cette dérogation, pour la journée du
     lancement seulement.
     ⚠ ELLE S'ANNULE SEULE : passé `ZONES_TOUTES_JUSQU_AU`, le filtre par fuseau
     revient sans qu'on ait à toucher au code. Ne pas la reconduire sans raison — un
     courriel qui arrive à 6 h du matin se fait supprimer, pas lire. */
  const toutesZones = (env.ZONES_TOUTES_JUSQU_AU || '') >= dayKey && (env.ZONES_TOUTES_JUSQU_AU || '') !== '';
  if (toutesZones && !dryRun) console.log(`[bulletin] dérogation 10 h locales active (jusqu'au ${env.ZONES_TOUTES_JUSQU_AU}) — toutes provinces servies.`);
  /* ── FORÇAGE DE PROVINCES, DATÉ (14 sept. 2026, demande proprio) ──────────────────
     `ZONES_TOUTES_JUSQU_AU` ouvre TOUTES les provinces, et ce n'est pas la même demande
     que « sors le Québec et l'Ontario aujourd'hui ». Les clés prospects sont parcourues
     dans l'ordre `s:{ville}:{courriel}`, donc alphabétique par VILLE à l'échelle du pays :
     tout ouvrir ne sert pas QC/ON en premier, ça les dilue dans les huit autres provinces.
     D'où une liste explicite.

     ⚠ ET DATÉE, comme la dérogation voisine. Un forçage qui survit à sa journée enverrait
     tôt ou tard à 6 h du matin quelque part — c'est exactement l'accident que la règle des
     10 h locales existe pour empêcher. La date est celle du jour visé, au format
     `AAAA-MM-JJ:QC,ON` ; le lendemain la variable est inerte et le filtre par fuseau
     reprend tout seul. Rien à retirer à la main, rien à oublier. */
  const forcage = String(env.PROVINCES_DU_JOUR || '');
  const forcees = forcage.slice(0, 10) === dayKey && forcage.includes(':')
    ? new Set(forcage.slice(11).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))
    : null;
  if (forcees && !dryRun) console.log(`[bulletin] forçage de provinces (${[...forcees].join(' ')}) pour ${dayKey} — règle des 10 h locales écartée pour aujourd'hui.`);
  const active = dryRun ? allActive
    : forcees ? allActive.filter((c) => forcees.has(c.province))
    : toutesZones ? allActive
    : allActive.filter((c) => zones.has(c.province));
  const cityBySlug = Object.fromEntries(active.map((c) => [c.slug, c]));
  report.activeCities = active.length;

  /* Province servie à ce passage ? Même règle que `active` ci-dessus, mais pour les clés
     `s:prov-*`, qui n'ont pas de ville dans `cityBySlug`. Ne sert que si l'interrupteur
     du bulletin provincial est ouvert. */
  const provinceServie = (code) => dryRun
    || (forcees ? forcees.has(code) : toutesZones || zones.has(code));
  // Aucune province à 10 h : on s'arrête là (1 feed, 1 lecture KV). Le cas normal 6 fois sur 7.
  // (Interrupteur provincial ouvert : on continue aussi si une zone est servie sans ville
  // active — une province sans marché suivi peut avoir des clés `s:prov-*`.)
  if (!active.length && !(provincialActif && (dryRun || forcees?.size || toutesZones || zones.size))) {
    report.budgetUsed = ctr.subs; return report;
  }

  /* ── TÉMOIN D'EXÉCUTION (9 sept. 2026) ──────────────────────────────────────────
     Le 9 septembre, quatre passages sur cinq ont été tués net à 30 s par la limite des
     Cron Triggers. Un isolat tué ne lève pas d'exception : le `catch` de `scheduled()`
     ne voit rien, `sendRunReport` n'est jamais atteint, et la journée n'a laissé QU'UN
     récapitulatif pour cinq passages. Sans les mesures d'analytique Cloudflare, rien
     nulle part ne disait que quatre passages étaient morts.
     Ces deux écritures encadrent le passage : « debut » posé avant le moindre travail,
     « fin » à la sortie normale. Un « debut » resté seul EST la signature d'un passage
     mort — le passage suivant le voit et le met en tête de son récapitulatif. C'est la
     seule trace qui survive à un isolat tué net, et elle coûte deux écritures KV. */
  /* ⚠ LE TÉMOIN PORTE L'HEURE ET LA MINUTE (22 sept. 2026). Il n'indexait que l'heure ;
     depuis que le cron tourne aussi à la demie, les passages de 14 h et de 14 h 30
     auraient écrit la MÊME clé. Le second aurait écrasé le premier, et un passage mort à
     14 h serait devenu invisible dès que celui de 14 h 30 se terminait — exactement la
     panne silencieuse que ce témoin existe pour rendre visible. */
  const temoin = `run:${dayKey}:${String(at.getUTCHours()).padStart(2, '0')}`
    + (creneauCron(at, env) ? String(creneauCron(at, env)).padStart(2, '0') : '');   // 18, 1810, 1830…
  if (!dryRun && env.SUBSCRIBERS) {
    const morts = [];
    for (const h of await kvKeys(env.SUBSCRIBERS, `run:${dayKey}:`)) {
      if ((await env.SUBSCRIBERS.get(`run:${dayKey}:${h}`)) === 'debut') morts.push(`${h} h UTC`);
    }
    report.passagesMorts = morts;
    await env.SUBSCRIBERS.put(temoin, 'debut', { expirationTtl: 3 * 24 * 3600 });
  }

  // Taux et obligations : NATIONAUX, donc identiques pour tout le monde. Deux sous-requêtes
  // pour l'exécution entière, jamais deux par courriel. Feeds indisponibles → `macro` reste
  // null et le bloc disparaît simplement du gabarit : aucun envoi n'est bloqué pour ça.
  const macro = await macroCourant();
  report.macro = macro ? 'taux+obligations' : 'indisponible';

  // État du cycle : 3 lectures KV, pas une seule sous-requête.
  /* ── LE REGISTRE SE LIT SOUS DEUX FORMES (2026-09-14) ─────────────────────────────
     `sent:{cycle}:{id}` — une clé par destinataire, la forme historique. Plus ÉCRITE
     depuis le passage au groupage, mais toujours LUE : 623 marques posées ce cycle-ci en
     dépendent, et les ignorer réexpédierait à tout le monde.
     `servi:{cycle}:{jour}-{heure}-{n}` — un tableau d'identifiants par lot de 100, la
     forme actuelle. Quelques dizaines de clés là où il y en avait des milliers.
     Les deux alimentent le MÊME ensemble. À supprimer seulement après le 1er octobre,
     quand le cycle repart de zéro et qu'il ne reste plus d'ancienne marque vivante. */
  /* ── REPRISE DES MARQUES PERDUES, SEPTEMBRE 2026 SEULEMENT (29 sept. 2026) ─────────
     Du 22 au 29 sept., la clé `servi:` ne portait que l'heure : le passage de :30 écrasait
     les lots de :00 (voir `heureUTC`). Resend a reçu 21 067 envois pour 16 294
     destinataires ; ~2 000 personnes servies n'ont plus de marque et repartiraient.
     Resend fait foi : chaque passage lit quelques pages de SON registre (`GET /emails`,
     100 par page, du plus récent au plus ancien), garde le curseur et les adresses dans
     `reprise-resend:{cycle}`, et quand le mois est lu en entier écrit UN lot
     `servi:{cycle}:reprise-resend` = toutes les clés du carnet dont l'adresse a déjà reçu
     un courriel. Tant que ce n'est pas fini, aucun prospect ne part (`repriseBloque`).
     Rien ne sort de Cloudflare ni de Resend. Inerte à partir d'octobre (cycle neuf). */
  if (env.SUBSCRIBERS && cycle === '2026-09' && !dryRun) {
    const etat = await pasRepriseResend(env, cycle, { maxSubs: Math.max(0, left() - 10) });
    ctr.subs += etat.subsUtilisees || 0;
    ctr.kv += etat.kvUtilisees || 0;
    if (etat.actif) {
      repriseBloque = !etat.fini;
      report.reprise = { pages: etat.pages, adresses: etat.emails.length, fini: etat.fini, marques: etat.marques ?? null, erreur: etat.erreur ?? null };
    }
  }
  const done = new Set(env.SUBSCRIBERS ? await kvListe(`sent:${cycle}:`) : []);
  /* ── LE CUMUL : UNE LECTURE AU LIEU D'UNE PAR LOT (28 sept. 2026) ─────────────────
     Chaque lot `servi:` coûtait une lecture à CHAQUE passage, et les lots s'accumulent
     tout le mois : 53 le 18 sept., 147 le 28. Le démarrage mangeait donc de plus en plus
     du budget de 880 et chaque passage regardait moins d'adresses — le débit baissait de
     jour en jour sans qu'aucun réglage ne bouge.
     `servi-cumul:{cycle}` = { lots: [noms déjà fondus], ids: [identifiants] }. Un passage
     lit le cumul, puis SEULEMENT les lots qu'il ne contient pas encore, et réécrit le
     cumul dès qu'il en trouve 5 ou plus. Les lots eux-mêmes restent en place (TTL de
     cycle) : le cumul n'est qu'un raccourci, le registre reste les lots.
     ⚠ Le préfixe `servi-cumul:` ne commence PAS par `servi:{cycle}:` — sinon le cumul se
     listerait lui-même comme un lot.
     ⚠ Un lot illisible n'entre PAS dans `lots` du cumul : il sera relu au passage suivant. */
  if (env.SUBSCRIBERS) {
    const CLE_CUMUL = `servi-cumul:${cycle}`;
    let cumul = null;
    try { cumul = JSON.parse((await kvLot([CLE_CUMUL]))[0] || 'null'); } catch { cumul = null; }
    const dejaFondus = new Set(Array.isArray(cumul?.lots) ? cumul.lots : []);
    const idsCumul = Array.isArray(cumul?.ids) ? cumul.ids : [];
    for (const id of idsCumul) done.add(id);
    const lots = (await kvListe(`servi:${cycle}:`)).filter((k) => !dejaFondus.has(k));
    const blobs = lots.length ? await kvLot(lots.map((k) => `servi:${cycle}:${k}`)) : [];
    const lusOk = [], idsNeufs = [];
    blobs.forEach((b, i) => {
      try { const ids = JSON.parse(b || '[]'); for (const id of ids) { done.add(id); idsNeufs.push(id); } lusOk.push(lots[i]); }
      catch { /* lot illisible : ses adresses repartiront, jamais de doublon silencieux dans l'autre sens */ }
    });
    report.lotsServiLus = lots.length;
    if (!dryRun && lusOk.length >= 5) {
      ctr.kv++;
      await env.SUBSCRIBERS.put(CLE_CUMUL,
        JSON.stringify({ lots: [...dejaFondus, ...lusOk], ids: [...idsCumul, ...idsNeufs] }),
        { expirationTtl: CYCLE_TTL });
    }
  }
  /* ── JAMAIS SERVIS D'ABORD (décision de Grégory, 30 sept. 2026) ────────────────────
     Au 1er du mois tout le carnet redevient éligible. Ceux qui n'ont RIEN reçu le mois
     précédent passent devant ; les autres suivent dans le même passage, pour ne pas
     laisser dormir la capacité quand les gros domaines ont fait leurs 20 du jour.
     L'ensemble du mois précédent (cumul + lots `servi:` + anciennes marques `sent:`,
     tous gardés CYCLE_TTL = 100 j) est fondu UNE fois dans `servis-avant:{cycle}` :
     les passages suivants paient une seule lecture. */
  let servisAvant = null;
  if (env.SUBSCRIBERS && !dryRun) {
    const [a, m] = cycle.split('-').map(Number);
    const precedent = m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
    const CLE_AVANT = `servis-avant:${cycle}`;
    try {
      ctr.kv++;
      const brut = await env.SUBSCRIBERS.get(CLE_AVANT);
      if (brut) servisAvant = new Set(JSON.parse(brut));
    } catch { servisAvant = null; }
    if (!servisAvant && kvLeft() > 400) {
      const ens = new Set(await kvListe(`sent:${precedent}:`));
      try { const c = JSON.parse((await kvLot([`servi-cumul:${precedent}`]))[0] || 'null'); for (const id of c?.ids || []) ens.add(id); } catch { /* cumul absent */ }
      const lotsPrec = await kvListe(`servi:${precedent}:`);
      for (let i = 0; i < lotsPrec.length && kvLeft() > 150; i += 50) {
        const blobs = await kvLot(lotsPrec.slice(i, i + 50).map((k) => `servi:${precedent}:${k}`));
        for (const b of blobs) { try { for (const id of JSON.parse(b || '[]')) ens.add(id); } catch { /* lot illisible */ } }
      }
      servisAvant = ens;
      if (ens.size) {
        ctr.kv++;
        await env.SUBSCRIBERS.put(CLE_AVANT, JSON.stringify([...ens]), { expirationTtl: 40 * 24 * 3600 });
      }
    }
    report.servisMoisPrecedent = servisAvant?.size ?? null;
  }
  const unsub = new Set(env.SUBSCRIBERS ? await kvListe('unsub:') : []);
  const intro = new Set(env.SUBSCRIBERS ? await kvListe('intro:') : []);
  /* ── LES REBONDS DURS EN UNE LISTE (14 sept. 2026) ───────────────────────────────
     `bounce:{courriel}` était lu UNE FOIS PAR CANDIDAT, en série, dans la boucle des
     prospects — donc payé même pour les gens que le filtre suivant allait écarter.
     Un `kv.list()` rend 1 000 clés par opération : tout le carnet des rebonds coûte
     désormais une ou deux opérations pour l'exécution entière, et le test devient
     gratuit. C'est la même économie que `unsub:` et `intro:` faisaient déjà — la
     boucle des prospects était simplement passée à côté. */
  const rebondsDurs = new Set(env.SUBSCRIBERS ? await kvListe('bounce:') : []);
  /* La cohorte se lit ICI, avant la boucle des prospects, pour UNE raison : la réserve de
     budget KV des experts en dépend. Cache présent → leur coût est d'une poignée
     d'opérations et les prospects peuvent prendre presque tout. Cache absent (premier
     passage, clé abîmée) → il faudra recalculer, une lecture par expert présenté, et il
     FAUT le réserver. Lire la clé coûte 1 opération ; se tromper de réserve en coûte 237. */
  let cacheCohorte = null;
  if (env.SUBSCRIBERS) {
    try {
      ctr.kv++;
      const brut = await env.SUBSCRIBERS.get(CLE_COHORTE);
      const j = brut ? JSON.parse(brut) : null;
      if (Array.isArray(j)) cacheCohorte = j;
    } catch { cacheCohorte = null; }   // clé abîmée : repli sur le calcul complet
    /* ── LE CALCUL DE REPLI SE FAIT ICI, PAS APRÈS LES PROSPECTS (14 sept. 2026, soir) ──
       Il était placé juste avant la section des experts, pour ne rien payer si les
       prospects avaient déjà épuisé le budget. Bonne intention, BLOCAGE CIRCULAIRE : au
       passage de 18 h, les prospects ont consommé jusqu'à la réserve, il ne restait plus
       de quoi calculer la cohorte, donc `expertsPossibles` est resté faux, donc les deux
       provinces ont été sautées — ET la clé n'a pas été écrite. Le passage suivant
       repartait dans le même état : experts jamais servis, réserve payée pour rien.
       Résultat mesuré : 105 prospects, 0 expert, cohorte toujours absente.

       Le calcul est une dépense UNIQUE dans la vie du worker. La payer d'entrée coûte un
       passage un peu plus court ; la reporter coûte les experts à chaque fois. */
    if (!cacheCohorte && kvLeft() > intro.size + 60) {
      const LOT_LECTURE = 40;
      const slugsIntro = [...intro];
      const trouves = [];
      for (let i = 0; i < slugsIntro.length; i += LOT_LECTURE) {
        const tranche = slugsIntro.slice(i, i + LOT_LECTURE);
        const dates = await kvLot(tranche.map((slug) => `intro:${slug}`));
        dates.forEach((quand, k) => {
          if (quand && quand.slice(0, 10) < OPT_OUT_SWITCH) trouves.push(tranche[k]);
        });
      }
      cacheCohorte = trouves;
      cohorteDirty = true;           // à écrire en fin d'exécution, et plus jamais ensuite
      console.log(`[bulletin] cohorte pré-opt-out calculée pour la première fois : ${trouves.length} slug(s).`);
    }
  }
  /* La réserve n'a plus à couvrir le calcul : il est fait. Elle ne couvre que les envois
     aux experts — créneau de domaine, marque `sent:`, réécriture `intro:`. */
  const RESERVE_EXPERTS = 120;

  // ---- Prospects (abonnés du formulaire) ----
  // Liste hissée hors de la boucle : elle sert DEUX fois — pour servir, puis pour le
  // recensement par province du récapitulatif. Un `kv.list()` de plus serait gratuit en
  // budget de sous-requêtes, mais pas en temps d'exécution (2 100 clés paginées).
  /* ── LE CURSEUR TOURNANT (23 sept. 2026) ────────────────────────────────────────
     LE DÉFAUT QU'IL CORRIGE, MESURÉ LE 22 SEPTEMBRE. Ce jour-là, dix-neuf passages ont
     tourné, aucun n'est mort, et la journée a fait 617 envois — vingt-cinq de plus que
     la veille, qui n'en avait que sept. Ajouter des passages ne servait à rien, et
     voici pourquoi : `kvListe` rend les clés dans l'ordre alphabétique, et CHAQUE
     passage repartait du même début. Il dépensait son budget KV sur la même tête de
     liste, dont les domaines avaient déjà reçu leurs `MAX_PAR_DOMAINE` du jour, puis
     s'arrêtait. Sept passages parcouraient sept fois le même dixième du carnet.

     Le profil de la journée le dit sans ambiguïté : gros quand une province NEUVE
     s'ouvre (135 à 12 h, 156 à 16 h), zéro sur les passages suivants des MÊMES
     provinces. 617 envois à cinq par domaine, c'est ~123 domaines touchés sur 3 780 —
     trois pour cent du carnet exploités par jour.

     ⚠ CE N'EST PAS UN PLAFOND QU'ON LÈVE, C'EST UN PARCOURS QU'ON REPREND. Le garde
     par domaine reste à 5, la rampe reste, le plafond du jour reste. On cesse
     simplement de relire les mêmes adresses.

     ⚠ ET IL TOURNE, IL NE S'ARRÊTE PAS AU BOUT. Arrivé à la fin du carnet, le passage
     suivant reprend au début — sinon le curseur se figerait sur la dernière clé et le
     programme s'arrêterait net le jour où il aurait fini un tour. Les adresses déjà
     servies ce mois-ci sont écartées gratuitement plus bas ; repasser dessus ne coûte
     qu'une comparaison en mémoire.

     Coût : deux opérations KV par passage, une lecture et une écriture. */
  const CLE_CURSEUR = 'curseur:prospects';
  let curseurDepart = null;
  if (env.SUBSCRIBERS && !dryRun) {
    try { ctr.kv++; curseurDepart = await env.SUBSCRIBERS.get(CLE_CURSEUR); } catch { curseurDepart = null; }
  }
  let clesProspects = env.SUBSCRIBERS ? await kvListe('s:') : [];
  if (curseurDepart && clesProspects.length) {
    /* On cherche la première clé STRICTEMENT après le curseur. Une clé supprimée entre
       deux passages ne bloque donc rien : on repart de la suivante, quelle qu'elle soit. */
    let i = clesProspects.findIndex((k) => k > curseurDepart);
    if (i < 0) i = 0;                                   // fin du carnet atteinte : on boucle
    if (i > 0) clesProspects = [...clesProspects.slice(i), ...clesProspects.slice(0, i)];
    report.curseurDepart = curseurDepart;
    report.curseurIndex = i;
  }
  if (env.SUBSCRIBERS) {
    // ── FILTRER AVANT DE LIRE (2026-08-13) ────────────────────────────────────────
    // Le 13 août, AUCUN bulletin n'est parti et aucun rapport n'a été émis : le passage
    // lisait la VALEUR des 1 512 prospects, en série, avant de découvrir que la plupart
    // sont hors du fuseau servi ou déjà servis ce cycle. À ~1 100 prospects ça passait
    // encore ; la récolte en a versé 933 le 12 août et le passage a fini par dépasser son
    // temps d'exécution — en silence, puisque le rapport n'est envoyé que s'il y a eu au
    // moins une tentative. Une panne qui grandit avec le succès de la récolte.
    //
    // Or la clé porte DÉJÀ tout ce qu'il faut pour écarter : `s:{ville}:{courriel}`, et
    // l'identifiant de cycle est exactement `prospect:{ville}:{courriel}`. On filtre donc
    // sur la clé — zéro lecture — et on ne lit la valeur que pour ceux qu'on va servir.
    // Les lectures passent de 1 512 par passage à quelques dizaines.
    /* ── LA COUVERTURE DES VILLES, EN UNE SOUS-REQUÊTE (8 sept. 2026) ──────────
       Un prospect ne reçoit pas le même courriel selon que sa ville porte déjà des
       fiches ou non : « le siège de votre secteur est pris » n'a aucun sens là où
       personne n'est publié. Le worker n'avait aucun moyen de le savoir — les flux
       par province coûtent une sous-requête chacun et sont chargés APRÈS cette
       boucle. D'où `/api/villes-couvertes.json` : ~20 ko, une seule sous-requête,
       lue ici, avant.
       ⚠ SI LE FLUX MANQUE, ON NE DEVINE PAS. `couvertes` reste null et les deux
       contenus segmentés s'effacent au profit du générique — un courriel plus fade
       vaut mieux qu'un courriel qui affirme le contraire de la réalité. */
    let couvertes = null;
    let villesCouvertes = null;   // les entrées complètes — le bulletin provincial en tire ses décomptes
    try {
      const vc = await F('/api/villes-couvertes.json');
      if (Array.isArray(vc?.villes)) { couvertes = new Set(vc.villes.map((v) => v.slug)); villesCouvertes = vc.villes; }
    } catch { couvertes = null; }
    if (!couvertes) console.warn('  ▸ villes-couvertes.json illisible — prospects sur le contenu générique.');

    /* ── DEUX PHASES, ET DES LECTURES QUI NE SE PAIENT QU'UNE FOIS (14 sept. 2026) ──
       CETTE BOUCLE A TUÉ LES PASSAGES DU 14 SEPTEMBRE. Pour CHAQUE clé du carnet elle
       lisait la valeur `s:`, puis `bounce:`, puis `unsub:` — trois opérations KV en
       SÉRIE — et ne testait `stopOutreach` qu'APRÈS. Or `stop:outreach` était posé
       depuis le 11 : aucun envoi n'avançait `report.attempts`, donc `canSend()` restait
       vrai indéfiniment et les 11 571 prospects étaient lus un par un pour être jetés.
       L'isolat mourait vers la 1 000e opération KV, à 22,8 s — SOUS la limite des 30 s,
       donc invisible à l'analyse de durée qui avait servi le 9 septembre — sans
       exception attrapable, sans témoin `fin`, sans rapport.

       Trois changements, dans l'ordre où ils comptent :
       1. `bounce:` et `unsub:` ne se lisent plus par candidat : les deux carnets sont
          déjà en mémoire, listés une fois pour l'exécution. Coût par candidat : zéro.
       2. Les filtres GRATUITS passent en premier (phase 1), et `stopOutreach` est testé
          dès que `rec` est lu — avant tout le reste, plus après.
       3. Ce qui reste à lire l'est PAR TRANCHES PARALLÈLES de 40, sous budget KV compté.
          Un passage ne peut plus mourir de soif : il s'arrête et il le DIT. */
    /* Données du bulletin provincial, chargées au PREMIER destinataire provincial et une
       seule fois : /api/province-market.json (statistique ACI de MB, NS, NB) coûte UNE
       sous-requête. Flux absent ou illisible → `provMarket` vide et la variante
       provinciale retombe sur les trois marchés suivis. Interrupteur fermé : jamais appelé. */
    let ctxProvincial = null;
    const contexteProvincial = async () => {
      if (ctxProvincial) return ctxProvincial;
      let provMarket = [];
      try {
        const pmj = await F('/api/province-market.json');
        if (Array.isArray(pmj?.provinces)) provMarket = pmj.provinces;
      } catch { provMarket = []; }
      const parSlug = new Map((villesCouvertes || []).map((v) => [v.slug, v]));
      ctxProvincial = {
        cities: (market.cities || []).filter((c) => moisOK(c.referenceMonth)), macro,
        provMarket: provMarket.filter((x) => moisOK(x.reference_month)),
        // Décomptes de fiches PUBLIÉES (même filtre que le site : `professional`, score non rouge).
        // Flux absent → null, et la phrase « N professionnels vérifiés » disparaît simplement.
        publiesVille: (slug) => (villesCouvertes ? (parSlug.get(normVille(slug))?.fiches ?? 0) : null),
        publiesProvince: (prov) => (villesCouvertes
          ? villesCouvertes.filter((v) => v.province === prov).reduce((n, v) => n + (v.fiches || 0), 0) : null),
      };
      return ctxProvincial;
    };

    const candidats = [];
    for (const key of clesProspects) {
      const sep = key.indexOf(':');
      if (sep < 1) continue;                         // clé malformée : on ne devine pas
      const city = cityBySlug[key.slice(0, sep)];
      /* BULLETIN PROVINCIAL : `s:prov-{province}:…` n'a pas de ville. Interrupteur FERMÉ,
         la ligne `if (!city) continue` qui suit reste le seul chemin — comportement d'avant. */
      let provSlug = null;
      if (!city && provincialActif && key.startsWith('prov-')) {
        provSlug = key.slice(5, sep);
        const code = PROV_TO_CODE[provSlug]?.toUpperCase();
        if (!code || !provinceServie(code)) continue;   // hors du fuseau servi à cette heure
      } else if (!city) continue;                    // hors du fuseau servi à cette heure
      const id = `prospect:${key}`;
      if (done.has(id)) continue;                    // déjà servi ce cycle
      // DRY-RUN : ni lecture de valeur, ni rendu. Le dry-run ne filtre pas par fuseau
      // (il doit montrer l'audience du mois entier), donc il tombait sur les 2 100 clés :
      // 2 100 lectures KV + 2 100 courriels fabriqués pour être jetés à la ligne suivante.
      // Or la clé `s:{ville}:{courriel}` porte DÉJÀ tout ce que le recensement demande.
      if (dryRun) {
        report.prospects++;
        report.recipients.push({ to: key.slice(sep + 1), kind: 'prospect', city: key.slice(0, sep) });
        continue;
      }
      candidats.push(provSlug ? { key, sep, city, id, provSlug } : { key, sep, city, id });
    }

    // Jamais servis le mois précédent d'abord ; l'ordre de rotation est gardé dans chaque groupe.
    if (servisAvant?.size) {
      const jamais = candidats.filter((c) => !servisAvant.has(c.id));
      const deja = candidats.filter((c) => servisAvant.has(c.id));
      candidats.length = 0;
      /* 5 oct. 2026 (Grégory : « mettre 1/4 de clean avec la balance ») : les neufs ne passent
         plus TOUS devant. Trois jamais servis, puis un déjà servi en septembre (ses rebonds
         sont déjà retirés) : le taux de rebonds du jour se dilue au lieu de se concentrer. */
      for (let i = 0, j = 0; i < jamais.length || j < deja.length;) {
        for (let n = 0; n < 3 && i < jamais.length; n++) candidats.push(jamais[i++]);
        if (j < deja.length) candidats.push(deja[j++]);
      }
      report.candidatsJamaisServis = jamais.length;
    }

    /* Si la boucle va jusqu'au bout sans s'arrêter, le carnet entier a été examiné :
       le curseur se pose alors sur la DERNIÈRE clé, et le passage suivant reprendra au
       début par la rotation. */
    let curseurFin = candidats.length ? candidats[candidats.length - 1].key : null;
    const LOT_KV = 40;
    for (let i = 0; !dryRun && i < candidats.length; i += LOT_KV) {
      if (!canSend('prospect')) { report.pending += candidats.length - i; curseurFin = candidats[i]?.key ?? curseurFin; break; }
      // RÉSERVE : `EXPERTS_SHARE` protège la part d'ENVOI des experts, pas le budget KV.
      // Les prospects tournent en premier — sans réserve ils le videraient et les experts
      // ne seraient jamais servis, quel que soit EXPERTS_SHARE. La réserve couvre les
      // lectures `intro:` de `reIntro` (une par expert déjà présenté) plus leurs envois.
      if (kvLeft() - RESERVE_EXPERTS < LOT_KV) {
        // Budget KV épuisé : ce qui n'a pas été regardé repart au passage suivant,
        // intact. On le COMPTE pour que le récapitulatif le dise au lieu de mentir.
        report.pending += candidats.length - i;
        report.kvEpuise = (report.kvEpuise || 0) + (candidats.length - i);
        /* ⚠ LE CURSEUR POINTE SUR CE QU'ON N'A PAS REGARDÉ, pas sur ce qu'on a envoyé.
           Pointer sur le dernier ENVOYÉ sauterait les candidats lus puis écartés (rebond,
           désabonné, domaine saturé) — ils ne reviendraient jamais. */
        curseurFin = candidats[i]?.key ?? curseurFin;
        break;
      }
      /* ── LE DOMAINE SE LIT DANS LA CLÉ, AVANT DE PAYER LA VALEUR (28 sept. 2026) ──
         La clé est `{ville}:{courriel}` : le domaine y est déjà. Avant, un candidat dont
         le domaine avait eu ses 5 du jour était LU (une opération KV) puis écarté par
         `prendreCreneauDomaine`. Le 28 sept., 138 domaines étaient pleins dès l'après-midi
         et le carnet restant était dominé par remax-quebec (1 637) et royallepage (1 224) :
         les passages lisaient ~580 adresses pour en garder 3 à 40. On les écarte ici,
         gratuitement, et `prises` compte ce que la tranche va déjà réserver pour ne pas
         lire 40 adresses d'un domaine à qui il reste 2 places. Le contrôle après lecture
         reste en place — celui-ci n'est qu'un préfiltre, la règle vit toujours là-bas.
         Le curseur n'en souffre pas : il pointe sur ce qu'on n'a pas REGARDÉ, et un
         candidat écarté ici a été regardé, exactement comme avant. */
      await chargerDom();
      const prises = new Map();
      const tranche = [];
      let j = i;
      for (; j < candidats.length && tranche.length < LOT_KV; j++) {
        const c = candidats[j];
        const dom = domaineDe(c.key.slice(c.sep + 1));
        const n = (domCache.get(dom) ?? 0) + (prises.get(dom) ?? 0);
        if (n >= plafondDomaine(dom)) { report.reportesDomaine = (report.reportesDomaine || 0) + 1; report.pending++; continue; }
        prises.set(dom, (prises.get(dom) ?? 0) + 1);
        tranche.push(c);
      }
      i = j - LOT_KV;   // la boucle ajoute LOT_KV : le prochain tour repart juste après ce qu'on a regardé
      if (!tranche.length) continue;
      const valeurs = await kvLot(tranche.map((c) => `s:${c.key}`));

      // Tri À SEC : plus une seule opération KV ici, donc un candidat écarté ne coûte rien.
      const retenus = [];
      tranche.forEach((c, k) => {
        let rec; try { rec = JSON.parse(valeurs[k] || '{}'); } catch { return; }
        if (!rec.email) return;
        const courrielBas = String(rec.email).toLowerCase();
        // Rebond dur connu (webhook) : l'adresse est morte, elle ne repart jamais.
        if (rebondsDurs.has(courrielBas)) { report.skipped.push(`${rec.email} (rebond)`); return; }
        // Désabonné (lien, ou plainte convertie en désabonnement par le webhook).
        if (unsub.has(`prospect:${courrielBas}`)) return;
        // Prospection arrêtée : un abonné du formulaire continue d'être servi, pas un
        // contact récolté. La distinction est celle du flux, pas celle de la personne.
        const fluxRec = rec.source === 'form-ville' ? 'bulletin' : 'outreach';
        if (stopOutreach && fluxRec === 'outreach') { report.pending++; return; }
        if (c.provSlug) {
          /* Le FUSEAU se lit sur la province de la VALEUR (la clé l'a déjà filtré ; une
             valeur qui la contredit n'est pas servie ici, elle ne l'est nulle part — on
             le signale plutôt que de deviner). */
          const provVal = String(rec.province || c.provSlug);
          const codeVal = PROV_TO_CODE[provVal]?.toUpperCase();
          if (!codeVal || !provinceServie(codeVal)) { report.skipped.push(`${rec.email} (province ${provVal} hors fuseau)`); return; }
          if (!rec.villeReelle) { report.skipped.push(`${rec.email} (provincial sans villeReelle)`); return; }
          // Drapeau de la récolte resté LEVÉ nulle part = « à valider avant envoi » : on n'envoie pas.
          if (rec.drapeau && !rec.drapeauLeve) { report.skipped.push(`${rec.email} (drapeau non levé)`); return; }
          retenus.push({ ...c, provSlug: provVal, rec, fluxRec });
          return;
        }
        retenus.push({ ...c, rec, fluxRec });
      });

      for (const { key, sep, city, id, rec, fluxRec, provSlug } of retenus) {
        if (!canSend('prospect')) { report.pending++; continue; }
        if (fluxRec === 'outreach' && dejaOutreach + report.outreachEnvoyes >= rampeOutreach()) { report.pending++; continue; }
        // Garde-fou : si la valeur stockée ne concordait pas avec sa clé, l'identifiant
        // calculé plus haut serait faux et on risquerait un doublon. On revérifie sur
        // l'identifiant RÉEL avant d'engager quoi que ce soit.
        const idReel = `prospect:${rec.city}:${rec.email}`;
        if (idReel !== id && done.has(idReel)) continue;
        // Domaine saturé pour aujourd'hui : on ne marque RIEN (ni `done`, ni `sent:`),
        // l'adresse repassera telle quelle au prochain passage.
        if (!await prendreCreneauDomaine(rec.email)) { report.pending++; continue; }
        const unsubUrl = `${origin}/unsubscribe?e=${encodeURIComponent(rec.email)}&c=${encodeURIComponent(rec.city)}&t=${await hmacHex(env, `u:${rec.email}:${rec.city}`)}`;
        if (provSlug) {
          // BULLETIN PROVINCIAL — même file, mêmes marques, même désabonnement ; seul le gabarit change.
          const ctxP = await contexteProvincial();
          const v = renderBulletinProvincial({ provSlug, villeReelle: rec.villeReelle, metier: rec.metier, lang: rec.lang, unsubUrl, postale }, ctxP);
          if (!v) {
            // Rien de vrai à dire (aucun chiffre de marché) : le créneau de domaine déjà pris
            // est rendu, rien n'est marqué, l'adresse repassera quand la donnée reviendra.
            const dom = domaineDe(rec.email); domCache.set(dom, Math.max(0, (domCache.get(dom) ?? 1) - 1));
            report.skipped.push(`${rec.email} (provincial : aucun chiffre de marché pour ${provSlug})`);
            continue;
          }
          report.prospects++; report.recipients.push({ to: rec.email, kind: 'prospect', city: rec.city, variante: v.variante, zone: v.zone, prov: PROV_TO_CODE[provSlug]?.toUpperCase(), cat: 'sansSecteur' });
          report.provincial = report.provincial || { banlieue: 0, provincial: 0 };
          report.provincial[v.variante]++;
          report.attempts++;
          done.add(idReel);
          if (fluxRec === 'outreach') report.outreachEnvoyes++;
          file.push({ to: rec.email, subject: v.subject, html: v.html, unsubUrl, cle: idReel,
                      flux: fluxRec,
                      sousFlux: 'bulletin-provincial',   // MESURE — étiquette Resend distincte, même routage
                      etiquette: `provincial ${rec.email}` });
          if (file.length >= TAILLE_LOT) await viderFile();
          continue;
        }
        const { subject, html } = renderPulse({ segment: 'prospect', city, lang: rec.lang, unsubUrl, macro, metier: rec.metier , postale,
          villeCouverte: couvertes ? couvertes.has(normVille(city.slug ?? key.slice(0, sep))) : null });
        report.prospects++; report.recipients.push({ to: rec.email, kind: 'prospect', city: rec.city, prov: city?.province, cat: 'secteur' });
        report.attempts++;
        done.add(idReel);                // servi pour ce cycle dès la mise en file
        // FLUX (2026-08-19) : `source: 'form-ville'` = l'abonné a rempli le formulaire du
        // site, il a DEMANDÉ le bulletin → expéditeur bulletin@. Tout le reste vient de la
        // récolte nocturne (`source` = l'URL où l'adresse a été relevée), donc non sollicité
        // → expéditeur outreach@. La règle lit la donnée existante, rien à migrer.
        if (fluxRec === 'outreach') report.outreachEnvoyes++;
        // `flux` sert DEUX choses qui ne veulent pas la même granularité : le routage de
        // l'expéditeur (2233 : 'bulletin' ou tout le reste) et l'étiquette Resend qui nourrit
        // /flux-stats. Les deux vivaient sur la même clé, écrite deux fois — et en JS la
        // SECONDE gagne : l'étiquette fine était donc jetée en silence depuis le début, et
        // « bulletin-prospect » n'a jamais existé dans les statistiques (2026-08-28).
        file.push({ to: rec.email, subject, html, unsubUrl, cle: idReel,
                    flux: fluxRec,                  // ROUTAGE — 'bulletin' | 'outreach'
                    sousFlux: 'bulletin-prospect',  // MESURE  — l'étiquette envoyée à Resend
                    etiquette: `prospect ${rec.email}` });
        if (file.length >= TAILLE_LOT) await viderFile();
      }
    }

    /* ── ON POSE LE CURSEUR, ET SEULEMENT SI L'ON A AVANCÉ ──────────────────────────
       Écrit à la SORTIE du bloc prospects, donc une fois par passage, qu'il ait envoyé
       ou non : un passage qui a tout écarté (rebonds, désabonnés, domaines saturés) a
       quand même LU ces clés, et les relire au passage suivant serait exactement le
       défaut qu'on corrige.
       ⚠ Jamais en dry-run : une simulation ne doit pas déplacer la position réelle du
       programme. C'est la même règle que partout ailleurs ici. */
    if (env.SUBSCRIBERS && !dryRun && curseurFin) {
      ctr.kv++;
      await env.SUBSCRIBERS.put(CLE_CURSEUR, curseurFin).catch(() => {});
      report.curseurFin = curseurFin;
    }
  }

  /* ⚠ DÉPLACÉ ICI LE 14 SEPTEMBRE 2026 — il s'exécutait AVANT la boucle des prospects.
     Ces ~400 lectures `intro:` ne servent QU'AUX EXPERTS (deux usages, tous deux plus bas).
     Payées en tête d'exécution, elles mangeaient 45 % du budget de 1 000 opérations KV
     avant qu'un seul prospect ne soit regardé. Placées ici, elles ne sont payées que si
     le passage arrive effectivement jusqu'aux experts — et si les prospects ont épuisé le
     budget, elles ne coûtent rien du tout. Aucun changement de résultat : `reIntro` n'est
     lu nulle part avant cette ligne (vérifié). */
  // Cohorte de l'ANCIENNE présentation (avant le passage à l'opt-out). Ce courriel-là
  // promettait par écrit : « Répondez oui et je vous l'envoie. Sinon, aucune suite » et
  // « Aucune suite sans votre accord ». La décision du 2 août change la règle pour la suite,
  // elle n'efface pas cette phrase déjà envoyée : enrôler ces gens en silence dans l'escalier
  // ①②③④ serait reprendre la parole donnée. Ils reçoivent donc d'abord la NOUVELLE
  // présentation — qui dit ce qui va se passer et comment l'arrêter en un clic — puis entrent
  // dans le cycle comme les autres. Une seule fois : l'envoi réécrit leur clé `intro:`.
  // Lecture KV seulement (hors budget de sous-requêtes), et seulement pour les déjà-présentés.

  /* ⚠ EN PARALLÈLE, PAS EN SÉRIE (9 sept. 2026). Cette boucle lisait les 402 clés
     `intro:` l'une après l'autre : ~12 secondes de temps mural sur les 30 que Cloudflare
     accorde à un Cron Trigger, dépensées AVANT le moindre envoi et à chacun des sept
     passages. Les quatre passages du 9 septembre qui ont été tués à 29 s la payaient tous.
     Rien d'autre ne change : mêmes clés, même critère, même résultat — seulement 40 de
     front au lieu d'une. Les opérations KV ne comptent pas dans le budget de
     sous-requêtes, il n'y a donc rien à réserver pour ça. */
  /* ── HORS DU CHEMIN CRITIQUE (14 sept. 2026) ─────────────────────────────────────
     Cette cohorte était RECALCULÉE à chaque passage : une lecture `intro:` par expert
     déjà présenté, 237 opérations sur les 900 du budget KV — un quart du débit d'un
     passage dépensé pour redécouvrir un fait qui ne bouge pas.

     Or il ne bouge pas, et mieux : il ne peut que RÉTRÉCIR. Une clé `intro:` écrite
     aujourd'hui porte forcément une date postérieure au 2 août, donc personne n'entre
     jamais dans la cohorte. On n'en sort que d'une façon — recevoir la nouvelle
     présentation, ce qui réécrit la clé `intro:` (voir `viderFile`). L'appartenance est
     donc entièrement déterminée par ce que NOUS faisons, jamais par l'extérieur : elle
     se mémorise sans risque de dériver.

     D'où UNE clé qui porte la liste. Coût par passage : 1 lecture, et 1 écriture les
     jours où quelqu'un en sort. Le calcul complet ne subsiste qu'en repli, pour le
     premier passage et pour le cas où la clé serait absente ou abîmée.

     ⚠ INTERSECTION AVEC LES CLÉS VIVANTES. Une clé `intro:` supprimée à la main ne doit
     pas ressusciter par le cache : on ne garde que les slugs encore présents dans
     `intro`. Le cache est une mémoire, pas une autorité. */
  if (env.SUBSCRIBERS && cacheCohorte) {
    // Lue ou calculée bien plus haut : ici on ne fait que la retenir, sans une seule
    // opération KV. L'intersection écarte les slugs dont la clé `intro:` a disparu.
    for (const slug of cacheCohorte) if (intro.has(slug)) reIntro.add(slug);
    if (reIntro.size !== cacheCohorte.length) cohorteDirty = true;
    cohorteConnue = true;
  }
  /* ⚠ TOUT OU RIEN. Une cohorte incomplète est PIRE que pas d'experts du tout : un pro
     présenté avant le 2 août serait traité comme déjà introduit et entrerait dans
     l'escalier sans avoir reçu la nouvelle présentation — la parole reprise que le bloc
     plus haut interdit explicitement. Sans cohorte fiable, on ne sert AUCUN expert ce
     passage-ci ; ils repartent intacts au suivant. */
  const expertsPossibles = cohorteConnue;

  // ---- Experts, province par province ----
  // On ne rapatrie une province QUE si on a encore de quoi envoyer : chaque feed coûte une
  // sous-requête. `prov-done:` évite de repayer ce feed les jours suivants pour une province
  // déjà entièrement servie ce mois-ci.
  let dir = {};
  if (env.CONTACTS_TOKEN) { try { dir = (await F(`/api/cx/${env.CONTACTS_TOKEN}.json`)).contacts || {}; } catch { /* annuaire indispo */ } }
  const provinces = [...new Set(active.map((c) => PROV_SLUG[c.province]).filter(Boolean))];
  const provDone = new Set(env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, `prov-done:${cycle}:`) : []);
  // Les adresses déjà servies ce mois-ci : un pro inscrit sur deux secteurs ne reçoit
  // qu'un seul courriel par mois (l'autre fiche attendra le cycle suivant).
  const mailsDone = new Set([...done].map((id) => dir[id]?.email?.toLowerCase()).filter(Boolean));
  const provCompletes = [];        // provinces sans reste — confirmées après le vidage

  for (const prov of provinces) {
    if (!expertsPossibles) { report.skipped.push(`${prov} (budget KV — experts reportés)`); continue; }
    if (kvLeft() <= 5) { report.skipped.push(`${prov} (budget KV épuisé)`); continue; }
    if (provDone.has(prov)) continue;
    if (left() <= 1) { report.skipped.push(`${prov} (budget épuisé)`); continue; }
    const expertsBruts = await F(`/api/experts/${prov}.json`).then((d) => d.experts ?? []).catch(() => []);

    /* ── SERVIR PAR TEMPÉRATURE, PAS DANS L'ORDRE DU FICHIER (8 sept. 2026) ──────
     * Le budget quotidien ne sert qu'une fraction du carnet : au palier du 9 septembre,
     * 75 courriels pour 575 experts servables, soit un mois pour faire le tour. Or
     * l'ordre du flux est arbitraire — les 21 `reco` (fiche confirmée, badge jamais
     * posé) et les 3 `partner` s'y trouvaient noyés parmi 401 `intro`, et n'auraient
     * pas été servis avant des semaines.
     *
     * C'est l'inverse de ce qu'il faut. `reco` est la demande la plus rentable du
     * système entier — un copier-coller de la part de quelqu'un qui a DÉJÀ dit oui, et
     * c'est ce lien qui lève la contrainte d'autorité de tout le site (10 liens
     * externes pour 1 962 pages). `partner` ne demande rien et entretient les huit qui
     * ont déjà donné. Les faire attendre derrière 401 présentations froides, c'est
     * dépenser le budget du plus chaud au plus tiède.
     *
     * On calcule donc l'étape AVANT la boucle et on trie : partner, reco, green, puis
     * yellow et intro. À budget égal, les chauds passent d'abord.
     * ⚠ Le tri ne CHANGE PAS qui est éligible — seulement l'ordre. Tous les filtres
     * (rebond, doublon d'adresse, créneau de domaine, quarantaine) restent en aval et
     * décident comme avant. */
    const RANG = { partner: 0, reco: 1, green: 2, yellow: 3, intro: 4 };
    const experts = expertsBruts
      .map((e) => ({ e, st: expertStage(e, intro.has(e.slug) && !reIntro.has(e.slug)) }))
      .sort((a, b) => (RANG[a.st] ?? 9) - (RANG[b.st] ?? 9))
      .map((x) => x.e);

    let restants = 0;
    for (const e of experts) {
      const city = cityBySlug[e.city];
      if (!city || e.score?.color === 'red' || !e.score?.color) continue;
      if (done.has(e.slug) || unsub.has(e.slug)) continue;
      const contact = dir[e.slug];
      if (!contact?.email) { report.skipped.push(`${e.slug} (pas de courriel)`); continue; }
      if (mailsDone.has(contact.email.toLowerCase())) continue;   // doublon d'adresse : au prochain cycle
      /* ⚠ LES FILTRES GRATUITS D'ABORD, LES LECTURES KV ENSUITE (9 sept. 2026).
         Le test de rebond était ICI, en tête : une lecture KV par expert du carnet, payée
         même quand la rampe était déjà épuisée et que PERSONNE ne pouvait plus partir. Sur
         l'Ontario et le Québec — les deux plus gros carnets, servis au même passage de
         14 h UTC — c'est ce qui a fait dépasser les 30 secondes du Cron Trigger, quatre
         passages de suite. Les trois tests ci-dessous ne coûtent rien : ils passent devant.
         Conséquence assumée : un expert en rebond compte désormais dans `restants` quand la
         rampe coupe avant lui, donc sa province n'est plus marquée `prov-done:` ce jour-là.
         C'est le sens prudent — une province rouverte pour rien coûte une sous-requête,
         une province fermée à tort coûte un mois. */
      if (stopOutreach) { restants++; report.pending++; continue; }   // l'escalier est de la prospection
      if (dejaOutreach + report.outreachEnvoyes >= rampeOutreach()) { restants++; report.pending++; continue; }
      const stage = expertStage(e, intro.has(e.slug) && !reIntro.has(e.slug));
      if (!stage) continue;
      if (!canSend()) { restants++; report.pending++; continue; }
      if (rebondsDurs.has(contact.email.toLowerCase())) { report.skipped.push(`${e.slug} (rebond)`); continue; }
      // Domaine saturé : `restants++` est essentiel — sans lui la province serait
      // marquée `prov-done:` et son feed ne serait plus rapatrié avant le mois prochain.
      if (!await prendreCreneauDomaine(contact.email)) { restants++; report.pending++; continue; }
      report.experts[stage] = (report.experts[stage] || 0) + 1;
      report.recipients.push({ to: contact.email, kind: `expert:${stage}`, slug: e.slug, prov: city?.province,
        cat: (stage === 'reco' || stage === 'partner') ? 'expertVerifie' : 'expert' });
      // Le dry-run tient la même comptabilité (sans écrire en KV), sinon il annoncerait une
      // audience gonflée des doublons d'adresse que l'envoi réel, lui, écarte.
      if (dryRun) { done.add(e.slug); mailsDone.add(contact.email.toLowerCase()); continue; }
      const unsubUrl = await expertUnsubUrl(env, origin, e.slug);
      const { subject, html } = renderPulse({ segment: 'expert', stage, city, expert: e, lang: contact.lang || e.lang, unsubUrl, macro, postale });
      report.attempts++;
      // Marqué « servi » DÈS la mise en file : l'envoi n'étant plus immédiat, un pro
      // inscrit sur deux secteurs serait sinon empilé deux fois dans le même lot.
      done.add(e.slug); mailsDone.add(contact.email.toLowerCase());
      // L'escalier expert est de la prospection : personne n'a demandé à le recevoir.
      report.outreachEnvoyes++;
      file.push({ to: contact.email, subject, html, unsubUrl, cle: e.slug, stage, prov,
                  flux: 'outreach',                          // ROUTAGE
                  sousFlux: `bulletin-expert-${stage}`,      // MESURE — l'étape, enfin comptée
                  etiquette: e.slug });
      if (file.length >= TAILLE_LOT) await viderFile();
    }
    if (!restants && !dryRun) provCompletes.push(prov);
  }

  // Tout ce qui reste en file part maintenant.
  await viderFile();

  // `prov-done:` seulement pour les provinces dont TOUT est réellement parti : aucun reste
  // ET aucun refus au vidage. Marquée à tort, une province ne serait pas rouverte avant le
  // mois prochain — son feed ne serait même plus rapatrié.
  for (const prov of provCompletes) {
    if (!echecsParProv[prov]) {
      await env.SUBSCRIBERS?.put(`prov-done:${cycle}:${prov}`, new Date().toISOString(), { expirationTtl: CYCLE_TTL });
    }
  }

  // ---- RECENSEMENT PAR PROVINCE (demande proprio, 2026-08-17) ----------------------
  // « Combien est parti ce coup-ci, combien par province depuis le début du cycle, et
  // combien reste-t-il pour faire le tour du mois. »
  //
  // Côté INFOLETTRE c'est exact et gratuit : la clé `s:{ville}:{courriel}` porte déjà la
  // ville, l'identifiant de cycle est `prospect:{ville}:{courriel}`, et les opérations KV
  // ne comptent pas dans le budget de sous-requêtes. Aucune valeur n'est lue.
  //
  // Un désabonnement prospect SUPPRIME sa clé `s:` : la liste est donc l'audience vivante,
  // il n'y a rien à retrancher. `done` a été alimenté pendant ce passage, donc « servis »
  // inclut bien les envois de cet événement.
  //
  // Côté EXPERTS, on ne peut PAS recenser sans payer : chaque province coûte une
  // sous-requête de feed, et une province déjà finie n'est même plus rapatriée. On
  // n'annonce donc que ce qu'on sait pour de vrai — les provinces marquées `prov-done:`
  // sont terminées pour le mois — plutôt qu'un total inventé.
  //
  // Réserve assumée : un abonné dont la valeur stockée ne concorde pas avec sa clé est
  // marqué sous son identifiant RÉEL (voir le garde-fou `idReel` plus haut) ; il compterait
  // alors comme « à servir ». Cas rare et sans conséquence — le prochain passage l'écarte.
  {
    const provDeVille = Object.fromEntries(allActive.map((c) => [c.slug, c.province]));
    const par = {};
    let sansMarche = 0;   // abonnés d'une ville sans chiffres : le bulletin n'a rien à leur dire
    for (const key of clesProspects) {
      const sep = key.indexOf(':');
      if (sep < 1) continue;
      let code = provDeVille[key.slice(0, sep)];
      // Interrupteur provincial ouvert : `s:prov-*` compte dans sa province (fermé : « sans marché », comme avant).
      if (!code && provincialActif && key.startsWith('prov-')) code = PROV_TO_CODE[key.slice(5, sep)]?.toUpperCase();
      if (!code) { sansMarche++; continue; }
      const p = (par[code] ||= { total: 0, servis: 0 });
      p.total++;
      if (done.has(`prospect:${key}`)) p.servis++;
    }
    report.parProvince = par;
    report.prospectsSansMarche = sansMarche;
    report.provincesTerminees = [...provDone].sort();
  }

  /* La cohorte n'est réécrite QUE si elle a bougé — un slug servi, ou des clés `intro:`
     disparues. Les jours ordinaires, le coût total de toute cette mécanique est d'UNE
     lecture. Jamais écrite en dry-run, et jamais quand la cohorte n'a pas été établie :
     y poser une liste vide effacerait la mémoire au lieu de la mettre à jour. */
  if (!dryRun && cohorteConnue && cohorteDirty && env.SUBSCRIBERS) {
    ctr.kv++;
    await env.SUBSCRIBERS.put(CLE_COHORTE, JSON.stringify([...reIntro]));
    console.log(`[bulletin] cohorte pré-opt-out réécrite : ${reIntro.size} slug(s).`);
  }
  report.cohortePreOptOut = cohorteConnue ? reIntro.size : null;
  report.budgetUsed = ctr.subs;
  report.kvUsed = ctr.kv;
  // Report du compte du jour pour les passages horaires suivants. On additionne les TENTATIVES,
  // pas les succès : un appel refusé par Resend a quand même été facturé au quota du jour.
  // TTL 3 jours — la clé ne sert que dans sa journée.
  if (!dryRun && report.attempts) {
    await env.SUBSCRIBERS?.put(`day:${dayKey}`, String(daySoFar + report.attempts), { expirationTtl: 3 * 24 * 3600 });
  }
  // Sortie normale : le témoin passe de « debut » à « fin ». Voir le bloc du témoin plus haut.
  if (!dryRun && env.SUBSCRIBERS) {
    await env.SUBSCRIBERS.put(temoin, `fin ${report.attempts}`, { expirationTtl: 3 * 24 * 3600 });
  }
  /* ── LE RAPPORT « ZÉRO », POUR DE VRAI (9 sept. 2026) ────────────────────────────
     La condition était `attempts || failed` : un passage qui avait du monde à servir et
     n'a rien envoyé — rampe épuisée, budget épuisé, flux coupé — sortait en silence. Le
     8 septembre a ajouté un `console.log`, mais sans `[observability]` dans wrangler.toml
     ce journal n'existait nulle part : le « rapport zéro » du council n'a jamais été livré.
     Désormais un passage écrit aussi quand il a VU des candidats sans pouvoir les servir
     (`pending`), et quand un passage précédent de la journée est mort (`passagesMorts`).
     Ce qui reste silencieux, et doit le rester : les passages sans province à 10 h (déjà
     sortis plus haut) et la fin de cycle, quand tout le monde a reçu — pending vaut 0. */
  const aDireQuelqueChose = report.attempts || report.failed || report.pending
    || (report.passagesMorts?.length ?? 0);
  // Fin de semaine sans aucun envoi : pas de rapport (demande de Grégory, 30 sept. 2026).
  const finDeSemaineVide = FIN_DE_SEMAINE(at) && !report.attempts && !report.failed
    && !(report.passagesMorts?.length ?? 0);
  report.at = at.toISOString();
  if (!dryRun && aDireQuelqueChose && !finDeSemaineVide) await sendRunReport(env, report);
  return report;
}

// Un seul courriel par exécution, pour le proprio : ce qui est parti, ce qui a raté, ce qui
// reste. C'est la seule trace — le worker n'a pas de journal persistant.

/**
 * Le compte rendu d'une vague de séquence, en texte, au propriétaire.
 *
 * POURQUOI EN TEXTE, ET POURQUOI SI COURT. Le rapport n'existe pas pour archiver : il
 * existe pour qu'une anomalie saute aux yeux dans une notification de téléphone. Ce qui
 * compte est en haut (combien partis, combien ratés), le détail suit, et la seule ligne
 * qui demande une action est isolée à la fin.
 */
async function envoyerRapportSequence(env, r) {
  if (!env.RESEND_API_KEY) return;
  const etapes = Object.entries(r.parEtape).sort().map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  const lignes = [
    `Vague du ${r.vague} — provinces servies : ${r.zones.join(', ') || '—'}`,
    ``,
    `Partis   : ${r.envoyes}`,
    `Ratés    : ${r.rates}`,
    `Par étape: ${etapes}`,
    ``,
    r.sorties.length ? `Sorties de la séquence (${r.sorties.length}) :` : `Aucune sortie.`,
    ...r.sorties.map((x) => `  · ${x}`),
    ``,
    `À FAIRE : répondre aux réponses reçues. C'est là que la valeur se crée —`,
    `la machine ne fait qu'envoyer.`,
    ``,
    `État complet : GET /sequence-status?t={CONTACTS_TOKEN}`,
  ].join('\n');
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
      // Rapport INTERNE : il part au proprio, pas à une audience. Son reply_to reste
      // REPORT_TO et surtout PAS le no-reply — sinon Grégory ne peut plus répondre à son
      // propre rapport pour se le renvoyer annoté.
      to: [REPORT_TO], reply_to: REPORT_TO,
      subject: `Séquence — ${r.vague} — ${r.envoyes} partis · ${r.rates} ratés · ${etapes}`,
      text: lignes,
    }),
  }).catch(() => {});
}

async function sendRunReport(env, report) {
  if (!env.RESEND_API_KEY) return;
  /* ── RAPPORT DE PASSAGE, VERSION COURTE (30 sept. 2026, demande de Grégory) ────────
     Par province : l'heure locale du passage, ce qui est parti selon quatre catégories
     (experts vérifiés = étapes reco/partner, fiche confirmée ; experts = les autres
     étapes ; prospects d'une ville du site ; prospects sans secteur = bulletin
     provincial), puis le cumul du cycle et ce qui reste. Le cumul et le reste ne
     comptent que les PROSPECTS : le carnet des experts n'est pas recensable sans payer
     une sous-requête par province. Rien d'autre, sauf les alertes (passage mort,
     ratés), qui n'apparaissent que lorsqu'elles existent. */
  const at = report.at ? new Date(report.at) : new Date();
  const heureLocale = (code) => {
    const tz = PROV_TZ[code];
    if (!tz) return '—';
    const [h, m] = new Intl.DateTimeFormat('fr-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(at).split(/\D+/).filter(Boolean);
    return `${Number(h)} h ${m}`;
  };
  const CATS = [['expertVerifie', 'experts vérifiés'], ['expert', 'experts'],
                ['secteur', 'prospects secteur'], ['sansSecteur', 'prospects sans secteur']];
  const passe = {};
  for (const r of report.recipients || []) {
    const code = r.prov || '?';
    const p = (passe[code] ||= { total: 0, expertVerifie: 0, expert: 0, secteur: 0, sansSecteur: 0 });
    p.total++;
    if (r.cat) p[r.cat]++;
  }
  const pp = report.parProvince || {};
  const codes = [...new Set([...Object.keys(passe), ...(report.zones || [])])]
    .sort((a, b) => (passe[b]?.total ?? 0) - (passe[a]?.total ?? 0) || a.localeCompare(b));
  const nf = (n) => Number(n || 0).toLocaleString('fr-CA');
  const blocs = codes.map((code) => {
    const p = passe[code] || { total: 0 };
    const c = pp[code];
    return [
      `${code} · ${heureLocale(code)} — ${nf(p.total)} envoyé(s)`,
      p.total ? `   ${CATS.map(([k, lib]) => `${lib} ${nf(p[k])}`).join(' · ')}` : '',
      c ? `   cycle : ${nf(c.servis)} envoyés · reste ${nf(c.total - c.servis)}` : '',
    ].filter(Boolean).join('\n');
  });
  const alertes = [
    report.passagesMorts?.length ? `⚠️ Passage(s) mort(s) aujourd'hui : ${report.passagesMorts.join(', ')}` : '',
    report.sante?.stopOutreach ? `⚠️ Prospection arrêtée : ${report.sante.stopOutreach}` : '',
    report.failed ? `⚠️ ${report.failed} raté(s), ils repasseront :\n${report.errors.slice(0, 20).join('\n')}` : '',
  ].filter(Boolean);
  const L = [
    ...alertes, alertes.length ? '' : null,
    `Ce passage : ${nf(report.sent)} envoyé(s)`,
    '',
    blocs.join('\n\n'),
  ].filter((x) => x !== null);
  const resumeSujet = codes.filter((c) => passe[c]?.total).map((c) => `${c} ${passe[c].total}`).join(' · ');
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
      to: [REPORT_TO],
      subject: `Bulletin — ${report.sent} envoyés${resumeSujet ? ` (${resumeSujet})` : ''}${report.failed ? `, ${report.failed} ratés` : ''}`,
      text: L.join('\n'),
    }),
  }).catch(() => { /* le récap n'est jamais bloquant */ });
}

async function handleSubscribe(request, env, url) {
  let email = '', ville = '', honeypot = '';
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('json')) {
    const b = await request.json().catch(() => ({}));
    email = b.email; ville = b.ville; honeypot = b.website;
  } else {
    const f = await request.formData().catch(() => null);
    if (f) { email = f.get('email'); ville = f.get('ville'); honeypot = f.get('website'); }
  }
  email = String(email ?? '').trim().toLowerCase();
  ville = strip(ville);
  const frGuess = true;
  if (honeypot) return subPage('fr', 'Merci', 'Inscription reçue.'); // robot : on sourit, on ignore
  if (!EMAIL_RE.test(email) || !ville) {
    return subPage('fr', 'Oups', "Courriel ou ville manquant — réessayez depuis la page de la ville. / Missing email or city — please retry from the city page.");
  }
  const market = await feed('/api/market.json');
  const city = market.cities.find((c) => strip(c.slug) === ville || strip(c.name) === ville);
  if (!city) return subPage('fr', 'Oups', `Ville inconnue : ${ville}. / Unknown city.`);
  const lang = city.province === 'QC' ? 'fr' : 'en';
  const fr = lang === 'fr';
  const cityUrl = `${SITE}/`;

  const key = `s:${city.slug}:${email}`;
  if (env.SUBSCRIBERS && (await env.SUBSCRIBERS.get(key))) {
    return subPage(lang, fr ? 'Déjà abonné !' : 'Already subscribed!', fr ? `Vous recevez déjà le bulletin de ${city.name}.` : `You already receive the ${city.name} bulletin.`, cityUrl);
  }
  const day = new Date().toISOString().slice(0, 10);
  const n = await bumpCounter(env, `sub:${day}`, 3 * 86400);
  if (n > SUB_CAP_DAY) return subPage(lang, fr ? 'Un instant' : 'One moment', fr ? 'Trop d’inscriptions aujourd’hui — réessayez demain.' : 'Too many sign-ups today — please try again tomorrow.', cityUrl);

  if (env.SUBSCRIBERS) {
    await env.SUBSCRIBERS.put(key, JSON.stringify({ email, city: city.slug, lang, consent: new Date().toISOString(), source: 'form-ville' }));
  }
  if (env.RESEND_API_KEY) await sendBulletin(env, url.origin, email, city, lang, true);
  return subPage(lang,
    fr ? 'Abonné !' : 'Subscribed!',
    fr ? `Votre premier bulletin de ${city.name} vient de partir vers ${email}. Un courriel par mois, désabonnement en un clic.` : `Your first ${city.name} bulletin is on its way to ${email}. One email per month, one-click unsubscribe.`,
    cityUrl);
}

/* ════════════════════════════════════════════════════════════════════════════════
   ALERTE TAUX — le seul courriel que les gens DEMANDENT (2026-08-19)
   ════════════════════════════════════════════════════════════════════════════════

   POURQUOI CELUI-LÀ ET PAS UN AUTRE. Tout le reste des envois Payotte est poussé : le
   bulletin mensuel (opt-out), la prospection, la séquence. Leur rendement mesuré est
   mauvais — 0 réponse sur 550 en juillet, aucune sur ~80 brouillons le 18 août. Ce n'est
   pas un problème de gabarit, c'est un problème de demande : personne n'a rien demandé.

   L'alerte taux est l'inverse exact. Elle part QUAND la Banque du Canada bouge son taux
   directeur, à des gens qui ont coché une case pour ça. Huit annonces par an, et le taux
   ne change pas à chacune : en 2026, cinq réunions, un seul mouvement. On parle donc de
   deux à quatre courriels par an et par personne — le volume le plus faible du système,
   et le seul dont la pertinence est garantie par l'événement lui-même.

   LA MÉCANIQUE, EN TROIS FAITS.
   1. `taux:{courriel}` — un inscrit. Clé PLATE, pas par ville : le taux directeur est
      national. Quelqu'un abonné à trois villes reçoit UNE alerte, pas trois.
   2. `taux:dernier` — la dernière valeur CONNUE du taux directeur, avec sa date. C'est la
      mémoire qui permet de dire « ça a bougé ». Sans elle, chaque passage du cron
      renverrait la même annonce.
   3. Le déclenchement lit la Banque du Canada EN DIRECT (`macroCourant`), jamais un feed
      statique — c'est précisément le genre de courriel où être en retard d'une journée
      détruit la crédibilité.

   ⚠️ CE QU'ELLE NE FAIT PAS. Aucun commentaire, aucune prévision, aucun conseil. On
   annonce le chiffre, l'ancien, la date, et on renvoie à la page. Écrire « les fixes vont
   suivre » serait une prédiction — donc une donnée inventée (Règle #3), doublée d'un
   conseil financier que Payotte n'a pas qualité pour donner.

   ⚠️ ELLE RESPECTE `stop:all`. Le 19 août, Grégory a coupé tous les envois Resend. Une
   alerte est un envoi : elle s'arrête avec le reste. Le jour où le taux bouge alors que
   l'interrupteur est posé, le worker journalise le fait et met à jour `taux:dernier`
   SANS envoyer — sinon la levée de l'interrupteur déclencherait une annonce périmée.
   ════════════════════════════════════════════════════════════════════════════════ */

const ALERTE_TAUX_LOT = 100;   // taille de lot Resend

/** Rendu de l'alerte. Deux chiffres, une date, un lien. Rien de plus. */
/**
 * L'IMPACT LOCAL — ce qui rend ce courriel utile plutôt que poli.
 *
 * Un courtier hypothécaire sait déjà que le taux a bougé : il l'a appris à 9 h 46 par sa
 * propre veille. Lui réannoncer la nouvelle n'apporte rien. Ce qu'il n'a PAS sous la main
 * à 10 h, c'est le calcul appliqué à SA ville, prêt à être répété à un client dans l'heure.
 * C'est ça qu'on lui donne.
 *
 * ⚠️ CE QUI EST CALCULABLE, ET CE QUI NE L'EST PAS.
 * Le revenu requis à la qualification dépend du FIXE 5 ANS (règle du stress test), lequel
 * suit les obligations, pas le taux directeur. Le lier à une décision de la Banque du
 * Canada serait fabriquer une causalité — Règle #3. On ne le fait pas.
 *
 * Ce qui suit mécaniquement le taux directeur, c'est le TAUX PRÉFÉRENTIEL, donc les
 * hypothèques à taux VARIABLE (préférentiel moins escompte). C'est le seul calcul honnête,
 * et c'est aussi celui qui touche les clients qui appellent leur courtier le jour même.
 *
 * L'hypothèse — « si le préférentiel suit d'autant » — est ÉCRITE dans le courriel, en une
 * ligne. Ce n'est pas une prévision déguisée : c'est une arithmétique conditionnelle dont
 * la condition est visible. Un courtier sait juger cette hypothèse mieux que nous.
 */
function impactVariable({ ecartPct, prix }) {
  const ANS = 25, MISE = 0.20;
  // Taux de travail : on ne connaît pas l'escompte de chaque prêteur. On prend une valeur
  // ordinaire du marché variable et on affiche la DIFFÉRENCE, qui est très peu sensible au
  // niveau de départ — c'est le delta qui compte, pas le niveau.
  const base = 4.0;
  const par100k = (mensuel) => Math.round(mensuel);
  const calcul = (montant) => {
    const avant = montant * monthlyFactor(base, ANS);
    const apres = montant * monthlyFactor(base + ecartPct, ANS);
    return Math.abs(apres - avant);
  };
  const cent = par100k(calcul(100000));
  if (!prix || !(prix > 0)) return { cent, montant: null, mensuel: null, prix: null };
  const montant = Math.round(prix * (1 - MISE));
  return { cent, montant, mensuel: Math.round(calcul(montant)), prix };
}

function renderAlerteTaux({ nouveau, ancien, observed, lang, unsubUrl, postale = '',
                           segment = 'optin', nom = '', ville = '', prix = null,
                           prochaine = null, prochaineMpr = false }) {
  const fr = lang === 'fr';
  const L = fr ? 'fr-CA' : 'en-CA';
  // Deux décimales, toujours. « 2 % » pour un taux directeur fait négligé auprès de gens
  // dont c'est le métier ; « 2,00 % » est la convention de la Banque du Canada elle-même.
  const nb = (v) => v.toLocaleString(L, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const arg = (v) => (fr ? `${v.toLocaleString(L, { maximumFractionDigits: 0 })} $` : `$${v.toLocaleString(L, { maximumFractionDigits: 0 })}`);
  const pc = (v) => `${nb(v)}${fr ? ' %' : '%'}`;
  // Date en toutes lettres : « 2026-08-18 » dans un courriel fait sortie de machine.
  const jour = (iso) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ''))) return String(iso ?? '');
    const [a, m, j] = iso.split('-').map(Number);
    const mois = fr
      ? ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
      : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return fr ? `${j} ${mois[m - 1]} ${a}` : `${mois[m - 1]} ${j}, ${a}`;
  };

  // ⚠️ LE MAINTIEN EST UNE NOUVELLE (décision de Grégory, 19 août). Le taux directeur n'a
  // pas bougé depuis le 30 octobre 2025 : une alerte réservée aux CHANGEMENTS n'aurait rien
  // envoyé en dix mois. Un courtier veut savoir que c'est stable — et l'apprendre de Payotte
  // plutôt qu'ailleurs. On écrit donc à CHAQUE annonce, huit fois par an.
  const bouge = ancien != null && nouveau !== ancien;
  const sens = !bouge ? null : nouveau > ancien ? 'hausse' : 'baisse';
  const ecart = !bouge ? 0 : Math.round(Math.abs(nouveau - ancien) * 100);
  const baisse = sens === 'baisse';

  const titre = fr
    ? (!bouge ? `Taux directeur maintenu à ${pc(nouveau)}`
      : baisse ? `La Banque du Canada baisse son taux à ${pc(nouveau)}`
        : `La Banque du Canada monte son taux à ${pc(nouveau)}`)
    : (!bouge ? `Policy rate held at ${pc(nouveau)}`
      : baisse ? `Bank of Canada cuts its rate to ${pc(nouveau)}`
        : `Bank of Canada raises its rate to ${pc(nouveau)}`);

  const salut = nom
    ? `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#4a4446;">${fr ? 'Bonjour' : 'Hello'} ${esc(String(nom).split(' ')[0])},</p>`
    : '';

  const mouvement = bouge
    ? (fr
      ? `<p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#4a4446;">Le taux directeur passe de <strong>${pc(ancien)}</strong> à <strong>${pc(nouveau)}</strong> — ${ecart} points de base à la ${sens}, observation du ${jour(observed)}.</p>`
      : `<p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#4a4446;">The policy rate moves from <strong>${pc(ancien)}</strong> to <strong>${pc(nouveau)}</strong> — ${ecart} basis points ${baisse ? 'down' : 'up'}, observed ${jour(observed)}.</p>`)
    : (fr
      ? `<p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#4a4446;">Aucun changement : le taux directeur reste à <strong>${pc(nouveau)}</strong>, où il est depuis le 30 octobre 2025. Observation du ${jour(observed)}.</p>`
      : `<p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#4a4446;">No change: the policy rate stays at <strong>${pc(nouveau)}</strong>, where it has been since October 30, 2025. Observed ${jour(observed)}.</p>`);

  // ── Le bloc utile ───────────────────────────────────────────────────────────────
  const moins = baisse ? (fr ? 'de moins' : 'less') : (fr ? 'de plus' : 'more');
  let utile = '';
  if (bouge) {
    const imp = impactVariable({ ecartPct: nouveau - ancien, prix });
    const ligneVille = imp.montant
      ? (fr
        ? `<p style="margin:0 0 10px 0;font-size:15px;line-height:1.65;color:#211c1e;">À <strong>${esc(ville)}</strong>, la propriété de référence est à ${arg(imp.prix)}. Sur une hypothèque variable de ${arg(imp.montant)} (20 % de mise de fonds, 25 ans), cet écart de ${ecart} points de base représente environ <strong style="color:#C8102E;">${arg(imp.mensuel)} par mois ${moins}</strong>.</p>`
        : `<p style="margin:0 0 10px 0;font-size:15px;line-height:1.65;color:#211c1e;">In <strong>${esc(ville)}</strong>, the reference property sits at ${arg(imp.prix)}. On a ${arg(imp.montant)} variable mortgage (20% down, 25 years), those ${ecart} bps are roughly <strong style="color:#C8102E;">${arg(imp.mensuel)} a month ${moins}</strong>.</p>`)
      : '';
    utile = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf8f8;border:1px solid #f1ecec;border-left:3px solid #C8102E;border-radius:6px;margin:0 0 18px 0;">
        <tr><td style="padding:18px 20px;">
          <div style="font-size:10.5px;letter-spacing:1.3px;text-transform:uppercase;color:#a49c9e;margin-bottom:10px;">${fr ? 'Ce que ça change sur un taux variable' : 'What it changes on a variable rate'}</div>
          ${ligneVille}
          <p style="margin:0;font-size:14px;line-height:1.6;color:#6f6769;">${fr
            ? `Par tranche de 100 000 $ d’hypothèque : environ <strong>${arg(imp.cent)} par mois ${moins}</strong>. Calcul valable si le taux préférentiel suit d’autant.`
            : `Per $100,000 of mortgage: about <strong>${arg(imp.cent)} a month ${moins}</strong>. Holds if prime moves by the same amount.`}</p>
        </td></tr>
      </table>`;
  } else {
    // Un maintien a sa propre utilité : c'est ce que le courtier va répondre aujourd'hui
    // aux clients qui appellent. On le lui donne formulé, pas à déduire.
    utile = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf8f8;border:1px solid #f1ecec;border-left:3px solid #b9b2b3;border-radius:6px;margin:0 0 18px 0;">
        <tr><td style="padding:18px 20px;">
          <div style="font-size:10.5px;letter-spacing:1.3px;text-transform:uppercase;color:#a49c9e;margin-bottom:10px;">${fr ? 'Pour vos clients' : 'For your clients'}</div>
          <p style="margin:0;font-size:15px;line-height:1.65;color:#211c1e;">${fr
            ? `Rien ne bouge sur les taux variables aujourd’hui${ville ? ` à ${esc(ville)}` : ''} : le préférentiel suit le taux directeur, et le taux directeur ne change pas.${prochaine ? ` La prochaine fenêtre est le <strong>${jour(prochaine)}</strong>.` : ''}`
            : `Nothing moves on variable rates today${ville ? ` in ${esc(ville)}` : ''}: prime follows the policy rate, and the policy rate is unchanged.${prochaine ? ` The next window is <strong>${jour(prochaine)}</strong>.` : ''}`}</p>
        </td></tr>
      </table>`;
  }

  // ── Le bas du courriel : la prochaine annonce ───────────────────────────────────
  const suite = prochaine ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #f1ecec;margin:4px 0 0 0;">
        <tr><td style="padding:16px 0 0 0;">
          <span style="font-size:10.5px;letter-spacing:1.3px;text-transform:uppercase;color:#a49c9e;">${fr ? 'Prochaine annonce' : 'Next announcement'}</span><br>
          <span style="font-size:16px;color:#211c1e;font-weight:bold;">${jour(prochaine)}</span>
          <span style="font-size:12px;color:#8a8284;"> &middot; ${fr ? '9 h 45, heure de l’Est' : '9:45 a.m. ET'}${prochaineMpr ? (fr ? ' &middot; avec le Rapport sur la politique monétaire' : ' &middot; with the Monetary Policy Report') : ''}</span>
          <div style="font-size:13px;line-height:1.55;color:#6f6769;margin-top:7px;">${fr
            ? 'Vous recevrez cette alerte ce matin-là, qu’il y ait mouvement ou non.'
            : 'You will get this alert that morning, whether or not the rate moves.'}</div>
        </td></tr>
      </table>` : '';

  const corps = `
    <tr><td style="padding:26px 32px 22px 32px;border-bottom:1px solid #f1ecec;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle"><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td>
        <td align="right" valign="middle" style="font-size:11px;letter-spacing:.5px;color:#9a9294;">${fr ? 'ALERTE TAUX' : 'RATE ALERT'}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:30px 32px 0 32px;">
      <h1 style="margin:0 0 16px 0;font-size:23px;line-height:1.3;color:#211c1e;font-weight:normal;">${titre}</h1>
      ${salut}${mouvement}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf8f8;border:1px solid #f1ecec;border-radius:6px;margin:0 0 18px 0;">
        <tr><td style="padding:16px 20px;">
          <span style="font-size:13px;color:#8a8284;">${fr ? 'Taux directeur' : 'Policy interest rate'}</span><br>
          <span style="font-size:28px;color:#C8102E;font-weight:bold;">${pc(nouveau)}</span>
          <span style="font-size:11px;color:#a49c9e;"> &middot; ${jour(observed)}</span>
        </td></tr>
      </table>
      ${utile}
      <p style="margin:0 0 4px 0;font-size:14px;line-height:1.65;">
        <a href="${SITE}${fr ? '/taux-directeur-canada' : '/en/canada-policy-rate'}" style="color:#C8102E;font-weight:bold;">${fr ? 'Tous les taux à jour, et l’historique des décisions →' : 'All current rates, and the decision history →'}</a>
      </p>
      ${suite}
      <div style="height:22px"></div>
    </td></tr>`;

  // ⚠️ LE MOTIF DOIT ÊTRE VRAI, ET SUFFIRE. « parce que vous êtes courtier hypothécaire »
  // n'est pas une formule de politesse : c'est le test même de la LCAP pour le consentement
  // tacite — l'adresse professionnelle est publiée en évidence ET le message est pertinent
  // à la fonction. Mentionner un « abonnement » brouillait ce fondement au lieu de l'énoncer.
  const MOTIFS = {
    optin: [
      'Vous recevez cette alerte parce que vous l’avez demandée sur payotte.com.',
      'You receive this alert because you asked for it on payotte.com.',
    ],
    pro: [
      'Vous recevez cette alerte parce que vous êtes courtier hypothécaire. Payotte l’envoie à chaque annonce de la Banque du Canada — huit fois par an, jamais plus.',
      'You receive this alert because you are a mortgage broker. Payotte sends it at every Bank of Canada announcement — eight times a year, never more.',
    ],
  };
  const motif = `${(segment === 'optin' ? MOTIFS.optin : MOTIFS.pro)[fr ? 0 : 1]} ${BOC_ATTRIBUTION}`;
  const pied = FOOT(motif, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe', postale, fr);

  const html = `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${corps}${pied}</table></div>`;
  return { subject: titre, html };
}

/**
 * L'inscription. Deux chemins, un seul enregistrement :
 *   POST /alerte-taux  {email, lang}            — depuis un formulaire du site
 *   GET  /alerte-taux?e={courriel}&t={hmac}     — un clic depuis le bulletin
 * L'HMAC du lien empêche d'inscrire quelqu'un d'autre en devinant l'URL.
 */
async function handleAlerteTauxInscription(request, env, url) {
  let email = '', lang = 'fr', honeypot = '';
  if (request.method === 'GET') {
    email = String(url.searchParams.get('e') ?? '').trim().toLowerCase();
    lang = url.searchParams.get('l') === 'en' ? 'en' : 'fr';
    const t = url.searchParams.get('t') ?? '';
    if (!email || t !== (await hmacHex(env, `a:${email}`))) {
      return subPage(lang, 'Lien invalide / Invalid link', 'Ce lien d’inscription est invalide. / This sign-up link is invalid.');
    }
  } else {
    const ct = request.headers.get('Content-Type') || '';
    if (ct.includes('json')) {
      const b = await request.json().catch(() => ({}));
      email = b.email; lang = b.lang; honeypot = b.website;
    } else {
      const f = await request.formData().catch(() => null);
      if (f) { email = f.get('email'); lang = f.get('lang'); honeypot = f.get('website'); }
    }
    email = String(email ?? '').trim().toLowerCase();
    lang = String(lang ?? '') === 'en' ? 'en' : 'fr';
    if (honeypot) return subPage(lang, 'Merci', 'Inscription reçue.');   // robot
  }
  const fr = lang === 'fr';
  if (!EMAIL_RE.test(email)) return subPage(lang, fr ? 'Oups' : 'Oops', fr ? 'Adresse manquante ou invalide.' : 'Missing or invalid address.');

  if (env.SUBSCRIBERS) {
    // Un désabonnement antérieur est DÉFINITIF (LCAP art. 11) — sauf si la personne
    // revient d'elle-même s'inscrire, ce qui est exactement ce qui se passe ici. On lève
    // donc la pierre tombale plutôt que de refuser en silence : refuser sans le dire
    // laisserait quelqu'un croire qu'il est inscrit alors qu'il ne l'est pas.
    await env.SUBSCRIBERS.delete(`unsub:taux:${email}`);
    if (await env.SUBSCRIBERS.get(`bounce:${email}`)) {
      return subPage(lang, fr ? 'Adresse en rebond' : 'Address bouncing',
        fr ? 'Nos envois vers cette adresse reviennent en erreur. Écrivez-nous et on règle ça.' : 'Our emails to this address bounce. Write to us and we will fix it.');
    }
    const day = new Date().toISOString().slice(0, 10);
    const n = await bumpCounter(env, `alerte:${day}`, 3 * 86400);
    if (n > SUB_CAP_DAY) return subPage(lang, fr ? 'Un instant' : 'One moment', fr ? 'Trop d’inscriptions aujourd’hui — réessayez demain.' : 'Too many sign-ups today — please try again tomorrow.');
    await env.SUBSCRIBERS.put(`taux:${email}`, JSON.stringify({ email, lang, since: new Date().toISOString(), source: request.method === 'GET' ? 'bulletin' : 'form' }));
  }
  return subPage(lang, fr ? 'C’est noté !' : 'You’re in!',
    fr ? 'Vous recevrez une alerte le jour où la Banque du Canada change son taux directeur — deux à quatre fois par an, jamais plus. Désabonnement en un clic dans chaque envoi.'
      : 'You will get an alert the day the Bank of Canada changes its policy rate — two to four times a year, never more. One-click unsubscribe in every email.');
}

/**
 * Le déclencheur, appelé à chaque passage du cron. Coût quand rien ne bouge : une lecture
 * KV et une lecture Valet (mise en cache 1 h par Cloudflare) — c'est le cas 361 jours sur 365.
 */
const METIER_ALERTE = 'mortgage-broker';

/**
 * runAlerteTaux — la seule chaîne d'envoi de Payotte déclenchée par un ÉVÉNEMENT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * QUAND
 * ─────────────────────────────────────────────────────────────────────────────────
 * Uniquement quand le TAUX DIRECTEUR change de valeur. Pas les obligations (elles bougent
 * tous les jours), pas les moyennes hypothécaires (mensuelles, publiées avec deux mois de
 * retard). Le taux directeur ne bouge que sur décision : 8 annonces par an, et il ne change
 * pas à chacune — en 2026, cinq réunions et un seul mouvement.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * TOUT LE MONDE EN MÊME TEMPS (décision de Grégory, 19 août)
 * ─────────────────────────────────────────────────────────────────────────────────
 * Une version antérieure servait province par province, à 9 h locale. Abandonné : la
 * Banque du Canada annonce à 9 h 45 HE, donc « 9 h locale » était déjà impossible pour le
 * Québec et l'Ontario, et étaler sur trois heures un courriel dont la valeur EST son
 * immédiateté n'avait aucun sens. Une décision de taux n'est pas un bulletin mensuel :
 * elle vaut à 10 h et beaucoup moins à 13 h. Tout part au premier passage qui suit
 * l'annonce, d'un bloc, ~455 courriels en cinq lots Resend.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * À QUI
 * ─────────────────────────────────────────────────────────────────────────────────
 *   1. les inscrits `taux:` — ils ont coché une case ;
 *   2. les COURTIERS HYPOTHÉCAIRES de l'annuaire (~130) ;
 *   3. les COURTIERS HYPOTHÉCAIRES de l'infolettre (~325 sur 2 404).
 *
 * ⚠️ Le filtre par métier est le cœur de la décision. Une décision de la Banque du Canada
 * est LA nouvelle du métier d'un courtier hypothécaire ; pour un inspecteur ou un notaire,
 * c'est du bruit. Envoyer aux 2 404 aurait été du volume — exactement ce qui a donné
 * 0 réponse sur 550 en juillet.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * REPRISE APRÈS ÉCHEC
 * ─────────────────────────────────────────────────────────────────────────────────
 * `taux:dernier` n'est mis à jour qu'une fois l'envoi terminé : tant qu'il porte l'ancienne
 * valeur, chaque passage du cron redétecte le changement. `taux:vague.faits[]` retient les
 * adresses déjà servies, pour qu'une reprise n'envoie jamais deux fois la même alerte.
 *
 * ⚠️ `stop:all` posé → on enregistre le mouvement et on N'ENVOIE PAS, mais on met quand même
 * `taux:dernier` à jour. Ne pas le faire ferait partir l'alerte au moment où l'interrupteur
 * est levé — c'est-à-dire annoncer comme une nouvelle un changement vieux de plusieurs jours.
 */
async function runAlerteTaux(env, { at = new Date(), dryRun = false } = {}) {
  const r = { change: false, envoyes: 0, rates: 0, audience: 0, parSegment: {} };
  if (!env.SUBSCRIBERS) return r;

  const macro = await macroCourant();
  const p = macro?.rates?.policyRate;
  if (p?.percent == null) return { ...r, note: 'taux directeur illisible' };

  // ── LE DÉCLENCHEUR : LE CALENDRIER, PAS LA VALEUR (changé le 19 août) ──────────
  // Version précédente : n'envoyer QUE si le taux avait changé. Vérification faite, cette
  // règle n'aurait envoyé AUCUN courriel depuis le 30 octobre 2025 — dix mois de silence,
  // trois maintiens d'affilée. Or un maintien est une information : le courtier veut savoir
  // que c'est stable, et l'apprendre de Payotte plutôt qu'ailleurs.
  // On écrit donc à chaque annonce programmée de la Banque du Canada : huit fois par an.
  const annonces = [
    ...(macro?.decisions ?? []).map((x) => ({ date: x.date, mpr: !!x.mpr })),
    ...(macro?.aVenir ?? []),
  ].filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x.date ?? '')));

  // Jour et heure de l'Est : l'annonce tombe à 9 h 45 HE. Avant, il n'y a rien à dire.
  const dateEst = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const heureEst = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(at));
  const aujourdhuiAnnonce = annonces.find((x) => x.date === dateEst);
  const prochaine = annonces.filter((x) => x.date > dateEst).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;

  let memoire = null;
  try { memoire = JSON.parse((await env.SUBSCRIBERS.get('taux:dernier')) || 'null'); } catch { /* clé abîmée */ }
  const ancienTaux = memoire?.percent ?? null;

  Object.assign(r, { jourEst: dateEst, annonce: Boolean(aujourdhuiAnnonce), nouveau: p.percent, ancien: ancienTaux, observed: p.observed, prochaine: prochaine?.date ?? null });

  // Pas un jour d'annonce : on tient seulement `taux:dernier` à jour, en silence. C'est le
  // cas 357 jours sur 365, et ça ne coûte qu'une écriture KV.
  if (!aujourdhuiAnnonce) {
    if (!dryRun && ancienTaux !== p.percent) {
      await env.SUBSCRIBERS.put('taux:dernier', JSON.stringify({ percent: p.percent, observed: p.observed, depuis: at.toISOString(), horsAnnonce: true }));
    }
    return { ...r, note: dateEst + ' — pas une date d’annonce' };
  }
  // Jour d'annonce mais avant 9 h 45 HE : la décision n'existe pas encore.
  if (heureEst < 10 && !dryRun) return { ...r, note: 'annonce du jour pas encore publiée (9 h 45 HE)' };

  // ⚠️ LE GARDE-FOU QUI COMPTE, ET IL N'EST PAS HORAIRE MAIS FACTUEL.
  //
  // L'heure ne prouve rien : la Banque du Canada annonce à 9 h 45, mais son API (Valet) ne
  // publie pas forcément l'observation du jour à cette minute-là. Vérifié le 19 août à 13 h :
  // la dernière observation disponible était celle de la VEILLE.
  //
  // Envoyer sur la seule foi de l'heure produirait le pire message possible : « Taux directeur
  // maintenu à 2,25 % » un matin où la Banque vient de le baisser — parce qu'on aurait lu une
  // valeur d'hier en croyant lire celle d'aujourd'hui. À 455 courtiers hypothécaires, dont
  // c'est le métier. Une seule fois suffirait à ruiner la crédibilité de l'alerte.
  //
  // On exige donc que l'observation PORTE LA DATE DE L'ANNONCE. Tant qu'elle ne l'a pas, on
  // ne sait rien et on se tait — quitte à envoyer au passage suivant, ou le lendemain matin.
  // Un retard est réparable ; une fausse annonce, non.
  if (String(p.observed ?? '') < dateEst && !dryRun) {
    return { ...r, note: `Banque du Canada pas encore publiée pour le ${dateEst} (dernière observation : ${p.observed ?? '—'}) — on attend` };
  }

  // Déjà envoyé pour CETTE annonce ? La clé survit 60 jours, bien au-delà de l'écart entre
  // deux annonces : c'est ce qui empêche sept passages de cron d'envoyer sept fois.
  const dejaFait = await env.SUBSCRIBERS.get(`taux:annonce:${dateEst}`);
  if (dejaFait && !dryRun) return { ...r, note: `annonce du ${dateEst} déjà servie (${dejaFait})` };

  r.change = ancienTaux != null && ancienTaux !== p.percent;

  // ⚠️ En DRY-RUN on ne s'arrête pas ici. Une répétition doit montrer ce qui PARTIRAIT —
  // sinon, tant que l'interrupteur est posé, il devient impossible de vérifier l'audience,
  // c'est-à-dire précisément la chose qu'on veut contrôler avant de le lever.
  const stop = await env.SUBSCRIBERS.get('stop:all');
  if (stop && !dryRun) {
    // On MARQUE quand même l'annonce comme traitée. Sans ça, lever l'interrupteur des
    // semaines plus tard ferait partir une alerte sur une annonce périmée.
    await env.SUBSCRIBERS.put('taux:dernier', JSON.stringify({ percent: p.percent, observed: p.observed, depuis: at.toISOString(), nonEnvoye: `stop:all ${stop}` }));
    await env.SUBSCRIBERS.put(`taux:annonce:${dateEst}`, `non envoyée — stop:all`, { expirationTtl: 60 * 86400 });
    await env.SUBSCRIBERS.delete('taux:vague');
    return { ...r, arrete: 'stop:all', note: 'annonce enregistrée, aucune alerte envoyée' };
  }
  if (stop) r.arrete = 'stop:all';

  let vague = null;
  try { vague = JSON.parse((await env.SUBSCRIBERS.get('taux:vague')) || 'null'); } catch { /* clé abîmée */ }
  if (!vague || vague.annonce !== dateEst) vague = { annonce: dateEst, percent: p.percent, debut: at.toISOString(), faits: [], envoyes: 0, rates: 0 };
  const faits = new Set(vague.faits ?? []);

  // ── LIRE LES EXCLUSIONS EN BLOC, PAS UNE PAR UNE (leçon du 13 août) ─────────────
  // Le 13 août, AUCUN bulletin n'est parti : le passage lisait la valeur des 1 512
  // prospects EN SÉRIE et dépassait son temps d'exécution, en silence. La première
  // version de cette fonction refaisait la même faute — deux `get` par destinataire.
  // Trois `list()` remplacent ~900 allers-retours.
  const [tombes, rebonds, unsubExperts, unsubProspects] = await Promise.all([
    kvKeys(env.SUBSCRIBERS, 'unsub:taux:'),
    kvKeys(env.SUBSCRIBERS, 'bounce:'),
    kvKeys(env.SUBSCRIBERS, 'unsub:'),
    kvKeys(env.SUBSCRIBERS, 'unsub:prospect:'),
  ]).then((x) => x.map((y) => new Set(y)));

  // Prix de référence par ville, pour le bloc « ce que ça change sur un variable ».
  let villes = {};
  try {
    const market = await feed('/api/market.json');
    villes = Object.fromEntries((market.cities || []).map((c) => [c.slug, { nom: c.name, prix: refPriceOf(c) }]));
  } catch { /* sans market.json le bloc local disparaît, le courriel part quand même */ }

  const postale = adressePostale(env);
  const file = [];
  const vus = new Set();

  const ajouter = async (email, lang, { segment = 'optin', nom = '', citySlug = '' } = {}) => {
    const e = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || vus.has(e)) return;
    if (tombes.has(e) || rebonds.has(e) || unsubProspects.has(e)) return;
    vus.add(e);
    if (faits.has(e)) return;                       // déjà servi lors d'un passage précédent
    const v = villes[citySlug] ?? null;
    const unsubUrl = `${WORKER_ORIGIN}/unsubscribe?a=taux&e=${encodeURIComponent(e)}&t=${await hmacHex(env, `a:${e}`)}`;
    const { subject, html } = renderAlerteTaux({
      nouveau: p.percent, ancien: ancienTaux, observed: p.observed,
      lang: lang === 'en' ? 'en' : 'fr', unsubUrl, postale,
      segment, nom, ville: v?.nom ?? '', prix: v?.prix ?? null,
      prochaine: prochaine?.date ?? null, prochaineMpr: !!prochaine?.mpr,
    });
    file.push({ to: e, subject, html, unsubUrl, segment, flux: 'alerte-taux' });
    r.parSegment[segment] = (r.parSegment[segment] || 0) + 1;
  };

  // Lecture parallèle par paquets : en série, 2 404 fiches font expirer l'exécution.
  const lireEnLot = async (cles, taille = 50) => {
    const out = [];
    for (let i = 0; i < cles.length; i += taille) {
      out.push(...await Promise.all(cles.slice(i, i + taille).map(async (c) => {
        try { return JSON.parse((await env.SUBSCRIBERS.get(c)) ?? 'null'); } catch { return null; }
      })));
    }
    return out;
  };

  // 1. Les inscrits volontaires.
  const clesOpt = (await kvKeys(env.SUBSCRIBERS, 'taux:')).filter((c) => c !== 'dernier' && c !== 'vague');
  const recsOpt = await lireEnLot(clesOpt.map((c) => `taux:${c}`));
  for (let i = 0; i < clesOpt.length; i++) {
    await ajouter(recsOpt[i]?.email ?? clesOpt[i], recsOpt[i]?.lang, { segment: 'optin' });
  }

  // 2. Les courtiers hypothécaires de l'annuaire, toutes provinces.
  let dir = {};
  if (env.CONTACTS_TOKEN) {
    try { dir = (await feed(`/api/cx/${env.CONTACTS_TOKEN}.json`)).contacts || {}; } catch { /* annuaire indispo : les prospects partent quand même */ }
  }
  // ⚠️ market.json porte les noms de villes en ANGLAIS (« Montreal », « Quebec City »).
  // Écrire « À Montreal » à un courtier de Montréal est le genre de détail qui fait
  // « envoi automatisé » à la première ligne. Les feeds d'experts, eux, portent le nom
  // localisé — on s'en sert pour corriger la table au passage.
  for (const slugProv of Object.values(PROV_SLUG)) {
    let experts = [];
    try { experts = (await feed(`/api/experts/${slugProv}.json`)).experts ?? []; } catch { continue; }
    for (const e of experts) {
      if (e.city && e.cityName && villes[e.city]) villes[e.city].nom = e.cityName;
    }
    for (const e of experts) {
      if (e.profession !== METIER_ALERTE) continue;
      if (e.score?.color === 'red' || !e.score?.color) continue;
      if (unsubExperts.has(e.slug)) continue;                     // opt-out expert existant
      const contact = dir[e.slug];
      if (contact?.email) {
        await ajouter(contact.email, contact.lang || e.lang, { segment: 'expert', nom: e.name || '', citySlug: e.city || '' });
      }
    }
  }

  // 3. Les courtiers hypothécaires de l'infolettre. La clé porte la ville (`s:{ville}:{courriel}`).
  const clesProsp = await kvKeys(env.SUBSCRIBERS, 's:');
  const recsProsp = await lireEnLot(clesProsp.map((c) => `s:${c}`));
  for (let i = 0; i < clesProsp.length; i++) {
    const rec = recsProsp[i];
    if (rec?.metier !== METIER_ALERTE) continue;                  // ⚠️ le filtre qui fait tout
    await ajouter(rec.email, rec.lang, { segment: 'prospect', nom: rec.nom || '', citySlug: clesProsp[i].slice(0, clesProsp[i].indexOf(':')) });
  }

  r.audience = file.length;
  if (dryRun) return { ...r, dryRun: true, apercu: file.slice(0, 3).map((f) => `${f.to} (${f.segment})`) };
  const clore = async () => {
    await env.SUBSCRIBERS.put('taux:dernier', JSON.stringify({ percent: p.percent, observed: p.observed, depuis: at.toISOString(), envoyes: vague.envoyes }));
    await env.SUBSCRIBERS.put(`taux:annonce:${dateEst}`, `${vague.envoyes} envoyée(s) — ${p.percent} %`, { expirationTtl: 60 * 86400 });
    await env.SUBSCRIBERS.delete('taux:vague');
  };

  if (!file.length) {
    await clore();
    return { ...r, vagueFinie: true, totalVague: vague.envoyes };
  }

  const from = env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>';
  for (let i = 0; i < file.length; i += ALERTE_TAUX_LOT) {
    const lot = file.slice(i, i + ALERTE_TAUX_LOT);
    const res = await sendPulseBatch(env, lot, { from });
    res.forEach((x, k) => {
      if (x?.ok) { r.envoyes++; faits.add(lot[k].to); } else r.rates++;
    });
    // On enregistre APRÈS CHAQUE LOT : si l'exécution meurt au 3e lot, les deux premiers
    // ne repartiront pas. Un doublon d'alerte est bien plus grave qu'un retard.
    vague.faits = [...faits]; vague.envoyes += 0;
    await env.SUBSCRIBERS.put('taux:vague', JSON.stringify(vague), { expirationTtl: 7 * 86400 });
  }
  vague.envoyes += r.envoyes;
  vague.rates += r.rates;

  // Vague close dès que tout ce qui était à servir a été tenté. Les ratés d'un lot
  // repartiront au passage suivant, puisqu'ils ne sont pas dans `faits`.
  if (!r.rates) {
    await clore();
    r.vagueFinie = true;
    r.totalVague = vague.envoyes;
  } else {
    await env.SUBSCRIBERS.put('taux:vague', JSON.stringify(vague), { expirationTtl: 7 * 86400 });
  }
  return r;
}

async function handleUnsubscribe(env, url) {
  const t = url.searchParams.get('t') ?? '';

  // Alerte taux : /unsubscribe?a=taux&e={courriel}&t={hmac}. Même règle que partout —
  // la pierre tombale `unsub:taux:` est DÉFINITIVE (LCAP art. 11) ; seule une réinscription
  // volontaire de la personne la lève (voir handleAlerteTauxInscription).
  if (url.searchParams.get('a') === 'taux') {
    const email = String(url.searchParams.get('e') ?? '').trim().toLowerCase();
    if (!email || t !== (await hmacHex(env, `a:${email}`))) {
      return subPage('fr', 'Lien invalide / Invalid link', 'Ce lien de désabonnement est invalide. / This unsubscribe link is invalid.');
    }
    if (env.SUBSCRIBERS) {
      await env.SUBSCRIBERS.put(`unsub:taux:${email}`, new Date().toISOString());
      await env.SUBSCRIBERS.delete(`taux:${email}`);
    }
    return subPage('fr', 'C\'est fait / Done', "Vous ne recevrez plus d'alerte de taux. Vos autres abonnements Payotte, s'il y en a, ne sont pas touchés. / You will receive no further rate alerts. Your other Payotte subscriptions, if any, are unaffected.");
  }

  // Expert : /unsubscribe?x={slug}&t={hmac}. Un clic, aucune question posée — c'est le seul
  // moyen de sortir de l'envoi mensuel (opt-out), et la clé posée est définitive.
  const slug = String(url.searchParams.get('x') ?? '');
  if (slug) {
    if (t !== (await hmacHex(env, `x:${slug}`))) return subPage('fr', 'Lien invalide / Invalid link', 'Ce lien de désabonnement est invalide. / This unsubscribe link is invalid.');
    if (env.SUBSCRIBERS) await env.SUBSCRIBERS.put(`unsub:${slug}`, new Date().toISOString());
    return subPage('fr', 'C\'est fait / Done', "Vous ne recevrez plus aucun courriel de Payotte. Votre fiche publique, elle, reste en ligne — elle ne dépend pas de ces envois. / You will receive no further email from Payotte. Your public profile stays online; it does not depend on these emails.");
  }

  const email = String(url.searchParams.get('e') ?? '').trim().toLowerCase();
  const ville = String(url.searchParams.get('c') ?? '');
  const expect = await hmacHex(env, `u:${email}:${ville}`);
  if (!email || !ville || t !== expect) return subPage('fr', 'Lien invalide', 'Ce lien de désabonnement est invalide ou expiré. / Invalid unsubscribe link.');
  if (env.SUBSCRIBERS) {
    // ── LE DÉSABONNEMENT DOIT ÊTRE MÉMORISÉ (corrigé le 2026-08-19) ────────────────
    // BUG : on supprimait la clé `s:` et rien d'autre. Or la récolte nocturne reverse
    // chaque nuit ce qu'elle trouve, et `verser-prospects.mjs` ne comparait qu'aux clés
    // VIVANTES : une adresse désabonnée redevenait donc « inconnue » dès la suppression,
    // et repartait au premier versement suivant. MESURÉ : 15 re-versements en 10 jours,
    // dont `carly@movewithmichael.ca` versée les 12, 15 ET 17 août.
    //
    // C'est la plainte type sous la LCAP (art. 11) : un désabonnement doit être honoré
    // sous 10 jours ouvrables et le rester. « Supprimer » n'est pas « se souvenir » —
    // il faut une TOMBE, pas une absence.
    //
    // La clé est posée par COURRIEL, pas par ville : la même personne peut être inscrite
    // sur deux villes, et elle a dit non à Payotte, pas à une ville.
    // Éternelle, sans TTL : un désabonnement ne se périme jamais.
    await env.SUBSCRIBERS.put(`unsub:prospect:${email}`, JSON.stringify({
      jour: new Date().toISOString().slice(0, 10), ville, motif: 'lien de désabonnement',
    }));
    await env.SUBSCRIBERS.delete(`s:${ville}:${email}`);
  }
  // Bulletin provincial : la « ville » est `prov-{province}` — on affiche la province, pas le slug.
  const nomBulletin = ville.startsWith('prov-') ? (PROV_NOMS[ville.slice(5)]?.[0] ?? ville) : ville;
  return subPage('fr', 'Désabonné / Unsubscribed', `${email} ne recevra plus le bulletin de ${nomBulletin}. / will no longer receive this bulletin.`);
}


// ═══════════════════════════════════════════════════════════════════════════════
// INDICE IA — audit public de lisibilité d'un site par les moteurs de réponse.
//
// Port du barème de `scripts/ai-readiness.mjs` (dépôt payotte-astro). MÊME barème,
// mêmes seuils, mêmes pièges corrigés — un score rendu ici doit être identique à
// celui du CLI, sinon l'étude publiée et l'outil se contrediraient en public.
//
//   30 ACCÈS · 25 STRUCTURE · 20 AEO · 15 ANCRAGE · 10 TECHNIQUE
//
// ⚠️ DEUX DIVERGENCES ASSUMÉES AVEC LE CLI, et elles portent toutes deux sur TLS.
//
//  1. Le CLI lit la date d'expiration du certificat via `openssl`. Un Worker n'a pas
//     de sous-processus. Ici, la validité TLS est DÉDUITE : Cloudflare valide le
//     certificat avant de rendre la réponse, donc un `fetch` HTTPS réussi prouve un
//     certificat valide aujourd'hui. Les 4 points sont accordés, mais `certExpire`
//     sort `null` — on ne devine pas une date qu'on n'a pas lue.
//
//  2. Le CLI rejoue la requête sans validation TLS pour auditer quand même un site
//     à certificat expiré (correctif du 2026-08-17). Un Worker ne peut pas désactiver
//     la validation. Un tel site sort donc `joignable: false` avec le motif `tls`,
//     JAMAIS un score de 0 — un trou reste un trou, il ne devient pas une note.
//
// ⚠️ L'UA EST HONNÊTE, ET ÇA COÛTE. On s'annonce `PayotteAudit/1.0`. Des pare-feux
// (Cloudflare, Wordfence) renvoient 403 à tout agent inconnu tout en servant GPTBot
// et ClaudeBot — chrisallard.ca le fait, constaté le 2026-08-21. On rend alors l'état
// `bloque`, pas un score : on ne se déguise pas en robot d'IA pour entrer.
// ═══════════════════════════════════════════════════════════════════════════════

// ⚠️ ASCII PUR, sans accent (2026-08-28). Le « é » de « lisibilité » forçait Cloudflare à
// encoder l'en-tête en UTF-8 et à le signaler à CHAQUE audit ; un serveur strict peut
// rejeter la requête, et le site sortirait alors « injoignable » alors qu'il va très bien.
const II_UA = 'PayotteAudit/1.0 (+https://payotte.com; audit de lisibilite IA)';
const II_TIMEOUT = 10_000;
const II_MAX_HTML = 3_000_000;   // 3 Mo : au-delà, on tronque plutôt que d'exploser la mémoire

const II_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Claude-Web',
                 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'CCBot', 'Applebot-Extended', 'meta-externalagent'];

/** Récupère une URL. Ne lève jamais. */
async function iiGet(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), II_TIMEOUT);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': II_UA } });
    const brut = await r.text();
    return { ok: true, status: r.status, body: brut.slice(0, II_MAX_HTML), headers: r.headers, url: r.url };
  } catch (e) {
    const detail = [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' | ');
    return { ok: false, status: 0, body: '', headers: new Headers(), erreur: String(detail || e) };
  } finally { clearTimeout(t); }
}

/**
 * Le fichier existe-t-il VRAIMENT ? (correctif « soft 404 » du 2026-08-17 : la plupart
 * des hébergeurs répondent 200 + page d'accueil HTML au lieu d'un 404.)
 */
function iiFichierReel(rep, { xml = false } = {}) {
  if (!rep.ok || rep.status !== 200) return false;
  const ct = (rep.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('text/html')) return false;
  const debut = rep.body.slice(0, 400).trim().toLowerCase();
  if (debut.startsWith('<!doctype html') || debut.startsWith('<html') || debut.includes('<head')) return false;
  if (xml) return debut.startsWith('<?xml') || debut.includes('<urlset') || debut.includes('<sitemapindex');
  return rep.body.trim().length > 0;
}

/** Texte visible SANS exécuter le JS — le test qui décide de tout. */
function iiMotsSansJs(html) {
  const sansCode = html.replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, '');
  const txt = sansCode.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return txt ? txt.split(' ').length : 0;
}

/** Tous les blocs JSON-LD, aplatis (@graph compris). */
function iiJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d; try { d = JSON.parse(m[1]); } catch { continue; }
    for (const o of (Array.isArray(d) ? d : [d])) {
      for (const n of (o && o['@graph'] ? o['@graph'] : [o])) if (n && typeof n === 'object') out.push(n);
    }
  }
  return out;
}
const iiType = (n, t) => String(n['@type'] ?? '').includes(t);

/** robots.txt → verdict par robot d'IA. */
function iiRobots(txt) {
  if (txt == null) return { presence: false, verdicts: {}, bloques: [], nommes: [], toutBloque: false };
  const blocs = []; let courant = null;
  for (const ligne of txt.split('\n')) {
    const l = ligne.replace(/#.*/, '').trim();
    if (!l) continue;
    const ua = l.match(/^user-agent\s*:\s*(.+)$/i);
    if (ua) {
      if (!courant || courant.regles.length) { courant = { agents: [], regles: [] }; blocs.push(courant); }
      courant.agents.push(ua[1].trim().toLowerCase());
      continue;
    }
    const rg = l.match(/^(allow|disallow)\s*:\s*(.*)$/i);
    if (rg && courant) courant.regles.push({ type: rg[1].toLowerCase(), chemin: rg[2].trim() });
  }
  const verdictPour = (bot) => {
    const b = blocs.find((x) => x.agents.includes(bot.toLowerCase()));
    const etoile = blocs.find((x) => x.agents.includes('*'));
    const cible = b ?? etoile;
    if (!cible) return 'non mentionné';
    const bloqueRacine = cible.regles.some((r) => r.type === 'disallow' && (r.chemin === '/' || r.chemin === ''));
    const disallowRacine = cible.regles.some((r) => r.type === 'disallow' && r.chemin === '/');
    if (disallowRacine) return 'bloqué';
    return b ? 'autorisé' : (bloqueRacine ? 'bloqué' : 'autorisé');
  };
  const verdicts = Object.fromEntries(II_BOTS.map((b) => [b, verdictPour(b)]));
  return {
    presence: true, verdicts,
    bloques: II_BOTS.filter((b) => verdicts[b] === 'bloqué'),
    nommes: II_BOTS.filter((b) => blocs.some((x) => x.agents.includes(b.toLowerCase()))),
    toutBloque: II_BOTS.every((b) => verdicts[b] === 'bloqué'),
  };
}

/**
 * Normalise et VALIDE la cible. Rend { hote, base } ou { erreur }.
 * Refuse tout ce qui n'est pas un nom d'hôte public : pas d'IP, pas de localhost,
 * pas de TLD interne, pas d'autre schéma que http(s). Sans ce filtre, un endpoint
 * public qui va chercher l'URL qu'on lui donne est un proxy pour réseau interne.
 */
function iiCible(saisie) {
  let s = String(saisie ?? '').trim().toLowerCase();
  if (!s) return { erreur: 'vide' };
  if (s.length > 253) return { erreur: 'trop long' };
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[:?#].*$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return { erreur: 'format' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return { erreur: 'ip' };
  const tld = s.split('.').pop();
  if (['local', 'localhost', 'internal', 'lan', 'home', 'test', 'invalid', 'example'].includes(tld)) return { erreur: 'interne' };
  return { hote: s, base: `https://${s}` };
}

/** L'audit. Même barème que le CLI, à la lettre. */
async function iiAuditer(saisie) {
  const c = iiCible(saisie);
  if (c.erreur) return { joignable: false, motif: 'domaine', detail: c.erreur, score: null };

  const page = await iiGet(c.base);

  if (!page.ok) {
    const tls = /certificate|CERT_|altname|SSL|TLS/i.test(page.erreur ?? '');
    return { hote: c.hote, joignable: false, score: null,
             motif: tls ? 'tls' : 'injoignable', detail: page.erreur ?? '' };
  }
  if (page.status === 403 || page.status === 401 || page.status === 451) {
    return { hote: c.hote, joignable: false, score: null, motif: 'bloque', status: page.status };
  }
  if (page.status >= 400) {
    return { hote: c.hote, joignable: false, score: null, motif: 'injoignable', detail: `HTTP ${page.status}` };
  }

  const racine = `https://${c.hote}`;
  const html = page.body;
  const [robotsRep, llmsRep, sitemapRep] = await Promise.all([
    iiGet(`${racine}/robots.txt`), iiGet(`${racine}/llms.txt`), iiGet(`${racine}/sitemap.xml`),
  ]);
  const rb = iiRobots(iiFichierReel(robotsRep) ? robotsRep.body : null);
  const nodes = iiJsonLd(html);
  const mots = iiMotsSansJs(html);
  const d = {};

  // ── ACCÈS (30) ──
  let acces = 0;
  d.robotsBloque = rb.bloques; d.robotsNommes = rb.nommes; d.robotsPresence = rb.presence;
  if (rb.toutBloque) acces += 0;
  else if (rb.bloques.length) acces += 6;
  else acces += rb.nommes.length ? 15 : 12;
  d.motsSansJs = mots;
  acces += mots >= 600 ? 15 : mots >= 250 ? 10 : mots >= 80 ? 4 : 0;
  d.contenuDependantJs = mots < 250;

  // ── STRUCTURE (25) ──
  let struct = 0;
  const aOrg = nodes.some((n) => iiType(n, 'Organization') || iiType(n, 'LocalBusiness') || iiType(n, 'ProfessionalService'));
  const aPersonne = nodes.some((n) => iiType(n, 'Person'));
  const sameAs = nodes.flatMap((n) => (Array.isArray(n.sameAs) ? n.sameAs : n.sameAs ? [n.sameAs] : []));
  d.typesJsonLd = [...new Set(nodes.map((n) => String(n['@type'])))];
  d.sameAs = sameAs.length;
  d.aOrganisation = aOrg;
  d.aPersonne = aPersonne;
  if (nodes.length) struct += 6;
  if (aOrg) struct += 8;
  if (aPersonne) struct += 3;
  if (sameAs.length >= 2) struct += 8; else if (sameAs.length === 1) struct += 4;

  // ── AEO (20) ──
  let aeo = 0;
  const questions = (html.match(/"@type"\s*:\s*"Question"/g) || []).length;
  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  const h2 = (html.match(/<h2[\s>]/gi) || []).length;
  d.questionsFaq = questions; d.h1 = h1; d.h2 = h2;
  if (questions >= 3) aeo += 10; else if (questions >= 1) aeo += 6;
  if (h1 === 1) aeo += 4;
  if (h2 >= 3) aeo += 3;
  if (mots >= 400) aeo += 3;

  // ── ANCRAGE (15) — NAP accepté sur Organization (correctif de barème du 2026-08-17) ──
  let ancrage = 0;
  const lb = nodes.find((n) => iiType(n, 'LocalBusiness') || iiType(n, 'ProfessionalService'))
          ?? nodes.find((n) => iiType(n, 'Organization'));
  d.nap = { address: !!lb?.address, telephone: !!lb?.telephone, geo: !!lb?.geo };
  d.areaServed = !!lb?.areaServed;
  if (lb?.address) ancrage += 5;
  if (lb?.telephone) ancrage += 3;
  if (lb?.geo) ancrage += 3;
  if (lb?.areaServed) ancrage += 4;

  // ── TECHNIQUE (10) ──
  let tech = 0;
  d.certValide = true;          // cf. divergence nº 1 : un fetch HTTPS réussi le prouve
  d.certExpire = null;          // date non lisible depuis un Worker — on ne l'invente pas
  d.sitemap = iiFichierReel(sitemapRep, { xml: true });
  d.llmsTxt = iiFichierReel(llmsRep);
  d.viewport = /name=["']viewport["']/i.test(html);
  d.canonical = /rel=["']canonical["']/i.test(html);
  tech += 4;                    // certificat valide
  if (d.viewport) tech += 2;
  if (d.canonical) tech += 2;
  if (d.sitemap) tech += 2;

  const piliers = { acces, structure: struct, aeo, ancrage, technique: tech };
  return { hote: c.hote, joignable: true, score: acces + struct + aeo + ancrage + tech, piliers, detail: d };
}


/**
 * INDICE IA — AGRÉGATS ANONYMES (2026-08-21).
 *
 * Pourquoi maintenant : un « observatoire de la lisibilité IA » nourri par l'outil
 * ne se rattrape pas rétroactivement. Chaque analyse non comptée aujourd'hui est
 * une donnée perdue pour toujours. Une heure de travail, une fenêtre qui se ferme.
 *
 * ⚠️ AUCUN DOMAINE N'EST CONSERVÉ, et ce n'est pas négociable : la page promet
 * que « le domaine sert à faire l'analyse et n'est associé à aucune identité ».
 * On ne garde que des COMPTEURS — combien d'analyses, la somme des notes, la
 * distribution par tranche de dix, la somme par pilier. Rien qui permette de
 * reconstituer qui a testé quoi. La FAQ de la page décrit exactement ceci ; si
 * on élargit un jour la collecte, on change la FAQ D'ABORD.
 *
 * Compteurs séparés plutôt qu'un blob JSON lu-modifié-réécrit : sous concurrence,
 * le read-modify-write perd des écritures en silence.
 */
async function addCounter(env, key, n, ttlSeconds) {
  if (!env?.COUNTERS) return;
  // Même règle que bumpCounter : un agrégat anonyme perdu ne vaut pas un audit perdu.
  try {
    const v = parseInt((await env.COUNTERS.get(key)) ?? '0', 10) + n;
    await env.COUNTERS.put(key, String(v), { expirationTtl: ttlSeconds });
  } catch (e) {
    console.log(`addCounter(${key}) : ${e?.message ?? e} — agrégat non écrit, requête poursuivie`);
  }
}

const II_TTL = 400 * 86400;   // 400 jours : une année complète survit au relevé

async function iiAgreger(env, r) {
  if (!env?.COUNTERS || r?.score == null) return;
  const mois = new Date().toISOString().slice(0, 7);
  const k = (suffixe) => `iis:${mois}:${suffixe}`;
  const tranche = Math.min(10, Math.floor(r.score / 10));
  await Promise.all([
    addCounter(env, k('n'), 1, II_TTL),
    addCounter(env, k('somme'), r.score, II_TTL),
    addCounter(env, k(`t${tranche}`), 1, II_TTL),
    addCounter(env, k('acces'), r.piliers.acces, II_TTL),
    addCounter(env, k('structure'), r.piliers.structure, II_TTL),
    addCounter(env, k('aeo'), r.piliers.aeo, II_TTL),
    addCounter(env, k('ancrage'), r.piliers.ancrage, II_TTL),
    addCounter(env, k('technique'), r.piliers.technique, II_TTL),
    r.detail?.contenuDependantJs ? addCounter(env, k('jsdep'), 1, II_TTL) : null,
    r.detail?.sameAs === 0 ? addCounter(env, k('sansSameAs'), 1, II_TTL) : null,
    r.detail?.questionsFaq === 0 ? addCounter(env, k('sansFaq'), 1, II_TTL) : null,
  ].filter(Boolean));
}

// ---------------------------------------------------------------- JSON-RPC / MCP

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const rpcResult = (id, result) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleRpc(msg, env) {
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS.map((t) => ({ ...t, annotations: ANNOTATIONS_OUTILS[t.name] })) });
    case 'tools/call': {
      const impl = TOOL_IMPL[params.name];
      if (!impl) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const result = await impl(params.arguments ?? {}, env);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: Boolean(result && result.error),
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Tool error: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return new Response(null, { status: 202, headers: CORS });
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════════
// runSequence — la vague du MARDI, 10 h locale, province par province.
// ═══════════════════════════════════════════════════════════════════════════════════
//
// L'HORAIRE EST DÉJÀ RÉSOLU. `zonesAt10h()` sait quelles provinces sont à 10 h à cette
// heure UTC, et le cron `0 12-18 * * *` couvre par construction les six fuseaux canadiens
// (Terre-Neuve 13 h UTC → Pacifique 17 h UTC). Rien à programmer côté Resend : son
// `scheduled_at` plafonne à 72 h ET n'existe pas en envoi par lots — il ne peut pas servir
// pour « mardi prochain ». Le cron se réveille et envoie en direct, comme le bulletin.
//
// AVANT LE BULLETIN, ET C'EST VOULU. La séquence porte une DATE promise (mardi) ; le
// bulletin mensuel, lui, s'étale sur tout le mois. À budget contraint, ce qui a une date
// passe devant ce qui a un mois.
//
// UN EXPERT EN SÉQUENCE SORT DE L'ESCALIER MENSUEL le temps de ses six semaines : sans
// ça il recevrait deux courriels la même semaine, dont un qui redemande ce que l'autre
// vient de demander.
//
// ⚠️ GARDE-FOU D'ENRÔLEMENT. Le council du 18 août a conditionné cette machine à un test
// préalable : 50 courriels envoyés à la main, ≥ 2 confirmations en 14 jours. La machine
// est construite, mais elle n'enrôle PERSONNE toute seule — `scripts/sequence.mjs enroler`
// refuse tant que `seq-feu-vert` n'est pas posé en KV. On ne code pas un entonnoir avant
// de savoir si le premier courriel fait répondre.
async function runSequence(env, { at = new Date(), dryRun = false } = {}) {
  const r = { vague: at.toISOString().slice(0, 10), envoyes: 0, rates: 0, parEtape: {}, sorties: [], zones: [] };
  if (!env.SUBSCRIBERS) return r;
  if (at.getUTCDay() !== 2) return r;                       // mardi seulement
  if (await env.SUBSCRIBERS.get('stop:all')) return { ...r, arrete: 'stop:all' };
  if (await env.SUBSCRIBERS.get('stop:outreach')) return { ...r, arrete: 'stop:outreach' };

  const zones = zonesAt10h(at);
  r.zones = [...zones];
  if (!zones.size) return r;

  const cles = await kvKeys(env.SUBSCRIBERS, 'seq:');
  if (!cles.length) return r;

  const dayKey = at.toISOString().slice(0, 10);
  const cycle = at.toISOString().slice(0, 7);
  const file = [];
  const feeds = new Map();
  const villes = new Map();
  let macro = null;

  for (const cle of cles) {
    const slug = cle.replace(/^seq:/, '');
    let etat; try { etat = JSON.parse((await env.SUBSCRIBERS.get(`seq:${slug}`)) || '{}'); } catch { continue; }
    if (!etat || etat.stop || (etat.etape ?? 0) >= 6) continue;
    if (await env.SUBSCRIBERS.get(`unsub:${slug}`)) { r.sorties.push(`${slug} (désabonné)`); continue; }
    if (await env.SUBSCRIBERS.get(`seq-sent:${dayKey}:${slug}`)) continue;   // déjà servi ce mardi
    if (!zones.has(etat.province)) continue;                                  // pas son fuseau

    // L'état VIVANT : on relit la fiche à chaque envoi plutôt que de rejouer l'enrôlement.
    if (!feeds.has(etat.province)) {
      feeds.set(etat.province, await feed(`/api/experts/${etat.province}.json`)
        .then((d) => d.experts ?? []).catch(() => []));
    }
    const expert = feeds.get(etat.province).find((e) => e.slug === slug);
    if (!expert || expert.score?.color === 'red') { r.sorties.push(`${slug} (non publié)`); continue; }
    if (expert.emailBounced) { r.sorties.push(`${slug} (rebond)`); continue; }
    const dest = String(etat.email || '').toLowerCase();
    if (!dest) { r.sorties.push(`${slug} (pas de courriel)`); continue; }
    if (await env.SUBSCRIBERS.get(`bounce:${dest}`)) { r.sorties.push(`${slug} (rebond dur)`); continue; }
    if (await env.SUBSCRIBERS.get(`unsub:prospect:${dest}`)) { r.sorties.push(`${slug} (désabonné)`); continue; }

    const etape = (etat.etape ?? 0) + 1;
    if (!villes.has(expert.city)) {
      const m = await feed('/api/market.json').catch(() => null);
      villes.set(expert.city, (m?.cities ?? m?.villes ?? []).find((c) => c.slug === expert.city) ?? null);
    }
    const city = villes.get(expert.city) ?? { name: expert.cityName ?? expert.city, slug: expert.city };
    if (etape === 3 && !macro) macro = await macroCourant();

    const unsubUrl = await expertUnsubUrl(env, WORKER_ORIGIN, slug);
    const { subject, html } = renderSequence({ etape, expert, city, seq: etat, lang: etat.lang || expert.lang || 'fr', unsubUrl, macro, postale: adressePostale(env) });
    r.parEtape[`S${etape}`] = (r.parEtape[`S${etape}`] || 0) + 1;
    if (dryRun) continue;
    file.push({ to: dest, subject, html, unsubUrl, slug, etape, etat, flux: `sequence-S${etape}` });
  }

  if (dryRun || !file.length) return r;

  // Envoi par lots, sous l'expéditeur de prospection — jamais celui du bulletin opt-in.
  const from = env.MAIL_FROM_OUTREACH || env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>';
  for (let i = 0; i < file.length; i += TAILLE_LOT) {
    const lot = file.slice(i, i + TAILLE_LOT);
    const rep = await sendPulseBatch(env, lot, { from });
    for (let k = 0; k < lot.length; k++) {
      const e = lot[k];
      if (!rep[k]?.ok) { r.rates++; continue; }
      // L'étape n'avance qu'à l'ACCEPTATION : un envoi raté se rejoue le mardi suivant
      // plutôt que de sauter une semaine de la séquence.
      e.etat.etape = e.etape;
      e.etat.envoye = { ...(e.etat.envoye ?? {}), [String(e.etape)]: new Date().toISOString() };
      await env.SUBSCRIBERS.put(`seq:${e.slug}`, JSON.stringify(e.etat), { expirationTtl: 200 * 24 * 3600 });
      await env.SUBSCRIBERS.put(`seq-sent:${dayKey}:${e.slug}`, String(e.etape), { expirationTtl: 100 * 24 * 3600 });
      // L'escalier mensuel ne doit pas doubler la séquence ce mois-ci.
      await env.SUBSCRIBERS.put(`sent:${cycle}:${e.slug}`, new Date().toISOString(), { expirationTtl: CYCLE_TTL });
      // Compteur de prospection du jour — la rampe et les seuils le lisent.
      const cleJ = `day:${dayKey}:outreach`;
      const deja = Number((await env.SUBSCRIBERS.get(cleJ)) || 0);
      await env.SUBSCRIBERS.put(cleJ, String(deja + 1), { expirationTtl: 3 * 24 * 3600 });
      r.envoyes++;
      // Un spécimen par étape et par vague : le proprio voit ce qui est parti, sans
      // recevoir une copie de chaque courriel (décision du 2 août : illisible à 500).
      const cleSpec = `sample-seq:${dayKey}:${e.etape}`;
      if (!(await env.SUBSCRIBERS.get(cleSpec))) {
        await env.SUBSCRIBERS.put(cleSpec, '1', { expirationTtl: 3 * 24 * 3600 });
        await envoyerEchantillon(REPORT_TO, `[spécimen S${e.etape} → ${e.slug}] ${e.subject}`, e.html);
      }
    }
  }
  return r;
}

const WORKER_MAIN = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Statistiques publiques agrégées (aucune donnée personnelle) — pour le rapport hebdo.
    // INDICE IA — /indice-ia?domaine=exemple.ca
    // Audit public, gratuit, sans jeton. Le garde-fou est le DÉBIT, pas l'identité :
    // 15 audits par heure et par IP, 3 000 par jour au global. Chaque audit fait
    // 4 requêtes sortantes ; sans plafond, l'endpoint devient un scanner pour autrui.
    // Relecture des agrégats — c'est la matière de l'« observatoire » à publier.
    // /indice-ia-stats?mois=2026-08 (défaut : le mois courant)
    if (request.method === 'GET' && url.pathname === '/indice-ia-stats') {
      const mois = (url.searchParams.get('mois') || new Date().toISOString().slice(0, 7));
      if (!/^\d{4}-\d{2}$/.test(mois)) return json({ erreur: 'mois invalide (AAAA-MM)' }, 400);
      const lire = async (k) => parseInt((await env.COUNTERS?.get(`iis:${mois}:${k}`)) ?? '0', 10);
      const n = await lire('n');
      const [somme, acces, structure, aeo, ancrage, technique, jsdep, sansSameAs, sansFaq] =
        await Promise.all(['somme','acces','structure','aeo','ancrage','technique','jsdep','sansSameAs','sansFaq'].map(lire));
      const tranches = {};
      for (let i = 0; i <= 10; i++) tranches[`${i * 10}-${i === 10 ? 100 : i * 10 + 9}`] = await lire(`t${i}`);
      return json({
        mois, analyses: n,
        moyenne: n ? Math.round((somme / n) * 10) / 10 : null,
        piliers: n ? {
          acces: Math.round((acces / n) * 10) / 10, structure: Math.round((structure / n) * 10) / 10,
          aeo: Math.round((aeo / n) * 10) / 10, ancrage: Math.round((ancrage / n) * 10) / 10,
          technique: Math.round((technique / n) * 10) / 10,
        } : null,
        tranches,
        constats: { dependantJs: jsdep, sansSameAs, sansFaq },
        _lecture: 'Agrégats anonymes. Aucun domaine analysé n\'est conservé.',
      });
    }

    if (request.method === 'GET' && url.pathname === '/indice-ia') {
      const domaine = url.searchParams.get('domaine') ?? url.searchParams.get('domain');
      if (!domaine) return json({ erreur: 'domaine manquant', usage: '/indice-ia?domaine=exemple.ca' }, 400);

      // Derrière Cloudflare, `CF-Connecting-IP` est TOUJOURS posé. Son absence signifie
      // donc qu'on n'est pas en production : `wrangler dev`, ou un appel direct à l'origine.
      // On garde un plafond dans ce cas — mais large, sinon quinze essais suffisent à
      // bloquer une séance de mise au point, ce qui est arrivé le 2026-08-21.
      const ip = request.headers.get('CF-Connecting-IP');
      const local = !ip;
      const PLAFOND_IP = local ? 500 : 15;
      const heure = new Date().toISOString().slice(0, 13);
      const jour = new Date().toISOString().slice(0, 10);
      const parIp = await bumpCounter(env, 'ii:' + (ip ?? 'local') + ':' + heure, 3600);
      const global = await bumpCounter(env, 'ii:global:' + jour, 86400);
      if (parIp > PLAFOND_IP) return json({ erreur: 'trop de demandes', reessayer: 'dans une heure' }, 429);
      if (global > 3000) return json({ erreur: 'plafond quotidien atteint' }, 429);

      const r = await iiAuditer(domaine);
      await iiAgreger(env, r);   // agrégats anonymes — jamais le domaine
      return json({
        bareme: { acces: 30, structure: 25, aeo: 20, ancrage: 15, technique: 10, total: 100 },
        mesure: new Date().toISOString(),
        agent: II_UA,
        ...r,
      });
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      let subscribers = 0, relaysMonth = 0, relaysTotal = 0;
      if (env.SUBSCRIBERS) subscribers = (await env.SUBSCRIBERS.list({ prefix: 's:' })).keys.length;
      if (env.COUNTERS) {
        const month = new Date().toISOString().slice(0, 7);
        const l = await env.COUNTERS.list({ prefix: 'm:' });
        for (const k of l.keys) {
          const v = parseInt((await env.COUNTERS.get(k.name)) ?? '0', 10);
          relaysTotal += v;
          if (k.name.endsWith(month)) relaysMonth += v;
        }
      }
      return json({ generated: new Date().toISOString().slice(0, 10), bulletinSubscribers: subscribers, aiContactRelays: { thisMonth: relaysMonth, total: relaysTotal } });
    }

    // Aperçu d'un numéro (aucun envoi) — pour valider le rendu de la machine en direct.
    // Aperçu de l'ALERTE TAUX, rendue par le vrai gabarit d'envoi.
    // Ex. /preview-alerte?lang=fr&ancien=2.25&nouveau=2  (défauts : la vraie valeur du jour)
    // Sans paramètres, il montre le taux réel — donc « aucun mouvement », ce qui ne
    // ressemble à rien. Passer `ancien` et `nouveau` pour voir le courriel tel qu'il partira.
    if (request.method === 'GET' && url.pathname === '/preview-alerte') {
      const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'fr';
      const macro = await macroCourant();
      const reel = macro?.rates?.policyRate;
      const nouveau = Number(url.searchParams.get('nouveau') ?? reel?.percent ?? 2.25);
      // Par défaut : un MAINTIEN — le cas le plus fréquent (aucun mouvement depuis
      // le 30 octobre 2025). Passer ?ancien= pour voir la variante « ça bouge ».
      const ancien = url.searchParams.get('ancien') != null ? Number(url.searchParams.get('ancien')) : nouveau;
      const observed = url.searchParams.get('observed') || reel?.observed || new Date().toISOString().slice(0, 10);
      const segment = ['optin', 'expert', 'prospect'].includes(url.searchParams.get('segment') ?? '')
        ? url.searchParams.get('segment') : 'optin';
      // Prix de la ville demandée, pour montrer le bloc local tel qu'il partira.
      const villeSlug = url.searchParams.get('ville') || (segment === 'optin' ? '' : 'montreal');
      let ville = '', prix = null;
      if (villeSlug) {
        try {
          const c = (await feed('/api/market.json')).cities.find((x) => x.slug === villeSlug);
          if (c) {
            ville = c.name; prix = refPriceOf(c);
            // Même correction que dans l'envoi réel : market.json dit « Montreal », le feed
            // d'experts dit « Montréal ». L'aperçu doit montrer ce qui part vraiment.
            try {
              const ex = (await feed(`/api/experts/${PROV_SLUG[c.province]}.json`)).experts ?? [];
              const m = ex.find((x) => x.city === villeSlug && x.cityName);
              if (m) ville = m.cityName;
            } catch { /* le nom anglais fera l'affaire dans un aperçu */ }
          }
        } catch { /* sans prix, le bloc local se réduit au « par 100 000 $ » */ }
      }
      const m = await macroCourant();
      const pr = (m?.aVenir ?? [])[0] ?? null;
      const { subject, html } = renderAlerteTaux({
        nouveau, ancien, observed, lang, unsubUrl: '#apercu', postale: adressePostale(env),
        segment, ville, prix,
        nom: url.searchParams.get('nom') ?? (segment === 'optin' ? '' : 'Marie Pronovost'),
        prochaine: url.searchParams.get('prochaine') || pr?.date || null,
        prochaineMpr: url.searchParams.get('mpr') === '1' || !!pr?.mpr,
      });
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">`
        + `<title>${esc(subject)}</title>`
        + `<div style="font:13px -apple-system,sans-serif;color:#555;background:#fff;padding:14px 16px;border-bottom:1px solid #ddd;">`
        + `<b>Objet :</b> ${esc(subject)}<br><b>Aperçu</b> — aucun envoi, aucun destinataire.</div>${html}`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } },
      );
    }

    // Ex. /preview?segment=expert&stage=yellow&city=laval&lang=fr
    if (request.method === 'GET' && url.pathname === '/preview') {
      const q = url.searchParams;
      const segment = q.get('segment') || 'prospect';
      const stage = q.get('stage') || 'intro';
      const citySlug = strip(q.get('city') || 'laval');
      const lang = q.get('lang') || 'fr';
      const market = await feed('/api/market.json').catch(() => ({ cities: [] }));
      // Variante provinciale ou banlieue : ?prov=alberta&ville=Okotoks&metier=appraiser
      if (q.get('prov')) {
        const pmj = await feed('/api/province-market.json').catch(() => null);
        const v = renderBulletinProvincial({ provSlug: q.get('prov'), villeReelle: q.get('ville') || '', metier: q.get('metier') || '', lang, unsubUrl: '#preview' },
          { cities: market.cities || [], macro: null, provMarket: Array.isArray(pmj?.provinces) ? pmj.provinces : [], publiesVille: () => null, publiesProvince: () => null });
        if (!v) return json({ error: 'rien à envoyer pour cette province' }, 404);
        return new Response(`<!--${v.subject} [${v.variante}${v.zone ? ' ' + v.zone : ''}]-->\n${v.html}`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      const city = market.cities.find((c) => strip(c.slug) === citySlug) || market.cities.find((c) => strip(c.name) === citySlug);
      if (!city) return json({ error: `Ville inconnue : ${citySlug}`, villes: (market.cities || []).map((c) => c.slug) }, 404);
      // Pour un expert : on prend un expert réel de la ville si possible, sinon un gabarit.
      let expert = null;
      if (segment === 'expert') {
        try {
          const all = await allExperts();
          expert = all.find((e) => strip(e.cityName) === citySlug || strip(e.city) === citySlug) || all[0] || null;
        } catch { /* gabarit ci-dessous */ }
        if (!expert) expert = { name: 'Exemple', professionLabel: 'courtier immobilier', score: { total: 64, color: 'yellow' }, licence: { body: 'OACIQ', number: null }, url: `${SITE}` };
      }
      // L'aperçu doit montrer le courriel RÉEL, bloc des taux compris — sinon il valide un
      // gabarit qui n'existe pas.
      const macro = await macroCourant();
      /* `couverte=1|0` force la variante prospect ; absent, on laisse null (générique).
         Sans ce paramètre, les deux contenus segmentés seraient invérifiables avant
         l'envoi — et c'est justement l'aperçu qui sert de garde-fou. */
      const cvBrut = url.searchParams.get('couverte');
      const { subject, html } = renderPulse({ segment, stage, city, expert, lang, unsubUrl: '#preview', macro,
        metier: url.searchParams.get('metier') || '',
        villeCouverte: cvBrut === null ? null : cvBrut === '1' });
      return new Response(`<!--${subject}-->\n${html}`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
    }

    // ── RELAIS DU FORMULAIRE DE CONTACT (2026-08-17) ─────────────────────────────
    // POURQUOI. public/contact-handler.php envoyait par mail() de PHP vers
    // gregory@payotte.com — un simple RENVOI GoDaddy, pas une boîte. Testé le 17 août :
    // le message n'arrive nulle part, et le handler ne journalisait rien. Deux mois de
    // formulaires ont pu disparaître sans laisser de trace (handler créé le 2026-06-16).
    // mail() sur hébergement mutualisé est réputé pour ça.
    //
    // Le worker, lui, envoie déjà des centaines de courriels par Resend sans incident.
    // Le PHP relaie donc ici, et Resend livre DIRECTEMENT dans le Gmail du proprio.
    // Le PHP journalise avant d'appeler : même si ce relais tombe, rien n'est perdu.
    //
    // Auth : le même CONTACTS_TOKEN que /bulletin-dryrun. Refus = 401, et le PHP bascule
    // alors sur mail() en dernier recours.
    // ── WEBHOOK RESEND — rebonds et plaintes (2026-08-19) ──────────────────────────
    // CE QU'IL RÉSOUT. Jusqu'ici, un rebond dur partait dans la corbeille Gmail du proprio
    // et l'adresse morte était RESSERVIE au cycle suivant, indéfiniment. Une plainte pour
    // pourriel, elle, n'était visible nulle part. Or ce sont les deux seuls signaux qui
    // disent qu'une campagne est en train de brûler la réputation du domaine — et à
    // volume qui monte, on ne peut pas les découvrir en lisant ses courriels.
    //
    // CE QU'IL FAIT.
    // ── UN MARQUEUR DATÉ, PAS UN COMPTEUR (2026-09-16) ──────────────────────────────
    // `rebond:{jour}` et `plainte:{jour}` étaient des compteurs en LECTURE-MODIFICATION-
    // ÉCRITURE sur UNE clé. Workers KV n'accepte qu'une écriture par seconde et par clé :
    // sous rafale la clé rendait 429, et même sans 429 deux webhooks simultanés lisaient
    // tous les deux `n` et écrivaient tous les deux `n+1`. Mesure du 14 septembre :
    // `rebond:2026-09-14` valait 2 pendant que les clés `bounce:` passaient de 4 à 7 —
    // un incrément perdu sur trois, et ce sont EXACTEMENT ces compteurs que lisent les
    // seuils d'arrêt automatique. Le garde-fou devenait optimiste au moment précis où le
    // volume montait.
    //
    // On écrit donc UNE CLÉ PAR (jour, adresse) : `rebondj:{jour}:{courriel}`. Deux
    // webhooks n'écrivent plus jamais la même clé, donc ni course ni 429 ; le comptage
    // devient un `list()` par préfixe. Et c'est IDEMPOTENT, ce qu'un compteur n'était
    // pas : la même adresse qui rebondit deux fois le même jour compte pour une — un
    // rebond est une adresse morte, pas un événement à additionner.
    //
    //   bounced (dur)  → `bounce:{courriel}` ÉTERNEL. L'adresse ne repart jamais, quel que
    //                    soit le flux. Un rebond doux (mailbox_full…) n'est PAS retenu :
    //                    une boîte pleine se vide.
    //   complained     → `unsub:prospect:{courriel}` + `plainte:{jour}` incrémenté. Une
    //                    plainte vaut un désabonnement : la personne a dit non de la façon
    //                    la plus coûteuse pour nous, on ne la rappelle pas.
    //
    // LES SEUILS, ET POURQUOI CEUX-LÀ. Les fournisseurs (Gmail, Microsoft) coupent autour
    // de 0,3 % de plaintes. On agit AVANT : à 0,10 % le plafond du jour est divisé par
    // deux, à 0,30 % (ou 3 plaintes en 24 h, qui compte quand le volume est petit) le flux
    // s'ARRÊTE. Rebonds durs : 2 % ÷ 2, 4 % arrêt — un taux élevé signale une liste sale,
    // et une liste sale est ce qui déclenche les filtres.
    // ⚠️ Seul `outreach` peut être coupé automatiquement. Le bulletin opt-in et le relais
    // client↔pro (le produit) ne se coupent JAMAIS tout seuls : leur arrêt serait une panne
    // plus grave que le risque qu'il évite.
    //
    // SIGNATURE. Resend signe en Svix (`svix-id`, `svix-timestamp`, `svix-signature`,
    // HMAC-SHA256 base64 sur « id.timestamp.payload »). Sans `RESEND_WEBHOOK_SECRET`
    // configuré, la route REFUSE tout : un webhook non signé serait un moyen offert à
    // n'importe qui de désabonner nos adresses ou d'arrêter nos envois.
    // État de la séquence — même jeton privé que /bulletin-dryrun. Lecture seule.
    if (request.method === 'GET' && url.pathname === '/sequence-status') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('t') !== env.CONTACTS_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const cles = env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 'seq:') : [];
      const parEtape = {}, parCohorte = {}, liste = [];
      for (const cle of cles) {
        const slug = cle.replace(/^seq:/, '');
        let e; try { e = JSON.parse((await env.SUBSCRIBERS.get(`seq:${slug}`)) || '{}'); } catch { continue; }
        const et = e.stop ? 'arrêtée' : `S${e.etape ?? 0}`;
        parEtape[et] = (parEtape[et] || 0) + 1;
        parCohorte[e.cohorte ?? '?'] = (parCohorte[e.cohorte ?? '?'] || 0) + 1;
        liste.push({ slug, etape: e.etape ?? 0, cohorte: e.cohorte ?? null, province: e.province ?? null, stop: !!e.stop });
      }
      return json({
        inscrits: liste.length, parEtape, parCohorte,
        feuVert: Boolean(await env.SUBSCRIBERS?.get('seq-feu-vert')),
        stopOutreach: (await env.SUBSCRIBERS?.get('stop:outreach')) ?? null,
        liste: liste.sort((a, b) => a.slug.localeCompare(b.slug)),
      });
    }

    // État de l'alerte taux, et sa répétition à blanc. `?dry=1` compose les courriels sans
    // rien envoyer ni rien mémoriser — le seul moyen de vérifier le déclencheur sans
    // attendre une décision de la Banque du Canada.
    if (request.method === 'GET' && url.pathname === '/alerte-taux-status') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('t') !== env.CONTACTS_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const cles = env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 'taux:') : [];
      const inscrits = cles.filter((e) => e !== 'dernier' && EMAIL_RE.test(e));
      let memoire = null;
      try { memoire = JSON.parse((await env.SUBSCRIBERS?.get('taux:dernier')) || 'null'); } catch { /* clé abîmée */ }
      const macro = await macroCourant();
      const sortie = {
        inscrits: inscrits.length,
        memoire,
        tauxLu: macro?.rates?.policyRate ?? null,
        changement: memoire && macro?.rates?.policyRate?.percent != null
          ? memoire.percent !== macro.rates.policyRate.percent : null,
        // Le déclencheur, désormais : le CALENDRIER. Une alerte part à chaque annonce,
        // mouvement ou non — le taux n'a pas bougé depuis le 30 octobre 2025.
        prochaineAnnonce: (macro?.aVenir ?? [])[0] ?? null,
        annoncesServies: env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 'taux:annonce:') : [],
        stopAll: (await env.SUBSCRIBERS?.get('stop:all')) ?? null,
        desabonnes: env.SUBSCRIBERS ? (await kvKeys(env.SUBSCRIBERS, 'unsub:taux:')).length : 0,
      };
      if (url.searchParams.get('dry') === '1') sortie.repetition = await runAlerteTaux(env, { dryRun: true });
      return json(sortie);
    }

    // Ce que chaque flux a donné, mois par mois. C'est la seule réponse possible à
    // « est-ce que ça marche ? » — et elle n'existait pas.
    // ⚠️ PAS `/stats` : cette route existe déjà et elle est PUBLIQUE (compteurs du site).
    // L'écraser aurait cassé une donnée que le site publie.
    if (request.method === 'GET' && url.pathname === '/flux-stats') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('t') !== env.CONTACTS_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const cles = env.SUBSCRIBERS ? await kvKeys(env.SUBSCRIBERS, 'stat:') : [];
      const par = {};
      for (const c of cles) {
        const [flux, mois, quoi] = c.split(':');
        if (!flux || !mois || !quoi) continue;
        const v = Number((await env.SUBSCRIBERS.get(`stat:${c}`)) || 0);
        ((par[mois] ??= {})[flux] ??= {})[quoi] = v;
      }
      // Les taux se calculent sur les LIVRÉS, pas sur les envoyés : un courriel qui rebondit
      // n'a jamais eu de lecteur, l'inclure au dénominateur écraserait le résultat.
      for (const mois of Object.keys(par)) {
        for (const [flux, d] of Object.entries(par[mois])) {
          const base = d.livres || d.envoyes || 0;
          if (base) {
            d._taux = {
              // Pas de taux d'ouverture : depuis le 14 sept. 2026 les ouvertures ne sont
              // plus comptées du tout (voir « NE COMPTER QUE LE RARE »). Afficher « 0 % »
              // laisserait croire que personne n'ouvre ; l'absence de la ligne est franche.
              clic_unique: d.cliqueurs ? `${(d.cliqueurs / base * 100).toFixed(1)} %` : '0 %',
              plainte: d.plaintes ? `${(d.plaintes / base * 100).toFixed(2)} %` : '0 %',
            };
          }
        }
      }
      return json({
        _lecture: 'Les CLICS, REBONDS et PLAINTES viennent du webhook Resend ; `envoyes` est tenu '
          + 'par l\'expéditeur, un comptage par lot de 100. Taux calculés sur `envoyes` (tentatives).',
        _ouvertures: 'PLUS COMPTÉES depuis le 2026-09-14. Elles coûtaient jusqu\'à trois écritures KV '
          + 'par courriel — de quoi crever le quota quotidien du compte et faire échouer /unsubscribe — '
          + 'pour un signal que ce même fichier qualifiait de faible (Apple Mail Privacy Protection les '
          + 'gonfle, les bloqueurs d\'images les effacent). Un clic prouve un geste, pas une ouverture. '
          + 'Les chiffres bruts restent disponibles dans le tableau de bord Resend.',
        _livres: 'PLUS COMPTÉS : `envoyes` sert de dénominateur. L\'écart entre les deux est le taux '
          + 'de rebond, déjà mesuré par ailleurs.',
        _webhook: env.RESEND_WEBHOOK_SECRET ? 'configuré' : '⚠️ ABSENT — aucun événement ne peut arriver',
        parMois: par,
      });
    }

    if (request.method === 'POST' && url.pathname === '/resend-webhook') {
      const secret = env.RESEND_WEBHOOK_SECRET;
      if (!secret) return json({ error: 'webhook non configuré' }, 503);
      const brut = await request.text();
      const id = request.headers.get('svix-id') || '';
      const ts = request.headers.get('svix-timestamp') || '';
      const sig = request.headers.get('svix-signature') || '';
      if (!id || !ts || !sig) return json({ error: 'signature manquante' }, 401);
      // Rejeu : au-delà de 5 minutes, on refuse même une signature valide.
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ error: 'horodatage hors fenêtre' }, 401);
      let valide = false;
      try {
        const clef = secret.startsWith('whsec_') ? secret.slice(6) : secret;
        const key = await crypto.subtle.importKey('raw',
          Uint8Array.from(atob(clef), (c) => c.charCodeAt(0)),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${brut}`));
        const attendu = btoa(String.fromCharCode(...new Uint8Array(mac)));
        // Svix envoie « v1,sig1 v1,sig2 » — une seule doit correspondre (rotation de clé).
        valide = sig.split(' ').some((part) => part.split(',')[1] === attendu);
      } catch { valide = false; }
      if (!valide) return json({ error: 'signature invalide' }, 401);

      let ev; try { ev = JSON.parse(brut); } catch { return json({ error: 'corps illisible' }, 400); }
      const type = ev?.type || '';
      const dest = String(ev?.data?.to?.[0] ?? ev?.data?.email ?? '').toLowerCase().trim();
      const jour = new Date().toISOString().slice(0, 10);
      if (!dest || !env.SUBSCRIBERS) return json({ ok: true, ignore: true });

      // ── LE COMPTAGE (2026-08-19) ─────────────────────────────────────────────────
      // Le webhook ne traitait que les rebonds et les plaintes. Il enregistrait donc les
      // ÉCHECS et rien d'autre : impossible de dire si un envoi avait marché.
      //
      // C'est exactement le trou qui a produit « j'ai envoyé 80 brouillons et je n'ai eu
      // aucun retour » — sans savoir si personne n'ouvrait, ou si tout tombait en spam.
      // Un flux qu'on ne mesure pas ne s'améliore pas, il se répète.
      //
      // Compteurs par FLUX et par MOIS (l'étiquette posée à l'envoi), TTL 400 jours pour
      // garder l'historique d'une année complète de comparaisons.
      //
      // ⚠️ CE QUE VALENT CES CHIFFRES. Les CLICS sont un signal solide. Les OUVERTURES,
      // non : Apple Mail Privacy Protection charge le pixel sans que personne ne lise,
      // ce qui les gonfle, tandis que les clients qui bloquent les images les effacent.
      // Une ouverture ne prouve rien ; un clic prouve un geste.
      const flux = String(ev?.data?.tags?.find?.((t) => t?.name === 'flux')?.value ?? 'inconnu');
      const mois = jour.slice(0, 7);
      const compte = async (quoi) => {
        const cle = `stat:${flux}:${mois}:${quoi}`;
        const n = Number((await env.SUBSCRIBERS.get(cle)) || 0);
        await env.SUBSCRIBERS.put(cle, String(n + 1), { expirationTtl: 400 * 24 * 3600 });
      };
      /* ── NE COMPTER QUE LE RARE (14 sept. 2026) ────────────────────────────────────
         CE BLOC A CREVÉ LE QUOTA KV DU COMPTE. Le palier gratuit Workers KV autorise
         1 000 ÉCRITURES par jour, tout le compte confondu. Or un seul courriel produisait
         jusqu'à CINQ écritures ici : `email.sent`, `email.delivered`, `email.opened`, la
         marque `vu:` et le compteur `ouvreurs`. Les 305 courriels du 14 septembre ont
         donc suffi : 1 120 exceptions `KV put() limit exceeded for the day` ont suivi —
         et quand le quota est crevé, ce n'est pas que la statistique qui tombe, c'est
         AUSSI `/unsubscribe`. Trois personnes n'ont pas pu se désabonner ce jour-là.

         Ce qui disparaît, et pourquoi ce n'est pas une perte :
         · `envoyes` / `livres` — l'expéditeur les connaît déjà. `viderFile` incrémente
           désormais `stat:{flux}:{mois}:envoyes` UNE fois par lot de 100, pas une fois
           par destinataire. Même dénominateur, 1 % du coût.
         · `ouvertures` / `ouvreurs` — le commentaire ci-dessus dit lui-même qu'une
           ouverture ne prouve rien (Apple MPP les gonfle, les bloqueurs les effacent).
           On payait cher, et en écritures rares, pour un chiffre qu'on savait faux.

         Ce qui reste est RARE par nature — un clic, un rebond, une plainte, un retard —
         donc quelques écritures par jour au lieu de plusieurs milliers. */
      const COMPTABLES = {
        'email.clicked': 'clics',
        'email.bounced': 'rebonds', 'email.complained': 'plaintes',
        'email.delivery_delayed': 'retards',
      };
      if (COMPTABLES[type]) await compte(COMPTABLES[type]);

      // Clics UNIQUES : un même destinataire qui reclique cinq fois ne fait pas cinq
      // lecteurs. Sans ça, un seul curieux gonflerait le taux de tout un flux.
      if (type === 'email.clicked') {
        const marque = `vu:${flux}:${mois}:cliqueurs:${dest}`;
        if (!(await env.SUBSCRIBERS.get(marque))) {
          await env.SUBSCRIBERS.put(marque, '1', { expirationTtl: 70 * 24 * 3600 });
          await compte('cliqueurs');
        }
      }

      if (type === 'email.bounced') {
        const genre = String(ev?.data?.bounce?.type ?? ev?.data?.type ?? '').toLowerCase();
        const dur = !genre || /hard|permanent|undetermined/.test(genre);
        if (dur) {
          await env.SUBSCRIBERS.put(`bounce:${dest}`, JSON.stringify({ jour, genre: genre || 'inconnu' }));
          await env.SUBSCRIBERS.put(`rebondj:${jour}:${dest}`, '1', { expirationTtl: 30 * 24 * 3600 });
        }
      } else if (type === 'email.complained') {
        await env.SUBSCRIBERS.put(`unsub:prospect:${dest}`, JSON.stringify({ jour, motif: 'plainte' }));
        await env.SUBSCRIBERS.put(`plaintej:${jour}:${dest}`, '1', { expirationTtl: 90 * 24 * 3600 });
      }
      return json({ ok: true, type });
    }

    if (request.method === 'POST' && url.pathname === '/contact-relay') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('key') !== env.CONTACTS_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      if (!env.RESEND_API_KEY) return json({ error: 'no-mailer' }, 503);
      const b = await request.json().catch(() => null);
      if (!b || !b.email || !b.message) return json({ error: 'bad-request' }, 400);
      const propre = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300).trim();
      const de = propre(b.email);
      const sujet = propre(b.subject) || '(sans sujet)';
      const corps = [
        `De      : ${de}`,
        `Sujet   : ${sujet}`,
        `Secteur : ${propre(b.sector) || '—'}`,
        `Langue  : ${propre(b.lang) || '—'}`,
        `Page    : ${propre(b.page) || '—'}`,
        '',
        String(b.message ?? '').slice(0, 20000),
      ].join('\n');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
          to: [REPORT_TO],
          reply_to: de,               // « Répondre » écrit au visiteur, pas au relais
          subject: `[Contact Payotte] ${sujet}`,
          text: corps,
        }),
      }).catch(() => null);
      if (!r || !r.ok) return json({ error: 'send-failed', status: r?.status ?? 0 }, 502);

      // ── ACCUSÉ DE RÉCEPTION AU VISITEUR (2026-08-17, second passage) ─────────────
      // Il partait par mail() côté PHP. Vérifié le jour même : il n'arrive JAMAIS — le
      // mail() de cet hébergement est mort, c'est ce qui a fait perdre les messages.
      // Un visiteur qui n'a aucun accusé récrit, ou renonce. On l'envoie donc par le
      // même Resend, avec le MÊME texte que le PHP (repris mot pour mot).
      // Best-effort : un accusé raté ne doit jamais faire échouer la réception du message,
      // qui est déjà journalisée côté serveur et déjà partie chez le proprio.
      const fr = propre(b.lang) !== 'en';
      const suj = sujet !== '(sans sujet)' ? sujet : '';
      const accuse = fr
        ? ['Bonjour,', '',
           'Merci d’avoir contacté Payotte. Nous avons bien reçu votre message',
           'et vous répondrons par e-mail dès que possible — généralement sous 48 h.', '',
           ...(suj ? [`Objet de votre demande : ${suj}`, ''] : []),
           'Ceci est une confirmation automatique — inutile d’y répondre.', '',
           '— Payotte',
           'L’annuaire indépendant d’experts immobiliers vérifiés au Canada',
           'https://payotte.com']
        : ['Hello,', '',
           'Thank you for contacting Payotte. We’ve received your message and',
           'will reply by email as soon as possible — usually within 48 hours.', '',
           ...(suj ? [`Subject of your request: ${suj}`, ''] : []),
           'This is an automated confirmation — no need to reply.', '',
           '— Payotte',
           'Independent directory of verified real estate experts in Canada',
           'https://payotte.com'];
      const accuseOk = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
          to: [de],
          reply_to: REPORT_TO,          // s'il répond quand même, ça arrive au proprio
          subject: fr ? 'Nous avons bien reçu votre message — Payotte' : 'We’ve received your message — Payotte',
          text: accuse.join('\n'),
          headers: { 'Auto-Submitted': 'auto-replied' },
        }),
      }).then((x) => x.ok).catch(() => false);

      return json({ ok: true, accuse: accuseOk });
    }

    // Dry-run du bulletin (aucun envoi) — rapport d'audience. Protégé par le jeton privé.
    if (request.method === 'GET' && url.pathname === '/bulletin-dryrun') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('key') !== env.CONTACTS_TOKEN) return json({ error: 'unauthorized' }, 401);
      const report = await runBulletin(env, { dryRun: true });
      // `?mail=1` : envoie AUSSI le récapitulatif à REPORT_TO, pour voir le rendu réel du
      // courriel sans qu'un seul bulletin ne parte (dryRun bloque tous les envois en amont).
      if (url.searchParams.get('mail') === '1') await sendRunReport(env, report);
      return json(report);
    }

    // Bulletin de marché (formulaire zéro-JS des pages ville).
    // Dossier de révision d'évaluation foncière (2026-09-28) — ÉTEINT tant que EF_DOSSIER_ACTIF
    // et les secrets Stripe ne sont pas posés ; voir src/dossierRevision.js.
    // ── BANDEAU À DEUX CHOIX des pages d'évaluation foncière (29 sept. 2026) ─────────────
    // Le site (composant BandeauEF.astro) poste ici ; on passe par contacterExpert, donc même
    // double confirmation, mêmes plafonds, rien de conservé après 48 h. Trois compteurs à part,
    // par mois et par province : demandes créées (ef:d), confirmées (ef:c, dans confirmRelay)
    // et renvois vers l'ordre là où Payotte n'a personne (ef:o) — c'est la carte du recrutement.
    if (request.method === 'GET' && url.pathname === '/vi/presence') {
      const r = await handlePresence(request, env, url, { json, bumpCounter });
      r.headers.set('Access-Control-Allow-Origin', '*');
      return r;
    }
    if (request.method === 'POST' && url.pathname === '/vi/suivi') {
      const r = await handleSuivi(request, env, { json, bumpCounter, hmacHex, EMAIL_RE, domainExists, WORKER_ORIGIN, REPORT_TO });
      r.headers.set('Access-Control-Allow-Origin', '*');
      return r;
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/vi/desabonnement') return handleDesabonnement(url, env, { hmacHex });
    if (request.method === 'GET' && url.pathname === '/vi/stats') return handleStats(url, env, { json });
    if (request.method === 'GET' && url.pathname === '/vi/visite') return handleVisite(request, env, url, { bumpCounter });
    // Modèle du courriel mensuel « Test IA », envoyé à GRÉGORY SEUL (REPORT_TO, codé en dur) pour voir le
    // vrai rendu dans Gmail : un brouillon ne le montre pas, la fenêtre de rédaction retire styles et images.
    // C'est Grégory qui déclenche l'envoi (consigne : je ne lui envoie jamais de courriel moi-même).
    // 5 par jour au plus. Ex. : /vi/modele?city=calgary&couverte=0&segment=prospect&lang=fr
    if (request.method === 'GET' && url.pathname === '/vi/modele') {
      if (!env.RESEND_API_KEY) return json({ ok: false, erreur: 'pas de clé Resend' }, 503);
      if ((await bumpCounter(env, `vi:modele:${new Date().toISOString().slice(0, 10)}`, 2 * 86400)) > 5) return json({ ok: false, erreur: 'limite de 5 modèles par jour' }, 429);
      const q = url.searchParams;
      const lang = q.get('lang') === 'en' ? 'en' : 'fr';
      const segment = q.get('segment') === 'expert' ? 'expert' : 'prospect';
      const market = await feed('/api/market.json').catch(() => ({ cities: [] }));
      const cs = strip(q.get('city') || 'calgary');
      const city = market.cities.find((c) => strip(c.slug) === cs);
      if (!city) return json({ ok: false, erreur: 'ville inconnue' }, 404);
      let expert = null;
      if (segment === 'expert') { try { const all = await allExperts(); expert = all.find((e) => strip(e.city) === cs) || null; } catch {} }
      const cv = q.get('couverte'); const villeCouverte = cv === '1' ? true : cv === '0' ? false : null;
      const { subject, html } = renderPulse({ segment, stage: q.get('stage') || 'green', city, expert, lang, unsubUrl: `${SITE}/contact`, postale: adressePostale(env), villeCouverte, metier: q.get('metier') || 'appraiser' });
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM_OUTREACH || env.MAIL_FROM || 'Payotte <relais@payotte.com>', to: [REPORT_TO], subject: `[MODÈLE] ${subject}`, html }),
      }).catch(() => null);
      return json({ ok: !!(r && r.ok), envoyeA: REPORT_TO, sujet: `[MODÈLE] ${subject}` }, r && r.ok ? 200 : 502);
    }
    // Service Visibilité IA : formulaire d'inscription (src/visibiliteIa.js), 5 oct. 2026.
    if (request.method === 'POST' && url.pathname === '/vi/inscription') {
      return handleInscription(request, env, { SITE, REPORT_TO, EMAIL_RE, domainExists, bumpCounter, hmacHex });
    }
    if (request.method === 'POST' && url.pathname === '/ef/demande') {
      const b = await request.json().catch(() => null);
      if (!b || typeof b !== 'object') return json({ error: 'bad-request' }, 400);
      if (b.site) return json({ ok: true });                       // pot de miel : un robot a rempli le champ caché
      const type = b.type === 'contestation' ? 'contestation' : 'estimation';
      const propre = (v, n = 200) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n).trim();
      const fr = b.lang !== 'en';
      const ligne = (lf, le, v) => (propre(v) ? `${fr ? lf : le} : ${propre(v)}` : null);
      const message = [
        fr ? (type === 'contestation' ? 'Objet : je trouve mon évaluation foncière trop haute.' : "Objet : je voudrais une estimation de ma propriété.")
           : (type === 'contestation' ? 'Subject: I think my property assessment is too high.' : 'Subject: I would like an estimate of my home.'),
        ligne('Propriété', 'Property', b.adresse),
        ligne('Type', 'Type', b.typePropriete),
        ligne("Valeur à l'avis", 'Value on notice', b.valeurRole),
        ligne('Valeur que j’estime juste', 'Value I think is right', b.valeurEstimee),
        ligne('Projet', 'Plan', b.projet),
        propre(b.note, 600) ? `\n${propre(b.note, 600)}` : null,
        // Résumé de la réponse immédiate (chiffres publics du rôle), s'il y en a eu une.
        b.resume ? `\n${fr ? 'Ce que Payotte lui a montré (données publiques du rôle)' : 'What Payotte showed them (public roll data)'} :\n${String(b.resume).slice(0, 900)}` : null,
      ].filter(Boolean).join('\n');
      const slug = propre(b.slug, 120);
      const prof = slug.split('--')[0];
      if (!['real-estate-broker', 'appraiser'].includes(prof)) return json({ error: 'bad-expert' }, 400);
      // ── La demande part à GRÉGORY, pas au pro (décision du 29 sept. 2026) ─────────────────────
      // « J'aimerais mieux que le site m'envoie le formulaire que je vais transférer afin d'être sûr
      // d'avoir une réponse et que le client est pris en main. » Le pro suggéré, sa fiche et son
      // courriel sont joints pour qu'il transfère en un clic ; « Répondre » écrit au client.
      // Pas de clic de confirmation : c'est Grégory qui fait le tri. Garde-fous : pot de miel,
      // domaine réel, 5 demandes par jour et par courriel (empreinte HMAC), consentement coché.
      const E = (f, e) => (fr ? f : e);
      if (b.consentement !== true) return json({ error: E('Cochez la case de consentement.', 'Please tick the consent box.') }, 400);
      const nom = propre(b.nom, 120);
      const courriel = propre(b.courriel).toLowerCase();
      if (!nom || !EMAIL_RE.test(courriel)) return json({ error: E('Nom et courriel valide requis.', 'Name and a valid email are required.') }, 400);
      if (looksLikeSpam(message)) return json({ error: E('Trop de liens dans le message.', 'Too many links in the message.') }, 400);
      if (!(await domainExists(courriel))) return json({ error: E(`Le domaine « ${courriel.split('@')[1]} » n'existe pas : vérifiez votre courriel.`, `The domain "${courriel.split('@')[1]}" does not exist: check your email.`) }, 400);
      if (!env.RESEND_API_KEY) return json({ ok: true, simulated: true });
      const jour = new Date().toISOString().slice(0, 10);
      if (env.COUNTERS) {
        const rh = (await hmacHex(env, courriel)).slice(0, 16);
        if ((await bumpCounter(env, `efr:${rh}:${jour}`, 3 * 86400)) > DAY_CAP_REQUESTER) return json({ error: E('Limite de demandes atteinte pour aujourd’hui.', 'Daily request limit reached.') }, 429);
      }
      // Le pro suggéré (et son courriel, relu à la source, pour le transfert).
      let pro = null, contact = null;
      try {
        const rr = await resolveExperts({ profession: prof, province: propre(b.province, 60), ville: propre(b.ville, 80), secteur: propre(b.secteur, 80) });
        pro = rr.matches?.length === 1 ? rr.matches[0] : null;
        if (pro && env.CONTACTS_TOKEN) contact = (await feed(`/api/cx/${env.CONTACTS_TOKEN}.json`)).contacts?.[pro.slug] ?? null;
      } catch { /* on envoie quand même, sans le pro */ }
      const tel = propre(b.tel, 40);
      const corps = [
        `Nouvelle demande du bandeau Évaluation foncière — ${type === 'contestation' ? 'CONTESTATION (évaluation trop haute)' : 'ESTIMATION (combien vaut ma maison)'}`,
        '',
        `Client : ${nom}`, `Courriel : ${courriel}`, ...(tel ? [`Téléphone : ${tel}`] : []),
        `Langue : ${fr ? 'français' : 'anglais'}`, `Page : ${SITE}${propre(b.page, 200)}`,
        '',
        message,
        '',
        pro
          ? `Pro suggéré : ${pro.name} (${pro.professionLabel}, ${pro.sectorName}, ${pro.cityName})\nFiche : ${pro.url}\nCourriel du pro : ${contact?.email ?? '— (aucun au dossier)'}`
          : `Pro suggéré : aucun résolu (${prof}, ${propre(b.ville, 80)} / ${propre(b.secteur, 80)})`,
        '',
        '— « Répondre » écrit directement au client. Pour transférer au pro : Transférer, à l’adresse ci-dessus.',
      ].join('\n');
      const envoi = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
          to: [REPORT_TO],
          reply_to: courriel,
          subject: `[Bandeau EF] ${type === 'contestation' ? 'Contestation' : 'Estimation'} — ${nom}${pro ? ` → ${pro.name}` : ''}`,
          text: corps,
        }),
      }).catch(() => null);
      if (!envoi || !envoi.ok) return json({ error: E('L’envoi n’a pas fonctionné, réessayez dans un instant.', 'Sending failed, please try again shortly.') }, 502);
      // Accusé au client : il sait que quelqu'un a sa demande en main.
      const qui = pro ? `${pro.name} (${pro.professionLabel}, ${pro.sectorName})` : '';
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
          to: [courriel],
          reply_to: REPORT_TO,
          subject: E('Nous avons bien reçu votre demande — Payotte', 'We received your request — Payotte'),
          text: (fr
            ? [`Bonjour ${nom},`, '', `Nous avons bien reçu votre demande${qui ? ` pour ${qui}` : ''}. Payotte la transmet et s'assure que vous obteniez une réponse, généralement sous 48 h ouvrables.`, '', 'Une question d’ici là ? Répondez simplement à ce courriel.', '', '— Grégory Payotte, fondateur', 'https://payotte.com']
            : [`Hello ${nom},`, '', `We received your request${qui ? ` for ${qui}` : ''}. Payotte forwards it and makes sure you get an answer, usually within 48 business hours.`, '', 'Any question in the meantime? Just reply to this email.', '', '— Grégory Payotte, founder', 'https://payotte.com']).join('\n'),
          headers: { 'Auto-Submitted': 'auto-replied' },
        }),
      }).catch(() => null);
      const mois = new Date().toISOString().slice(0, 7);
      await bumpCounter(env, `ef:d:${type}:${propre(b.province, 60)}:${mois}`, 400 * 86400);
      // Le verdict que la personne avait sous les yeux : la conversion « nettement au-dessus » → formulaire.
      const vu = ['eleve', 'au-dessus', 'norme', 'plusieurs'].includes(b.signal) ? b.signal : 'aucun';
      await bumpCounter(env, `efdv:${type}:${propre(b.province, 60)}:${vu}:${mois}`, 400 * 86400);
      return json({ ok: true });
    }
    // ── Mesure du bandeau (29 sept. 2026) : compteurs par verdict + avis à Grégory à chaque
    // recherche aboutie. RIEN de personnel : ni adresse, ni valeur, ni IP — /privacy promet que
    // les recherches d'adresse ne sont pas conservées, et un courriel dans une boîte en serait une.
    // Plafond de 100 avis par jour (un robot ne remplit pas la boîte) ; au-delà, seuls les compteurs montent.
    const efMesurer = async (niveau, prov, bouton, verdict, muni, usage) => {
      const mois = new Date().toISOString().slice(0, 7), jour = new Date().toISOString().slice(0, 10);
      await bumpCounter(env, `efs:${niveau}:${prov}:${bouton}:${verdict}:${mois}`, 400 * 86400);
      if (!env.RESEND_API_KEY || !env.COUNTERS) return;
      if ((await bumpCounter(env, `efn:${jour}`, 2 * 86400)) > 100) return;
      const V = { eleve: 'NETTEMENT AU-DESSUS', 'au-dessus': 'un peu au-dessus', norme: 'dans la norme', aucun: 'sans verdict', plusieurs: 'plusieurs unités à choisir' };
      const heure = new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' });
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
          to: [REPORT_TO],
          subject: `[Bandeau EF · recherche] ${bouton === 'contestation' ? 'Statut' : bouton === 'unique' ? 'Évaluation' : 'Estimation'} · ${muni} · ${V[verdict] ?? verdict}`,
          text: [
            `Une recherche vient d'aboutir dans le bandeau (${heure}).`, '',
            `Bouton : ${bouton === 'contestation' ? 'Voir le statut de l’évaluation' : 'Voir une estimation gratuite'}`,
            `Niveau : ${niveau === 'adresse' ? 'réponse à l’adresse' : 'filet Statistique Canada (valeur saisie)'}`,
            `Province : ${prov.toUpperCase()} · Municipalité : ${muni}`,
            `Type : ${usage || '—'} · Verdict : ${V[verdict] ?? verdict}`, '',
            'Aucune adresse ni valeur n’est transmise (engagement de /privacy).',
            `Totaux du mois : ${WORKER_ORIGIN}/ef/bandeau-stats?key=… (clé CONTACTS_TOKEN)`,
          ].join('\n'),
        }),
      }).catch(() => null);
    };

    // Réponse immédiate à l'adresse (bandeau EF) — src/efAdresse.js.
    if (request.method === 'GET' && url.pathname === '/ef/munis') {
      const l = await efMunis(env, String(url.searchParams.get('prov') ?? ''));
      return l ? new Response(JSON.stringify(l), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }) : json({ error: 'not-covered' }, 404);
    }
    // ── TAXE DE BIENVENUE À L'ADRESSE (29 sept. 2026) ─────────────────────────────────────
    // Québec (D-15.1, art. 2 al. 2 et art. 1.1) : base = le plus élevé du prix et de la valeur au
    // rôle × facteur comparatif de l'année. N.-B. (R-2.1, art. 2(1.03)) : 1 % du plus élevé du prix
    // et de la valeur évaluée. Ailleurs, la valeur au rôle n'est PAS un plancher : calcul sur le prix.
    // Faits : ~/Payotte/donnees-evaluation-fonciere/FAITS-taxe-mutation-base.md.
    if (request.method === 'GET' && url.pathname === '/ef/taxe') {
      const q = url.searchParams, lang = q.get('lang') === 'en' ? 'en' : 'fr', L = (f, e) => (lang === 'fr' ? f : e);
      const prov = String(q.get('prov') ?? ''), prix = Number(String(q.get('prix') ?? '').replace(/[^\d.]/g, ''));
      if (!(prix > 1000)) return json({ error: L('Indiquez le prix d’achat.', 'Enter the purchase price.') }, 400);
      const PROVS = { qc: 'quebec', nb: 'new-brunswick', ns: 'nova-scotia', ab: 'alberta', mb: 'manitoba', on: 'ontario', bc: 'british-columbia', sk: 'saskatchewan', pe: 'prince-edward-island', nl: 'newfoundland-and-labrador' };
      if (!PROVS[prov]) return json({ error: 'province' }, 400);
      // 1. Le logement et sa valeur au rôle (si une adresse est donnée et que la province est couverte).
      let unite = null, facteur = null;
      if (q.get('q') && q.get('muni') && ['qc', 'nb'].includes(prov)) {
        const r = await efAdresse(env, url, request, { hmacHex, bumpCounter, feed });
        if (r.error) return json(r, 400);
        if (r.suggestions?.length || !r.resultats?.length) return json(r);
        if (r.resultats.length > 1) return json({ resultats: r.resultats.map((x) => ({ adresse: x.adresse, type: x.type, valeur: x.valeur })), plusieurs: true, sansApt: r.sansApt });
        unite = r.resultats[0];
        // Le RFU du MAMH arrondit à 2 décimales ; une ville qui publie plus précis fait foi (Laval : 1,032 en 2026).
        const FACTEURS_VILLE = { '65005': 1.032 };
        facteur = prov === 'qc' ? (FACTEURS_VILLE[q.get('muni')] ?? (unite.ordre?.methode === 'facteur' ? unite.ordre.facteur : null)) : 1;
      }
      const plancher = unite && facteur ? Math.round(unite.valeur * facteur) : null;
      const base = Math.max(prix, plancher ?? 0);
      // 2. Le barème : taux municipaux 2026 relevés sur les sites des villes (Québec), sinon l'outil taxe_mutation.
      const QC_VILLES = {
        '66023': [[62900, 0.005], [315000, 0.01], [552300, 0.015], [1104700, 0.02], [2136500, 0.025], [3113000, 0.035], [Infinity, 0.04]],
        '23027': [[62900, 0.005], [315000, 0.01], [500000, 0.015], [750000, 0.025], [Infinity, 0.03]],
        '65005': [[62900, 0.005], [315000, 0.01], [500000, 0.015], [Infinity, 0.03]],
        '81017': [[62900, 0.005], [315000, 0.01], [500000, 0.015], [Infinity, 0.03]],
        '58227': [[62900, 0.005], [315000, 0.01], [630100, 0.015], [Infinity, 0.03]],
      };
      let taxe, noteBareme;
      if (prov === 'qc') {
        const grille = QC_VILLES[q.get('muni')];
        taxe = Math.round(bracketTax(base, grille ?? LTT_QC_BASE));
        noteBareme = grille ? L('Barème 2026 de la municipalité (taux au-delà de 500 000 $ fixés par règlement).', 'The municipality’s 2026 schedule (rates above $500,000 set by by-law).')
          : (base > 500000 ? L('Barème de base 2026. Au-delà de 500 000 $, votre municipalité peut appliquer un taux plus élevé (jusqu’à 3 %) : c’est un minimum.', 'Base 2026 schedule. Above $500,000 your municipality may charge a higher rate (up to 3%): this is a minimum.') : L('Barème de base 2026 du Québec.', 'Quebec base 2026 schedule.'));
      } else {
        const t = await taxeMutation({ prix: base, province: PROVS[prov] });
        if (t.error) return json({ error: t.error }, 400);
        taxe = t.tax; noteBareme = t.note;
      }
      // 3. Crédit québécois pour premier acheteur (acquisitions depuis le 1er janv. 2026) : 100 % des 5 000 premiers $, 25 % des 3 500 suivants.
      const credit = prov === 'qc' && taxe != null ? Math.round(Math.min(taxe, 5000) + 0.25 * Math.min(Math.max(taxe - 5000, 0), 3500)) : null;
      const plancherLegal = ['qc', 'nb'].includes(prov);
      return json({
        prov, prix, unite: unite ? { adresse: unite.adresse, municipalite: unite.municipalite, type: unite.type, valeur: unite.valeur, dateValeur: unite.dateValeur } : null,
        facteur, plancher, base, baseVient: plancher != null && plancher > prix ? 'plancher' : 'prix', taxe, noteBareme,
        creditPremierAcheteur: credit,
        regle: plancherLegal
          ? L(prov === 'qc' ? 'Au Québec, la taxe se calcule sur le plus élevé du prix et de la valeur au rôle multipliée par le facteur comparatif de l’année (Loi concernant les droits sur les mutations immobilières, art. 2 et 1.1).' : 'Au Nouveau-Brunswick, la taxe est de 1 % du plus élevé du prix et de la valeur évaluée (Real Property Transfer Tax Act, art. 2(1.03)).',
              prov === 'qc' ? 'In Quebec, the tax is computed on the greater of the price and the assessed value times the year’s comparative factor (Act respecting duties on transfers of immovables, s. 2 and 1.1).' : 'In New Brunswick, the tax is 1% of the greater of the price and the assessed value (Real Property Transfer Tax Act, s. 2(1.03)).')
          : L('Dans cette province, la taxe se calcule sur le prix : la valeur au rôle n’en est pas le plancher.', 'In this province, the tax is computed on the price: the assessed value is not a floor.'),
        verification: L('Le montant exact figure sur le compte de la municipalité et se confirme avec le notaire ou l’avocat.', 'The exact amount is on the municipality’s bill and is confirmed by the notary or lawyer.'),
      });
    }
    // ── RISQUES SELON L'ANNÉE DE CONSTRUCTION (29 sept. 2026) ─────────────────────────────
    // 24 risques documentés par des sources officielles (Santé Canada, RNCan, ESA, RBQ, villes…),
    // ~/Payotte/donnees-evaluation-fonciere/risques-par-epoque.json. L'année vient de l'adresse
    // (rôle ouvert) ou de la personne. On liste ce que l'époque EXPOSE à vérifier, jamais un diagnostic.
    if (request.method === 'GET' && url.pathname === '/ef/risques') {
      const q = url.searchParams, lang = q.get('lang') === 'en' ? 'en' : 'fr', L = (f, e) => (lang === 'fr' ? f : e);
      const prov = String(q.get('prov') ?? '');
      let annee = Number(q.get('annee')) || null, muniNom = String(q.get('muniNom') ?? ''), unite = null;
      if (q.get('q') && q.get('muni')) {
        const r = await efAdresse(env, url, request, { hmacHex, bumpCounter, feed });
        if (r.error) return json(r, 400);
        if (r.suggestions?.length || !r.resultats?.length) return json(r);
        unite = r.resultats[0];
        annee = unite.annee ?? annee;
        muniNom = unite.municipalite;
      }
      if (!annee) return json({ error: L("Année de construction inconnue pour cette adresse : indiquez-la.", 'Construction year unknown for this address: enter it.'), besoinAnnee: true, unite }, 400);
      // Région administrative (Québec) pour la pyrrhotite : tirée du calendrier des municipalités.
      let region = null;
      if (prov === 'qc' && q.get('muni')) {
        try { const d = await feed('/api/evaluation-fonciere-quebec.json'); region = d.municipalites.find((m) => m.code === q.get('muni'))?.region ?? null; } catch { /* sans région */ }
      }
      const nm = strip(muniNom);
      const dansPlage = (r) => (r.debut == null || annee >= r.debut) && (r.fin == null || annee <= r.fin);
      const lieuOk = (r) => (!r.provinces || r.provinces.includes(prov))
        && (!r.municipalites || r.municipalites.some((m) => strip(m) === nm || nm.startsWith(strip(m))))
        && (!r.regions || (region && r.regions.some((g) => strip(region).includes(strip(g)))));
      const epoque = [], toujours = [];
      for (const r of RISQUES_EPOQUE) {
        if (!lieuOk(r) || !dansPlage(r)) continue;
        const item = { id: r.id, nom: r[`nom_${lang}`], resume: r[`resume_${lang}`], verification: r[`verification_${lang}`], source: { nom: r.source_nom, url: r.source_url }, certitude: r.certitude,
          periode: r.debut == null && r.fin == null ? null : `${r.debut ?? L('avant', 'before')}${r.debut != null && r.fin != null ? '–' : ' '}${r.fin != null ? (r.debut == null ? r.fin + 1 : r.fin) : ''}`.trim() };
        (r.debut == null && r.fin == null ? toujours : epoque).push(item);
      }
      const mois = new Date().toISOString().slice(0, 7);
      ctx?.waitUntil(bumpCounter(env, `efs:risques:${prov}:${epoque.length ? 'expose' : 'aucun'}:${mois}`, 400 * 86400));
      return json({
        annee, anneeVient: unite?.annee ? 'role' : 'saisie', municipalite: muniNom || null, region,
        unite: unite ? { adresse: unite.adresse, type: unite.type } : null,
        epoque, toujours,
        note: L("Ces points viennent de l'époque de construction, pas d'une visite : une rénovation a pu les régler, ou en créer d'autres. Seule une inspection le confirme.", 'These points come from the construction era, not a visit: a renovation may have fixed them, or created others. Only an inspection confirms it.'),
      });
    }
    if (request.method === 'GET' && url.pathname === '/ef/filet-munis') {
      const l = await efFiletMunis(env, String(url.searchParams.get('prov') ?? ''));
      return l ? new Response(JSON.stringify(l), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }) : json({ error: 'not-covered' }, 404);
    }
    if (request.method === 'GET' && url.pathname === '/ef/filet') {
      const r = await efFilet(env, url, { feed });
      if (!r.error) {
        const tq = url.searchParams.get('t');
        const bouton = tq === 'contestation' ? 'contestation' : tq === 'unique' ? 'unique' : 'estimation';
        ctx?.waitUntil(efMesurer('filet', String(url.searchParams.get('prov')), bouton, r.signal ?? 'aucun', r.municipalite, r.groupe));
      }
      return json(r, r.error ? 400 : 200);
    }
    if (request.method === 'GET' && url.pathname === '/ef/adresse') {
      const r = await efAdresse(env, url, request, { hmacHex, bumpCounter, feed });
      if (!r.error && url.searchParams.get('prov') === 'qc') {
        for (const x of r.resultats ?? []) x.economie = efEconomie(x, String(url.searchParams.get('muni') ?? ''));
      }
      if (!r.error && r.resultats?.length) {
        const x = r.resultats[0];
        const tq = url.searchParams.get('t');
        const bouton = tq === 'contestation' ? 'contestation' : tq === 'unique' ? 'unique' : 'estimation';
        const verdict = r.resultats.length > 1 ? 'plusieurs' : (x.signal ?? 'aucun');
        ctx?.waitUntil(efMesurer('adresse', String(url.searchParams.get('prov')), bouton, verdict, x.municipalite, x.type));
      }
      return json(r, r.error ? 400 : 200);
    }
    // Le choix APRÈS la réponse (30 sept. 2026 : un seul bouton, le professionnel se choisit au vu du
    // verdict). Compteur seulement : type choisi × province × verdict, par mois. Rien de personnel.
    if (request.method === 'GET' && url.pathname === '/ef/choix') {
      const t = url.searchParams.get('t') === 'contestation' ? 'contestation' : 'estimation';
      const prov = String(url.searchParams.get('p') ?? '').replace(/[^a-z-]/g, '').slice(0, 40) || 'inconnue';
      const v = ['eleve', 'au-dessus', 'norme'].includes(String(url.searchParams.get('v'))) ? url.searchParams.get('v') : 'aucun';
      await bumpCounter(env, `ef:ch:${t}:${prov}:${v}:${new Date().toISOString().slice(0, 7)}`, 400 * 86400);
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (request.method === 'GET' && url.pathname === '/ef/renvoi') {
      const u = String(url.searchParams.get('u') ?? '');
      const permis = ['https://oeaq.qc.ca/', 'https://www.aicanada.ca/', 'https://registre.oaciq.com/', 'https://registrantsearch.reco.on.ca/',
        'https://www.reca.ca/', 'https://www.bcfsa.ca/', 'https://fcnb.ca/', 'https://www.nsrec.ns.ca/', 'https://www.srec.ca/'];
      if (!permis.some((x) => u.startsWith(x))) return Response.redirect(SITE, 302);   // jamais un redirecteur ouvert
      const t = url.searchParams.get('t') === 'contestation' ? 'contestation' : 'estimation';
      const prov = String(url.searchParams.get('p') ?? '').replace(/[^a-z-]/g, '').slice(0, 40) || 'inconnue';
      await bumpCounter(env, `ef:o:${t}:${prov}:${new Date().toISOString().slice(0, 7)}`, 400 * 86400);
      return Response.redirect(u, 302);
    }
    if (request.method === 'GET' && url.pathname === '/ef/bandeau-stats') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('key') !== env.CONTACTS_TOKEN) return json({ error: 'unauthorized' }, 401);
      const out = {};
      for (const pre of ['ef:d:', 'ef:c:', 'ef:o:', 'ef:ch:', 'efs:', 'efdv:']) {
        const l = await env.COUNTERS.list({ prefix: pre });
        for (const k of l.keys) out[k.name] = parseInt((await env.COUNTERS.get(k.name)) ?? '0', 10);
      }
      return json(out);
    }

    if (url.pathname.startsWith('/ef/')) {
      const r = await handleDossierRevision(request, env, url, { SITE, efMunicipalite, EF_FRAIS, efPalier, EF_TAQ_2026, strip });
      if (r) return r;
    }
    if (request.method === 'POST' && url.pathname === '/subscribe') return handleSubscribe(request, env, url);
    // Alerte taux : POST depuis un formulaire, GET en un clic depuis le bulletin (HMAC).
    if (url.pathname === '/alerte-taux' && (request.method === 'POST' || request.method === 'GET')) return handleAlerteTauxInscription(request, env, url);
    // POST accepté aussi : Gmail et Outlook déclenchent le désabonnement en un clic
    // (List-Unsubscribe-Post) sans jamais ouvrir la page.
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/unsubscribe') return handleUnsubscribe(env, url);

    // Double opt-in du relais de contact : le clic humain qui transmet la demande à l'expert.
    if (request.method === 'GET' && url.pathname === '/confirm') return confirmRelay(env, url);

    // Page d'accueil / découverte humaine.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/mcp')) {
      return json({
        ...SERVER_INFO,
        description: INSTRUCTIONS,
        transport: 'streamable-http (stateless)',
        endpoint: `${url.origin}/mcp`,
        tools: TOOLS.map((t) => t.name),
        dataSource: `${SITE}/api/experts.json`,
        license: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: ATTRIBUTION,
      });
    }

    if (request.method !== 'POST' || (url.pathname !== '/mcp' && url.pathname !== '/')) {
      return json({ error: 'POST JSON-RPC 2.0 messages to /mcp' }, 405);
    }

    let msg;
    try {
      msg = await request.json();
    } catch {
      return rpcError(null, -32700, 'Parse error: invalid JSON');
    }
    if (Array.isArray(msg)) {
      // Le transport Streamable HTTP 2025-06-18 n'utilise plus les lots JSON-RPC.
      return rpcError(null, -32600, 'Batch requests are not supported');
    }
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg?.id, -32600, 'Invalid JSON-RPC 2.0 request');
    }
    return handleRpc(msg, env);
  },

  // Bulletin : cron HORAIRE sur 12-18 h UTC, cycle MENSUEL, envoi à 10 h CHEZ LE DESTINATAIRE.
  // Chaque passage ne sert que les provinces où il est 10 h locale (zonesAt10h) et n'y prend
  // que ceux qui n'ont pas encore reçu leur courriel du mois, dans la limite du budget de
  // sous-requêtes ET du plafond quotidien global. La vague met une douzaine de jours, puis les
  // exécutions tournent à vide jusqu'au 1er. Villes actives = celles qui ont un prix de
  // référence — filtrées, à chaque passage, par le fuseau horaire.
  async scheduled(event, env, ctx) {
    if (!env.RESEND_API_KEY) return;   // sans clé : aucun envoi (le dry-run reste dispo par route)
    // Le déclencheur tourne aux 10 minutes ; hors des heures CRON_HEURES_10_MIN_UTC, seuls
    // :00 et :30 travaillent — les autres minutes repartent avant toute lecture KV.
    const instant = new Date(event.scheduledTime ?? Date.now());
    if (!passageCronActif(instant, env)) {
      // Créneau inactif : il ne sert qu'à faire avancer la reprise de septembre, s'il en reste.
      const cycleInstant = instant.toISOString().slice(0, 7);
      if (cycleInstant === '2026-09') {
        try {
          // Créneau vide : rien d'autre ne tourne, le pas peut prendre 22 s au lieu de 12
          // (14 pages par pas mesurées le 30 sept. : ~250 pages = 3 h de prospects bloqués).
          const e = await pasRepriseResend(env, cycleInstant, { maxSubs: 45, dureeMs: 22000, pauseMs: 300 });
          if (e.actif) console.log(`[reprise-resend] ${e.pages} pages, ${e.emails.length} adresses${e.fini ? `, FINI (${e.marques} marques)` : ''}${e.erreur ? ` — ${e.erreur}` : ''}`);
        } catch (err) { console.log(`[reprise-resend] ERREUR : ${err?.message ?? err}`); }
      }
      return;
    }
    // L'ALERTE TAUX passe avant tout le reste : c'est le seul envoi daté par un ÉVÉNEMENT
    // (la Banque du Canada a bougé) et non par un calendrier qu'on choisit. Un bulletin
    // décalé d'une heure ne coûte rien ; une alerte de taux décalée n'est plus une alerte.
    // Coût quand rien ne bouge — 361 jours sur 365 : une lecture KV et un appel Valet mis
    // en cache. `try` isolé : elle ne doit jamais emporter les autres envois.
    try {
      const alerte = await runAlerteTaux(env, { at: new Date() });
      if (alerte.change) {
        console.log(`[alerte-taux] ${alerte.ancien} % → ${alerte.nouveau} % (${alerte.observed}) — `
          + (alerte.arrete ? `ARRÊTÉ (${alerte.arrete}), mouvement enregistré sans envoi`
            : `${alerte.envoyes} envoyée(s), ${alerte.rates} ratée(s) sur ${alerte.audience} · `
              + `${Object.entries(alerte.parSegment).map(([k, v]) => `${k} ${v}`).join(' · ')}`
              + (alerte.vagueFinie ? ` · TERMINÉ (${alerte.totalVague} au total)` : ' · REPRISE au prochain passage')));
      } else if (alerte.note) {
        console.log(`[alerte-taux] ${alerte.note}`);
      }
    } catch (err) {
      console.log(`[alerte-taux] ERREUR : ${err?.message ?? err}`);
    }

    // Suivi mensuel Visibilité IA (src/visibiliteIa.js) : budget court, try isolé, respecte stop:all.
    try {
      const vs = await passerSuivi(env, { hmacHex, bumpCounter, WORKER_ORIGIN, REPORT_TO }, { budgetMs: 8000 });
      if (vs.envoyes || vs.arrete || vs.quota) console.log(`[vi-suivi] ${vs.envoyes} envoyé(s)${vs.arrete ? ` — ARRÊTÉ (${vs.arrete})` : ''}${vs.quota ? ' — quota Gemini atteint' : ''}`);
    } catch (err) { console.log(`[vi-suivi] ERREUR : ${err?.message ?? err}`); }

    // La séquence AVANT le bulletin : elle porte une date promise (mardi 10 h locale),
    // le bulletin s'étale sur le mois. À budget contraint, la date passe devant.
    // `try` isolé : une séquence qui échoue ne doit jamais emporter le bulletin avec elle.
    try {
      const seq = await runSequence(env, { at: new Date() });
      if (seq.envoyes || seq.rates) {
        console.log(`[séquence] ${seq.vague} — ${seq.envoyes} envoyés, ${seq.rates} ratés, `
          + `${Object.entries(seq.parEtape).map(([k, v]) => `${k} ${v}`).join(' · ')}`
          + (seq.sorties.length ? ` — sorties : ${seq.sorties.join(', ')}` : ''));
        await envoyerRapportSequence(env, seq).catch(() => {});
      }
    } catch (err) {
      console.log(`[séquence] ERREUR : ${err?.message ?? err}`);
    }
    /* ── LE RAPPORT « ZÉRO » (8 sept. 2026) ────────────────────────────────────
     * Cette ligne etait `await runBulletin(env, { dryRun: false });` — sans try/catch
     * et sans lire le retour. Deux consequences, toutes deux payees le 8 septembre :
     *   · une exception dans runBulletin tuait l'execution EN SILENCE. Le passage de
     *     17 h UTC n'a rien envoye ce jour-la et rien, nulle part, n'a dit pourquoi ;
     *   · quand la fonction s'arretait normalement sans rien faire (aucune province a
     *     10 h, budget epuise, flux coupe), le journal restait vide lui aussi. On ne
     *     pouvait pas distinguer « il n'a rien eu a faire » de « il est mort ».
     * Le council du 18 aout l'avait nomme : « pas de rapport zero quotidien,
     * scheduled() sans try/catch ». Voici les deux.
     * ⚠ NE PAS retirer le catch : une exception ici doit etre VUE, pas propagee — le
     * reste du handler (alerte taux, sequence) a deja tourne. */
    try {
      const r = await runBulletin(env, { dryRun: false });
      const ex = r?.experts ? Object.entries(r.experts).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(' ') : '';
      console.log(`[bulletin] fin — ${r?.arrete ? `ARRETE (${r.arrete}: ${r.motif})` : ''}`
        + ` villes:${r?.activeCities ?? 0} tentatives:${r?.attempts ?? 0}`
        + ` prospects:${r?.prospects ?? 0} experts:${ex || 0}`
        + ` en-attente:${r?.pending ?? 0} sautes:${(r?.skipped || []).length}`);
    } catch (err) {
      console.error('[bulletin] EXCEPTION —', err?.stack || err?.message || String(err));
    }
  },
};

export default WORKER_MAIN;
