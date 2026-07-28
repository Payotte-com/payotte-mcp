/**
 * payotte-mcp — serveur MCP (Model Context Protocol) de Payotte.
 *
 * Cloudflare Worker SANS ÉTAT, transport Streamable HTTP (POST JSON-RPC → réponse JSON).
 * Le worker ne stocke RIEN : il lit en direct les feeds statiques de payotte.com
 * (/api/experts.json, /api/regulators.json, /api/market.json), régénérés à chaque
 * déploiement du site → zéro maintenance ici.
 *
 * 8 outils : trouver_expert · verifier_titre · stats_marche · taux_courants · contacter_expert
 * · taxe_mutation · acheter_ou_louer · salaire_requis.
 * taux_courants lit les taux d'intérêt canadiens en direct à la Banque du Canada (Valet).
 * Les 3 outils de calcul (taxe/louer-acheter/salaire) appliquent une arithmétique PUBLIÉE
 * (mêmes hypothèses que les dossiers payotte.com correspondants) aux prix des chambres,
 * aux loyers SCHL et aux taux BdC — chaque réponse énonce ses hypothèses et ses limites.
 * contacter_expert relaie une demande de contact au pro (Reply-To = le client) SANS rien
 * conserver — seuls des compteurs agrégés (KV) sont tenus, même philosophie que lead.php.
 * Licence des données : CC BY 4.0 — chaque réponse porte l'attribution.
 */

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
  version: '1.4.0',
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
    cf: { cacheTtl: 3600, cacheEverything: true },
    headers: { 'User-Agent': 'payotte-mcp/1.0 (+https://payotte.com)' },
  });
  if (!res.ok) throw new Error(`Upstream ${path} returned HTTP ${res.status}`);
  return res.json();
}

async function allExperts() {
  const manifest = await feed('/api/experts.json');
  const lists = await Promise.all(
    manifest.provinces.map((p) =>
      feed(`/api/experts/${p.slug}.json`).then((d) => d.experts ?? []).catch(() => []),
    ),
  );
  return lists.flat();
}

// ---------------------------------------------------------------- les 3 outils

const TOOLS = [
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
      'Compiled by Payotte from real-estate board and CREA publications; each city lists its sources.',
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
      'variable). Read live from the Bank of Canada (Valet API); each rate carries its own ' +
      'observation date. Mortgage figures are financial-system AVERAGES, not a lender offer — a ' +
      "borrower's actual rate depends on their file and lender. Source: Bank of Canada.",
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
  // Verdict acheteur/équilibré/vendeur — convention standard des chambres (ACI) :
  // < 4 mois d'inventaire = vendeurs, 4-6 = équilibré, > 6 = acheteurs.
  const moi = city.monthsOfInventory;
  const marketBalance = moi == null ? null : {
    verdict: moi < 4 ? "seller's market" : moi <= 6 ? 'balanced market' : "buyer's market",
    monthsOfInventory: moi,
    convention: 'Standard board convention: under 4 months of inventory = seller’s, 4-6 = balanced, over 6 = buyer’s.',
  };
  return { attribution: ATTRIBUTION, city, marketBalance, browseListings: browseListings(city.province, city.slug) };
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
    headers: { 'User-Agent': 'payotte-mcp/1.3 (+https://payotte.com)' },
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
    quebec: 'Refundable provincial credit up to $1,400 (TP-752.HA); Montreal has the targeted Accès Habitation program. Federal HBTC adds up to $1,500 everywhere.',
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
    case 'alberta': {
      const fees = Math.round(50 + Math.ceil(price / 5000) * 2 + 50 + Math.ceil((price * 0.8) / 5000) * 1.5);
      return { ...common, province: 'Alberta', city: city?.name ?? null, tax: fees, isRegistrationFeesOnly: true, note: 'Alberta charges NO land transfer tax — only modest land-title and mortgage registration fees (computed here with a 20% down payment). One of only two such provinces, with Saskatchewan.' };
    }
    case 'saskatchewan': {
      const fees = Math.round(price * 0.003 + 160);
      return { ...common, province: 'Saskatchewan', city: city?.name ?? null, tax: fees, isRegistrationFeesOnly: true, note: 'Saskatchewan charges NO land transfer tax — only title fees (0.30% above $8,400) and a $160 mortgage registration fee.' };
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

const BOC_ATTRIBUTION =
  'Rate data © Bank of Canada (Valet API), used under the Bank of Canada terms of use ' +
  '(https://www.bankofcanada.ca/terms/); relayed by Payotte (https://payotte.com).';

async function tauxCourants() {
  const results = await Promise.all(
    RATE_SERIES.map(async (s) => {
      try {
        const res = await fetch(`https://www.bankofcanada.ca/valet/observations/${s.id}/json?recent=1`, {
          cf: { cacheTtl: 3600, cacheEverything: true },
          headers: { 'User-Agent': 'payotte-mcp/1.1 (+https://payotte.com)' },
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
  // Décisions récentes + prochaines annonces : lues sur le feed du site (une source, déjà daté).
  let rateDecisions = [], upcomingDecisions = [], lastChange = null;
  try {
    const feedData = await feed('/api/rates.json');
    rateDecisions = (feedData.rateDecisions ?? []).slice(0, 6);
    upcomingDecisions = feedData.upcomingDecisions ?? [];
    lastChange = feedData.lastChange ?? null;
  } catch { /* le feed peut être indisponible : les taux live suffisent */ }

  return {
    attribution: BOC_ATTRIBUTION,
    dataSource: 'Bank of Canada',
    note: 'Mortgage rates are financial-system averages, not a lender offer; each rate carries its own observation date. For a verified mortgage broker, use trouver_expert.',
    rates: Object.fromEntries(results),
    lastChange,
    recentDecisions: rateDecisions,
    upcomingDecisions,
  };
}

// ---------------------------------------------------------------- contacter_expert

const DAY_CAP_GLOBAL = 40;      // marge sous le palier Resend gratuit (100/jour)
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

async function bumpCounter(env, key, ttlSeconds) {
  if (!env?.COUNTERS) return 0; // dev local sans KV
  const n = parseInt((await env.COUNTERS.get(key)) ?? '0', 10) + 1;
  await env.COUNTERS.put(key, String(n), { expirationTtl: ttlSeconds });
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
            `Votre assistant IA a préparé, avec votre accord, une demande de contact pour ${expert.name} (${expert.professionLabel}, ${expert.sectorName}, ${expert.cityName}).`, '',
            `Votre message :`, message, '',
            `Pour la transmettre, cliquez (valide 48 h) :`, confirmUrl, '',
            `Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel — RIEN ne sera envoyé sans ce clic.`, '',
            `Payotte ne conserve pas le contenu de votre demande. https://payotte.com`,
          ]
        : [
            `Hello ${nom},`, '',
            `Your AI assistant prepared, with your approval, a contact request for ${expert.name} (${expert.professionLabel}, ${expert.sectorName}, ${expert.cityName}).`, '',
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
  // Trace de consentement MINIMALE (audit §8d, compatible « rien conservé ») :
  // horodatage + empreinte HMAC du courriel + expert — JAMAIS le contenu.
  await env.COUNTERS.put(`cl:${token}`, JSON.stringify({ ts: new Date().toISOString(), rh: (await hmacHex(env, courriel)).slice(0, 16), slug: expert.slug }), { expirationTtl: 400 * 86400 });

  const frX = contact.lang === 'fr';
  const subject = frX
    ? `Nouvelle demande de contact via Payotte — ${nom}`
    : `New contact request via Payotte — ${nom}`;
  const lines = frX
    ? [
        `Bonjour ${contact.name},`, '',
        `Un client vous envoie une demande de contact via votre fiche Payotte (${expert.url}), préparée par son assistant IA et CONFIRMÉE par le client lui-même (clic sur un lien reçu à son adresse).`, '',
        `Nom : ${nom}`, `Courriel : ${courriel}`,
        ...(pending.tel ? [`Téléphone : ${pending.tel}`] : []), '',
        `Message :`, message, '',
        `— Répondez directement au client (bouton Répondre).`,
        `Payotte relaie sans conserver le contenu de cette demande. Pour ne plus recevoir de demandes relayées : répondez « retrait » à ce courriel. https://payotte.com`,
      ]
    : [
        `Hello ${contact.name},`, '',
        `A client is sending you a contact request through your Payotte profile (${expert.url}), prepared by their AI assistant and CONFIRMED by the client themselves (click on a link received at their address).`, '',
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

const TOOL_IMPL = {
  trouver_expert: trouverExpert,
  verifier_titre: verifierTitre,
  stats_marche: statsMarche,
  taux_courants: tauxCourants,
  taxe_mutation: taxeMutation,
  acheter_ou_louer: acheterOuLouer,
  salaire_requis: salaireRequis,
  contacter_expert: contacterExpert,
};

// ---------------------------------------------------------------- bulletin de marché (audience possédée)
// Abonnement zéro-JS depuis les pages ville (POST de formulaire pur), bienvenue immédiate
// avec les stats de la ville, envoi mensuel par cron. On ne stocke QUE courriel+ville+langue
// +date de consentement (LCAP) dans KV. Désabonnement en un clic (HMAC, clé = CONTACTS_TOKEN).

const SUB_CAP_DAY = 30;   // garde-fou anti-abus sur les inscriptions
const SEND_CAP_RUN = 90;  // marge sous le palier Resend gratuit (100/jour)

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

// Compose le bulletin depuis /api/market.json — champs présents seulement, rien d'inventé.
function bulletinText(city, lang, unsubUrl, welcome) {
  const fr = lang === 'fr';
  const refPrice = city.benchmarkHpi ?? city.medianPrice;
  const refLabel = city.benchmarkHpi ? (fr ? 'Prix repère MLS' : 'MLS benchmark price') : (fr ? 'Prix médian' : 'Median price');
  const L = [];
  L.push(fr ? `Le pouls du marché — ${city.name}` : `Market pulse — ${city.name}`);
  if (city.referenceMonth) L.push(fr ? `(données de référence : ${city.referenceMonth}, ${city.board ?? 'chambre immobilière'})` : `(reference data: ${city.referenceMonth}, ${city.board ?? 'real-estate board'})`);
  L.push('');
  if (refPrice != null) L.push(`• ${refLabel} : ${fmtMoney(refPrice, fr)}${city.benchmarkYoyPct != null ? ` (${fmtPct(city.benchmarkYoyPct, fr)} ${fr ? 'sur un an' : 'year over year'})` : ''}`);
  if (city.sales != null) L.push(`• ${fr ? 'Ventes' : 'Sales'} : ${city.sales.toLocaleString(fr ? 'fr-CA' : 'en-CA')}${city.salesYoyPct != null ? ` (${fmtPct(city.salesYoyPct, fr)})` : ''}`);
  if (city.monthsOfInventory != null) L.push(`• ${fr ? "Mois d'inventaire" : 'Months of inventory'} : ${city.monthsOfInventory}`);
  if (city.avgDaysOnMarket != null) L.push(`• ${fr ? 'Délai de vente moyen' : 'Average days on market'} : ${city.avgDaysOnMarket} ${fr ? 'jours' : 'days'}`);
  if (city.growth5yPct != null) L.push(`• ${fr ? 'Croissance sur 5 ans' : '5-year growth'} : ${fmtPct(city.growth5yPct, fr)}`);
  L.push('');
  L.push(fr
    ? `Besoin d'un professionnel de confiance ? Un seul expert vérifié par secteur et par métier, permis publié : ${SITE}`
    : `Need a professional you can trust? One verified expert per sector and trade, licence published: ${SITE}`);
  if (Array.isArray(city.sources) && city.sources.length) L.push('', (fr ? 'Sources : ' : 'Sources: ') + city.sources.join(' · '));
  L.push('', '—', fr
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
      reply_to: 'gregory@payotte.com',
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
const PERSO_COPY = 'gpayotte@gmail.com';   // copie perso de CHAQUE envoi (demande du proprio)

// Étape d'un expert d'après son état vivant. subscribed=false → premier contact ⓪ (opt-in).
function expertStage(expert, subscribed) {
  const c = expert?.score?.color;
  if (!c || c === 'red') return null;          // rouge = non publié → pas de bulletin
  if (!subscribed) return 'intro';             // ⓪ présentation + consentement
  if (c === 'yellow') return 'yellow';         // ① monter vers le vert
  if (!expert.ownerVerified) return 'green';   // ② confirmer → Recommandé
  if (!expert.badgeExchange) return 'reco';    // ③ poser le badge
  return 'partner';                            // ④ rien à demander
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
function marketCore(city, fr, eyebrow) {
  const ref = city.benchmarkHpi ?? city.medianPrice;
  const refYoy = city.benchmarkYoyPct;
  const grn = (t) => `<span style="font-size:12px;color:#1f7a44;font-weight:normal;">${t}</span>`;
  const cells = [];
  if (city.averagePrice != null) cells.push([fr ? 'Prix moyen' : 'Average price', fmtMoney(city.averagePrice, fr) + (city.averageYoyPct != null ? ' ' + grn(fmtPct(city.averageYoyPct, fr)) : '')]);
  if (city.sales != null) cells.push([fr ? 'Ventes du mois' : 'Sales', city.sales.toLocaleString(fr ? 'fr-CA' : 'en-CA') + (city.salesYoyPct != null ? ' ' + grn(fmtPct(city.salesYoyPct, fr)) : '')]);
  if (city.monthsOfInventory != null) cells.push([fr ? "Mois d'inventaire" : 'Months of inventory', String(city.monthsOfInventory)]);
  if (city.avgDaysOnMarket != null) cells.push([fr ? 'Délai de vente' : 'Days on market', city.avgDaysOnMarket + (fr ? ' jours' : ' days')]);
  let gridRows = '';
  for (let i = 0; i < cells.length; i += 2) gridRows += `<tr>${S(cells[i][0], cells[i][1])}${cells[i + 1] ? S(cells[i + 1][0], cells[i + 1][1]) : '<td width="50%"></td>'}</tr>`;
  const refLine = ref != null
    ? `<div style="font-family:Georgia,'Times New Roman',serif;font-size:34px;color:#211c1e;line-height:1;">${fmtMoney(ref, fr)}</div>
       <div style="font-size:13px;color:#6f6769;margin:9px 0 22px 0;">${fr ? 'Prix de référence' : 'Reference price'} (${city.benchmarkHpi ? (fr ? 'repère MLS' : 'MLS benchmark') : (fr ? 'médiane' : 'median')})${refYoy != null ? ` &middot; <span style="color:#1f7a44;font-weight:bold;">${fmtPct(refYoy, fr)} ${fr ? 'sur un an' : 'YoY'}</span>` : ''}</div>`
    : '';
  const src = Array.isArray(city.sources) && city.sources.length ? city.sources[0] : city.board;
  return `<tr><td style="padding:26px 32px 22px 32px;border-bottom:1px solid #f1ecec;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle"><a href="${SITE}"><img src="${LOGO}" width="140" height="29" alt="Payotte" style="display:block;border:0;"></a></td><td align="right" valign="middle" style="font-size:11px;letter-spacing:.5px;color:#9a9294;line-height:1.5;">${eyebrow}</td></tr></table></td></tr>
    <tr><td style="padding:28px 32px 6px 32px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.3;color:#211c1e;margin-bottom:20px;">${fr ? 'Le pouls du marché' : 'The market pulse'} &mdash; ${city.name}</div>
      ${refLine}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #f1ecec;">${gridRows}</table>
      <div style="font-size:11.5px;color:#a49c9e;margin-top:14px;">${fr ? 'Source' : 'Source'} : ${src ?? 'chambre immobilière'}${city.referenceMonth ? ` &middot; ${city.referenceMonth}` : ''}</div>
    </td></tr>`;
}

const CLOSE = (bg, border, inner) => `<tr><td style="padding:20px 32px 4px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border:1px solid ${border};border-radius:12px;"><tr><td style="padding:22px 24px;">${inner}</td></tr></table></td></tr>`;
const BTN = (href, txt) => `<a href="${href}" style="display:inline-block;background:#c8102e;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;padding:11px 20px;border-radius:9px;">${txt}</a>`;
const H3 = (t) => `<div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.25;color:#211c1e;margin-bottom:10px;">${t}</div>`;
const P = (t) => `<div style="font-size:14px;line-height:1.6;color:#443e40;margin-bottom:14px;">${t}</div>`;
const FOOT = (why, unsubUrl, unsubTxt) => `<tr><td style="padding:22px 32px 26px 32px;"><div style="border-top:1px solid #f1ecec;padding-top:16px;font-size:11.5px;line-height:1.6;color:#a49c9e;">${why} <a href="${unsubUrl}" style="color:#8a8284;">${unsubTxt}</a> &middot; payotte.com</div></td></tr>`;

// Rendu complet d'un courriel : {subject, html}. segment='prospect'|'expert' ; stage pour les experts.
function renderPulse({ segment, stage, city, expert, lang, unsubUrl }) {
  const fr = lang !== 'en';
  const url = expert?.url || `${SITE}`;
  const eyebrow = `${fr ? 'Le pouls du marché' : 'Market pulse'}<br><span style="color:#c8102e;letter-spacing:1px;">${city.name}${city.referenceMonth ? ' &middot; ' + city.referenceMonth : ''}</span>`;
  let subject, close, foot;
  if (segment === 'prospect') {
    subject = fr ? `${city.name} : le pouls du marché` : `${city.name}: your market pulse`;
    close = CLOSE('#eef3f0', '#cfe4d7', `${H3(fr ? `Un projet à ${city.name} ?` : `Planning a move in ${city.name}?`)}${P(fr ? `Payotte a vérifié <b>un seul</b> expert de référence par secteur et par métier — sans commission, sans publicité.` : `Payotte verified <b>one</b> reference expert per sector and trade — no commission, no ads.`)}${BTN(`${SITE}/canada`, fr ? 'Trouver mon expert vérifié →' : 'Find my verified expert →')}`);
    foot = FOOT(fr ? `Vous recevez le pouls de ${city.name}, une fois par mois.` : `You get the ${city.name} pulse once a month.`, unsubUrl, fr ? 'Se désabonner' : 'Unsubscribe');
  } else {
    const ask = expert ? missingAsk(expert, fr) : '';
    const proWho = fr ? `l'expert vérifié en ${expert?.professionLabel ?? ''} pour ${city.name}` : `the verified ${expert?.professionLabel ?? ''} for ${city.name}`;
    if (stage === 'intro') {
      subject = fr ? `Pourquoi je vous ai retenu comme référence à ${city.name}` : `Why I chose you as the reference in ${city.name}`;
      close = CLOSE('#faf8f7', '#eee9e8', `${P(fr ? `Je m'appelle Grégory Payotte. J'ai bâti <b>Payotte</b>, un annuaire indépendant qui recommande un seul expert vérifié par ville et par métier — gratuit, sans commission. Pour ${proWho}, c'est vous que j'ai retenu, sur la foi de données publiques. Le pouls ci-dessus, je le publie chaque mois.` : `I'm Grégory Payotte. I built <b>Payotte</b>, an independent directory recommending one verified expert per city and trade — free, no commission. For ${proWho}, I chose you, based on public data. I publish the pulse above every month.`)}${P(fr ? `Vous le voulez chaque mois ? <b>Répondez « oui »</b> et je vous l'envoie. Sinon, aucune suite.` : `Want it monthly? <b>Reply "yes"</b> and I'll send it. Otherwise, no follow-up.`)}${BTN(url, fr ? 'Voir votre fiche →' : 'See your profile →')}`);
      foot = FOOT(fr ? `Courriel unique de présentation, parce que vous êtes ${proWho}. Aucune suite sans votre accord.` : `One-time introduction, because you are ${proWho}. No follow-up without your consent.`, url, fr ? 'Ne rien recevoir' : 'Opt out');
    } else if (stage === 'yellow') {
      subject = fr ? `Votre marché à ${city.name} — et la donnée qui vous ferait monter` : `Your ${city.name} market — and the data that would lift you`;
      close = CLOSE('#fdf6e9', '#f2e4c4', `${H3(fr ? 'Pendant qu\'on y est : votre fiche.' : 'While we\'re at it: your profile.')}${P(fr ? `Votre fiche Payotte est à <b>${expert?.score?.total ?? ''}/100</b>. La donnée la plus payante qui vous manque : <b>${ask}</b>. Répondez à ce courriel avec — je mets à jour le jour même.` : `Your profile is at <b>${expert?.score?.total ?? ''}/100</b>. The most valuable missing piece: <b>${ask}</b>. Reply with it — I update the same day.`)}${BTN(url, fr ? 'Voir ma fiche →' : 'See my profile →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}.` : `You get this because you are ${proWho}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe');
    } else if (stage === 'green') {
      subject = fr ? `Vous êtes la référence vérifiée de ${city.name} — une dernière étape` : `You're the verified reference in ${city.name} — one last step`;
      close = CLOSE('#eef5f0', '#cfe4d7', `${H3(fr ? 'Vous êtes déjà au vert.' : 'You\'re already in the green.')}${P(fr ? `Une seule étape pour le plus haut niveau du site : <b>confirmer votre fiche</b> et devenir <b style="color:#1f7a44;">Recommandé N&ordm; 1</b>. Deux minutes, par réponse à ce courriel.` : `One step to the top tier: <b>confirm your profile</b> and become <b style="color:#1f7a44;">Recommended #1</b>. Two minutes, just reply.`)}${BTN(url, fr ? 'Confirmer ma fiche →' : 'Confirm my profile →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes ${proWho}.` : `You get this because you are ${proWho}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe');
    } else if (stage === 'reco') {
      subject = fr ? `Vous êtes Recommandé N° 1 à ${city.name} — rendez-le visible` : `You're Recommended #1 in ${city.name} — make it visible`;
      close = CLOSE('#fbedef', '#f0d3d9', `<div style="font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#c8102e;margin-bottom:8px;">&#10003; ${fr ? 'Recommandé par Payotte' : 'Recommended by Payotte'}</div>${H3(fr ? 'Rendez-le visible sur votre site.' : 'Show it on your site.')}${P(fr ? `Affichez le badge « Recommandé » : un <b>lien réciproque dofollow</b> — bon pour votre référencement, et un signal de confiance. Je fournis le code (ou je m'arrange avec votre webmestre).` : `Display the "Recommended" badge: a <b>reciprocal dofollow link</b> — good for your SEO and a trust signal. I provide the code (or work with your webmaster).`)}${BTN(`${SITE}/badge/${expert?.slug ?? ''}`, fr ? 'Obtenir mon badge →' : 'Get my badge →')}`);
      foot = FOOT(fr ? `Vous recevez ce courriel parce que vous êtes Recommandé à ${city.name}.` : `You get this because you are Recommended in ${city.name}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe');
    } else { // partner
      subject = fr ? `Votre marché à ${city.name} ce mois-ci` : `Your ${city.name} market this month`;
      close = `<tr><td style="padding:18px 32px 4px 32px;"><div style="border-top:1px solid #f1ecec;padding-top:18px;font-size:14px;line-height:1.62;color:#443e40;">${fr ? `Tout est en place : vous êtes Recommandé et votre badge est en ligne. Rien à demander — juste votre marché, chaque mois.` : `All set: you're Recommended and your badge is live. Nothing to ask — just your market, monthly.`}<div style="margin-top:14px;font-size:13px;color:#6f6769;">${fr ? `Un confrère d'un secteur voisin mériterait d'être vérifié ? <b>Transmettez-lui ce courriel.</b>` : `Know a peer worth verifying? <b>Forward this email.</b>`}</div></div></td></tr>`;
      foot = FOOT(fr ? `Vous êtes Recommandé et partenaire vérifié à ${city.name}.` : `You are Recommended and a verified partner in ${city.name}.`, unsubUrl, fr ? 'Ne plus recevoir' : 'Unsubscribe');
    }
  }
  const html = `<div style="background:#f5f3f2;margin:0;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:580px;width:100%;background:#ffffff;border:1px solid #eae5e5;border-radius:8px;">${marketCore(city, fr, eyebrow)}${close}${foot}</table></div>`;
  return { subject, html };
}

// Envoi générique avec COPIE PERSO systématique (bcc) — demande du proprio.
async function sendPulse(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) return { simulated: true, to, subject };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM_BULLETIN || 'Payotte <bulletin@payotte.com>',
      to: [to], bcc: [PERSO_COPY], reply_to: replyTo || 'gregory@payotte.com',
      subject, html,
    }),
  });
  return { ok: res.ok };
}

// Villes ACTIVES du bulletin. Lot test dès le 1er août : Laval + Montréal.
// Élargir = ajouter des slugs ici (puis redéployer).
const ACTIVE_CITIES = ['laval', 'montreal'];

// Orchestration mensuelle. dryRun=true → aucun envoi, renvoie seulement le rapport d'audience.
// Prospects (abonnés du formulaire) + experts des villes actives. Un expert FROID reçoit ⓪
// (présentation) et est marqué `intro:` pour ne JAMAIS le re-présenter sans son accord
// (`sub:` posé à la main quand il répond « oui » → il entre alors dans l'escalier ①②③④).
async function runBulletin(env, { dryRun = false } = {}) {
  const origin = 'https://payotte-mcp.payotte.workers.dev';
  const report = { dryRun, activeCities: ACTIVE_CITIES, prospects: 0, experts: { intro: 0, yellow: 0, green: 0, reco: 0, partner: 0 }, sent: 0, cap: SEND_CAP_RUN, skipped: [], recipients: [] };
  const market = await feed('/api/market.json').catch(() => ({ cities: [] }));
  const cityBySlug = Object.fromEntries((market.cities || []).map((c) => [c.slug, c]));

  // ---- Prospects des villes actives ----
  if (env.SUBSCRIBERS) {
    const subs = await env.SUBSCRIBERS.list({ prefix: 's:' });
    for (const k of subs.keys) {
      if (report.sent >= SEND_CAP_RUN) break;
      const rec = JSON.parse((await env.SUBSCRIBERS.get(k.name)) || '{}');
      if (!ACTIVE_CITIES.includes(rec.city)) continue;
      const city = cityBySlug[rec.city]; if (!city) continue;
      const unsub = `${origin}/unsubscribe?e=${encodeURIComponent(rec.email)}&c=${encodeURIComponent(rec.city)}&t=${await hmacHex(env, `u:${rec.email}:${rec.city}`)}`;
      const { subject, html } = renderPulse({ segment: 'prospect', city, lang: rec.lang, unsubUrl: unsub });
      report.prospects++; report.recipients.push({ to: rec.email, kind: 'prospect', city: rec.city });
      if (!dryRun) { await sendPulse(env, { to: rec.email, subject, html }); report.sent++; }
    }
  }

  // ---- Experts des villes actives ----
  let all = [];
  try { all = await allExperts(); } catch { /* feed indispo */ }
  const lm = all.filter((e) => ACTIVE_CITIES.includes(e.city) && e.score?.color && e.score.color !== 'red');
  let dir = {};
  if (env.CONTACTS_TOKEN) { try { dir = (await feed(`/api/cx/${env.CONTACTS_TOKEN}.json`)).contacts || {}; } catch { /* annuaire indispo */ } }
  for (const e of lm) {
    if (report.sent >= SEND_CAP_RUN) { report.skipped.push(`${e.slug} (cap)`); continue; }
    const contact = dir[e.slug];
    if (!contact?.email) { report.skipped.push(`${e.slug} (pas de courriel)`); continue; }
    const introduced = env.SUBSCRIBERS ? await env.SUBSCRIBERS.get(`intro:${e.slug}`) : null;
    const subscribed = env.SUBSCRIBERS ? await env.SUBSCRIBERS.get(`sub:${e.slug}`) : null;
    if (introduced && !subscribed) { report.skipped.push(`${e.slug} (présenté, pas d'accord)`); continue; }
    const stage = expertStage(e, !!subscribed);
    if (!stage) continue;
    const city = cityBySlug[e.city]; if (!city) { report.skipped.push(`${e.slug} (ville sans marché)`); continue; }
    report.experts[stage] = (report.experts[stage] || 0) + 1;
    report.recipients.push({ to: contact.email, kind: `expert:${stage}`, slug: e.slug });
    if (!dryRun) {
      const { subject, html } = renderPulse({ segment: 'expert', stage, city, expert: e, lang: contact.lang || e.lang, unsubUrl: e.url });
      await sendPulse(env, { to: contact.email, subject, html });
      if (stage === 'intro' && env.SUBSCRIBERS) await env.SUBSCRIBERS.put(`intro:${e.slug}`, new Date().toISOString());
      report.sent++;
    }
  }
  return report;
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

async function handleUnsubscribe(env, url) {
  const email = String(url.searchParams.get('e') ?? '').trim().toLowerCase();
  const ville = String(url.searchParams.get('c') ?? '');
  const t = url.searchParams.get('t') ?? '';
  const expect = await hmacHex(env, `u:${email}:${ville}`);
  if (!email || !ville || t !== expect) return subPage('fr', 'Lien invalide', 'Ce lien de désabonnement est invalide ou expiré. / Invalid unsubscribe link.');
  if (env.SUBSCRIBERS) await env.SUBSCRIBERS.delete(`s:${ville}:${email}`);
  return subPage('fr', 'Désabonné / Unsubscribed', `${email} ne recevra plus le bulletin de ${ville}. / will no longer receive this bulletin.`);
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
      return rpcResult(id, { tools: TOOLS });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Statistiques publiques agrégées (aucune donnée personnelle) — pour le rapport hebdo.
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
    // Ex. /preview?segment=expert&stage=yellow&city=laval&lang=fr
    if (request.method === 'GET' && url.pathname === '/preview') {
      const q = url.searchParams;
      const segment = q.get('segment') || 'prospect';
      const stage = q.get('stage') || 'intro';
      const citySlug = strip(q.get('city') || 'laval');
      const lang = q.get('lang') || 'fr';
      const market = await feed('/api/market.json').catch(() => ({ cities: [] }));
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
      const { subject, html } = renderPulse({ segment, stage, city, expert, lang, unsubUrl: '#preview' });
      return new Response(`<!--${subject}-->\n${html}`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
    }

    // Dry-run du bulletin (aucun envoi) — rapport d'audience. Protégé par le jeton privé.
    if (request.method === 'GET' && url.pathname === '/bulletin-dryrun') {
      if (!env.CONTACTS_TOKEN || url.searchParams.get('key') !== env.CONTACTS_TOKEN) return json({ error: 'unauthorized' }, 401);
      const report = await runBulletin(env, { dryRun: true });
      return json(report);
    }

    // Bulletin de marché (formulaire zéro-JS des pages ville).
    if (request.method === 'POST' && url.pathname === '/subscribe') return handleSubscribe(request, env, url);
    if (request.method === 'GET' && url.pathname === '/unsubscribe') return handleUnsubscribe(env, url);

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

  // Envoi mensuel du bulletin (cron : 1er du mois, 13h UTC). Villes actives = ACTIVE_CITIES.
  async scheduled(event, env, ctx) {
    if (!env.RESEND_API_KEY) return;   // sans clé : aucun envoi (le dry-run reste dispo par route)
    await runBulletin(env, { dryRun: false });
  },
};
