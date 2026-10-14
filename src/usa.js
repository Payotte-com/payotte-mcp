/**
 * usa.js — les outils MCP de Payotte USA (préparés le 14 oct. 2026, branche brouillon/mcp-usa). NE PAS DÉPLOYER avant la
 * mise en ligne de payotte.com/usa : chaque réponse renvoie vers une page du site, qui doit exister.
 *
 * Données GÉNÉRÉES par payotte-astro-usa/scripts/usa/export-mcp.mjs : usa.json (states.json, tableaux des 50 États tirés des
 * articles, régulateurs des 5 métiers, frontmatter des articles et des guides fédéraux). Rien n'est recopié ici à la main :
 * les réponses sont celles des pages « by state » du site, mot pour mot. À relancer après chaque correction, puis redéployer.
 *
 * Vocabulaire : aucun professionnel n'est listé aux USA (aucune fiche nominative avant l'avis de l'avocat américain).
 * Les outils disent QUI régit un métier et OÙ le lecteur vérifie une licence ; jamais « verified by Payotte ».
 */
import US from './data/usa.json' with { type: 'json' };

const SITE_US = 'https://payotte.com/usa';
const ATTRIBUTION_US =
  'Data: Payotte USA (https://payotte.com/usa), CC BY 4.0 — cite Payotte with a link to the page given. ' +
  'Each answer summarizes a state article that cites the statute or official page behind it (see sources). ' +
  'This is general information, not legal advice; rules change, and the article date is given.';
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);

// ---------------------------------------------------------------- normalisation
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ALIAS_ETAT = { 'washington-state': 'washington', 'dc': null, 'washington-dc': null, 'district-of-columbia': null };
function etatDe(v) {
  const n = norm(v);
  if (!n) return null;
  if (n in ALIAS_ETAT) return ALIAS_ETAT[n] && US.states.find((e) => e.slug === ALIAS_ETAT[n]);
  return US.states.find((e) => e.slug === n || norm(e.code) === n || norm(e.name) === n || norm(e.city.name) === n) ?? null;
}
const LISTE_ETATS = 'any of the 50 states, by name or two-letter code (e.g. "Texas", "TX")';
const erreurEtat = (v) => ({ error: `Unknown state: "${v ?? ''}". Use ${LISTE_ETATS}. Washington, D.C. and the territories are not covered.` });

const article = (e, slug) => e.articles.find((a) => a.slug === slug) ?? null;
const ligne = (table, e) => US.tables[table]?.states?.[e.slug] ?? null;
const sansSources = (l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'sources' && k !== 'answer'));

/** Réponse type d'un outil « un sujet × un État » : la phrase, les champs, la page de l'État, le tableau comparatif, les sources. */
function reponseSujet(e, table, slugArticle, pageTableau, extra = {}) {
  const l = ligne(table, e);
  const a = article(e, slugArticle);
  if (!l) {
    return {
      state: e.name, covered: false,
      note: `Payotte has no ${slugArticle.replace(/-/g, ' ')} article for ${e.name}.`,
      stateGuide: mcpSrc(e.url), attribution: ATTRIBUTION_US,
    };
  }
  return {
    state: e.name, code: e.code,
    answer: l.answer,
    ...extra,
    details: sansSources(l),
    article: a ? { title: a.title, url: mcpSrc(a.url), checked: a.checked } : null,
    compareAllStates: pageTableau ? mcpSrc(`${SITE_US}/by-state/${pageTableau}`) : null,
    sources: l.sources,
    compiled: US.tables[table].compiled,
    attribution: ATTRIBUTION_US,
  };
}

// ---------------------------------------------------------------- taxe de mutation : part de l'État sur un prix
function partEtat(calc, prix) {
  if (!calc || prix == null) return null;
  switch (calc.kind) {
    case 'none': return 0;
    case 'per_unit': {
      if (!calc.unit || calc.rate_per_unit == null) return null;
      const unites = calc.round_up ? Math.ceil(prix / calc.unit) : prix / calc.unit;
      return Math.round(unites * calc.rate_per_unit * 100) / 100;
    }
    case 'percent': return calc.percent == null ? null : Math.round(prix * calc.percent) / 100;
    case 'tiers': {
      if (!Array.isArray(calc.tiers)) return null;
      let t = 0;
      for (const p of calc.tiers) {
        const haut = p.to == null ? prix : Math.min(prix, p.to);
        if (haut > p.from) t += ((haut - p.from) * p.percent) / 100;
      }
      return Math.round(t * 100) / 100;
    }
    default: return null;   // « other » : la règle est dans calc.explain, on ne la simplifie pas
  }
}

function transferTaxUs(a = {}) {
  const e = etatDe(a.state);
  if (!e) return erreurEtat(a.state);
  const l = ligne('transfer-tax', e);
  const prix = a.price == null ? null : Number(a.price);
  if (prix != null && !(prix > 0)) return { error: 'price must be a positive number of US dollars.' };
  const extra = {};
  if (l && prix != null) {
    const t = partEtat(l.calc, prix);
    extra.computation = t == null
      ? { price: prix, stateTax: null, why: `Not reducible to one formula for ${e.name}: ${l.calc?.explain ?? 'see the article'}` }
      : { price: prix, stateTax: t, formula: l.calc.explain,
          excludes: 'County, city and mortgage taxes, surtaxes and exemptions are NOT included in stateTax (see details.local_taxes, details.mortgage_tax, details.exemptions).' };
  }
  return reponseSujet(e, 'transfer-tax', 'transfer-tax', 'transfer-tax', extra);
}

function propertyTaxUs(a = {}) {
  const e = etatDe(a.state);
  if (!e) return erreurEtat(a.state);
  return reponseSujet(e, 'property-tax', 'property-tax', 'property-tax');
}

function propertyTaxAppealUs(a = {}) {
  const e = etatDe(a.state);
  if (!e) return erreurEtat(a.state);
  const l = ligne('property-tax', e);
  if (!l) return reponseSujet(e, 'property-tax', 'property-tax', null);
  const a2 = article(e, 'property-tax');
  return {
    state: e.name, code: e.code,
    answer: l.appeal_answer ?? l.answer,
    deadline: l.appeal_deadline ?? null,
    fileWith: l.appeal_body ?? null,
    caution: 'Deadlines usually run from the date on the assessment notice; check the notice itself and the county assessor page.',
    article: a2 ? { title: a2.title, url: mcpSrc(a2.url), checked: a2.checked } : null,
    compareAllStates: mcpSrc(`${SITE_US}/by-state/property-tax-appeal-deadlines`),
    sources: l.sources, compiled: US.tables['property-tax'].compiled, attribution: ATTRIBUTION_US,
  };
}

const outilSimple = (table, slugArticle, pageTableau) => (a = {}) => {
  const e = etatDe(a.state);
  if (!e) return erreurEtat(a.state);
  return reponseSujet(e, table, slugArticle, pageTableau);
};

// ---------------------------------------------------------------- licences
const METIERS_US = {
  'real-estate-agent': ['real-estate-agent', 'agent', 'realtor', 'broker', 'real-estate-broker', 'salesperson', 'real-estate-salesperson'],
  'mortgage-loan-officer': ['mortgage-loan-officer', 'loan-officer', 'mortgage-broker', 'mlo', 'lender', 'mortgage-loan-originator', 'nmls'],
  'home-inspector': ['home-inspector', 'inspector', 'home-inspection'],
  'closing-attorney': ['closing-attorney', 'attorney', 'lawyer', 'real-estate-attorney', 'real-estate-lawyer'],
  'appraiser': ['appraiser', 'real-estate-appraiser', 'appraisal'],
};
const LISTE_METIERS_US = 'real-estate-agent, mortgage-loan-officer, home-inspector, closing-attorney, appraiser';
const metierDe = (v) => { const n = norm(v); return Object.entries(METIERS_US).find(([, al]) => al.includes(n))?.[0] ?? null; };
const LIBELLE_LICENCE = {
  required: 'A state license is required.',
  registration: 'State registration is required (not a full license).',
  'certification-optional': 'No license is required; a voluntary certification exists.',
  'none-found': 'No state license requirement was found in the sources read.',
};

function verifyLicenseUs(a = {}) {
  const e = etatDe(a.state);
  if (!e) return erreurEtat(a.state);
  const m = metierDe(a.profession);
  if (!m) return { error: `Unknown profession: "${a.profession ?? ''}". Values: ${LISTE_METIERS_US}.` };
  const p = e.professions[m];
  if (!p) return { state: e.name, profession: m, covered: false, stateGuide: mcpSrc(e.url), attribution: ATTRIBUTION_US };
  const art = article(e, 'verify-a-license');
  return {
    state: e.name, code: e.code, profession: m,
    licensing: LIBELLE_LICENCE[p.license] ?? p.license,
    regulator: p.regulator, regulatorUrl: p.regulator_url,
    titles: p.titles,
    whereToVerify: p.lookup_url ? { name: p.lookup_name, url: p.lookup_url } : null,
    note: p.note,
    advice: 'Ask the professional for their license number, then check it yourself on the official lookup. Payotte does not query the registries for you and lists no professionals in the United States yet.',
    article: art ? { title: art.title, url: mcpSrc(art.url), checked: art.checked } : null,
    professionalsPage: mcpSrc(`${SITE_US}/${e.slug}/professionals/${m}`),
    attribution: ATTRIBUTION_US,
  };
}

// ---------------------------------------------------------------- comparaisons et sommaires
const SUJETS_COMPARABLES = {
  'transfer-tax': { table: 'transfer-tax', champ: 'state_tax', page: 'transfer-tax', valeurs: { yes: 'State transfer tax', no: 'No transfer tax', 'local-only': 'Local transfer taxes only' } },
  'attorney-at-closing': { table: 'real-estate-attorney', champ: 'attorney_required', page: 'attorney-required-at-closing', valeurs: { yes: 'Attorney required', partial: 'Attorney required for part of the closing', customary: 'Attorney customary, not required', no: 'No attorney required' } },
  'foreclosure': { table: 'foreclosure', champ: 'process', page: 'foreclosure', valeurs: { judicial: 'Judicial foreclosure', 'non-judicial': 'Non-judicial foreclosure', both: 'Both judicial and non-judicial' } },
  'seller-disclosure': { table: 'seller-disclosure', champ: 'disclosure_required', page: 'seller-disclosure', valeurs: { yes: 'Disclosure form required', limited: 'Limited disclosure duties', no: 'Buyer beware (no general form)' } },
  'community-property': { table: 'community-property', champ: 'regime', page: 'community-property-states', valeurs: { community: 'Community property', 'opt-in': 'Opt-in community property' } },
};

function compareStatesUs(a = {}) {
  const k = norm(a.topic);
  const s = SUJETS_COMPARABLES[k] ?? SUJETS_COMPARABLES[{ 'transfer-taxes': 'transfer-tax', attorney: 'attorney-at-closing', 'closing-attorney': 'attorney-at-closing', disclosure: 'seller-disclosure', 'community-property-states': 'community-property' }[k]];
  if (!s) return { error: `Unknown topic: "${a.topic ?? ''}". Values: ${Object.keys(SUJETS_COMPARABLES).join(', ')}.` };
  const t = US.tables[s.table];
  const groupes = Object.entries(s.valeurs).map(([v, lib]) => {
    const etats = US.states.filter((e) => String(t.states[e.slug]?.[s.champ]) === v).map((e) => e.name).sort();
    return { value: v, label: lib, count: etats.length, states: etats };
  }).filter((g) => g.count > 0);
  return {
    topic: k, groups: groupes,
    ...(s.table === 'community-property' ? { otherStates: 'All other states follow the common-law (separate property) system.' } : {}),
    caution: 'Classifications summarize each state article; read the state article for the exact rule and exceptions.',
    page: mcpSrc(`${SITE_US}/by-state/${s.page}`),
    compiled: t.compiled, attribution: ATTRIBUTION_US,
  };
}

function stateOverviewUs(a = {}) {
  const e = etatDe(a.state);
  if (!e) return erreurEtat(a.state);
  return {
    state: e.name, code: e.code, mainCity: e.city.name,
    keyFacts: e.facts.map((f) => ({ topic: f.topic, fact: f.fact, url: mcpSrc(f.url) })),
    articles: e.articles.map((x) => ({ title: x.title, summary: x.description, url: mcpSrc(x.url), checked: x.checked })),
    page: mcpSrc(e.url), attribution: ATTRIBUTION_US,
  };
}

function federalGuideUs(a = {}) {
  const q = norm(a.query).split('-').filter((w) => w.length > 2);
  if (!q.length) return { guides: US.guides.map((g) => ({ title: g.title, url: mcpSrc(g.url) })), attribution: ATTRIBUTION_US };
  const score = (g) => q.reduce((n, w) => n + (norm(`${g.slug} ${g.title} ${g.query ?? ''}`).includes(w) ? 2 : 0) + (norm(g.description).includes(w) ? 1 : 0), 0);
  const r = US.guides.map((g) => ({ g, s: score(g) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 3);
  if (!r.length) return { query: a.query, guides: [], note: 'No federal guide matches; call with an empty query for the full list.', attribution: ATTRIBUTION_US };
  return { query: a.query, guides: r.map(({ g }) => ({ title: g.title, summary: g.description, url: mcpSrc(g.url), checked: g.checked })), attribution: ATTRIBUTION_US };
}

function homePricesUs(a = {}) {
  const e = etatDe(a.state);
  if (!e) return erreurEtat(a.state);
  return reponseSujet(e, 'home-prices', 'home-prices', 'median-home-price',
    { caution: 'ACS median values are owners’ own estimates of what their home would sell for, not sale prices.' });
}

// ---------------------------------------------------------------- déclarations MCP
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const P_ETAT = { state: { type: 'string', description: `US state: ${LISTE_ETATS}.` } };

export const TOOLS_US = [
  {
    name: 'transfer_tax_us', title: 'US real estate transfer tax by state',
    description: 'UNITED STATES. Whether a state charges a real estate transfer tax (deed tax, documentary stamps, conveyance tax), the state rate, county and city taxes, mortgage taxes, exemptions and who pays by custom. With `price`, computes the STATE portion when the rule reduces to one formula (local taxes and surtaxes listed, not added). From the state statute, as summarized on payotte.com/usa.',
    inputSchema: { type: 'object', properties: { ...P_ETAT, price: { type: 'number', description: 'Optional purchase price in US dollars.' } }, required: ['state'] },
  },
  {
    name: 'property_tax_us', title: 'US property tax by state',
    description: 'UNITED STATES. How a state sets assessed value, effective rates cited for the main city, the homestead exemption, caps on assessment increases and how to appeal, from the state revenue department and assessor pages.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'property_tax_appeal_us', title: 'US property tax appeal deadline by state',
    description: 'UNITED STATES. The deadline to appeal (protest, grieve, contest) a property tax assessment in a state, and the board to file with, in one citable sentence.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'attorney_at_closing_us', title: 'Is an attorney required at closing? (US, by state)',
    description: 'UNITED STATES. Whether a real estate attorney is required at closing in a state (required, partly required, customary, not required), the statute, bar opinion or court ruling behind it, and who usually conducts closings (attorney, title or escrow company).',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'foreclosure_us', title: 'US foreclosure process by state',
    description: 'UNITED STATES. Whether a state forecloses judicially or by trustee sale, the typical or minimum timeline, any right of redemption after the sale, deficiency judgment rules and mediation programs.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'seller_disclosure_us', title: 'US seller disclosure law by state',
    description: 'UNITED STATES. Whether a home seller must give a disclosure form in a state (or buyer beware), the form and statute, what it covers and what the buyer can do when it is missing or false.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'closing_costs_us', title: 'US closing costs by state (items set by law)',
    description: 'UNITED STATES. The closing costs that state law fixes (transfer and mortgage taxes, recording fees, regulated title premiums) and who pays each by contract or custom, with a worked example. No invented averages: when no official typical total exists, it says so.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'first_time_buyer_programs_us', title: 'US first-time home buyer programs by state',
    description: 'UNITED STATES. The state housing finance agency and its first-time buyer loans, down payment assistance, mortgage credit certificates, income limits and homebuyer education requirement, with official links.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'home_prices_us', title: 'US median home value by state and main city',
    description: 'UNITED STATES. Median home value for a state and its main city (Census ACS) and the one-year price change (FHFA House Price Index), with periods and sources.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'community_property_us', title: 'US community property states',
    description: 'UNITED STATES. Whether a state is a community property state, an opt-in state, or common law, and what that means for buying and titling a home as a married couple.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'title_insurance_us', title: 'US title insurance rates by state',
    description: 'UNITED STATES. Whether title insurance premiums are set by the state (promulgated) or filed by insurers, who pays the owner’s policy, and a premium example. Covered states: Florida, Iowa, New Mexico, Texas.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'natural_hazards_us', title: 'US natural hazards and home insurance by state',
    description: 'UNITED STATES. Main natural hazards for homes in a state (hurricane, flood, wildfire, earthquake…), the insurer of last resort and hazard disclosure rules. Covered: 14 high-risk states.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'verify_license_us', title: 'Verify a US real estate professional’s license',
    description: `UNITED STATES. For a profession (${LISTE_METIERS_US}) in a state: whether a license is required, the regulator, license titles, and the official lookup where the READER checks a license number. Payotte lists no US professionals and never says "verified by Payotte".`,
    inputSchema: { type: 'object', properties: { ...P_ETAT, profession: { type: 'string', description: `Profession: ${LISTE_METIERS_US}.` } }, required: ['state', 'profession'] },
  },
  {
    name: 'compare_states_us', title: 'Compare the 50 US states on one rule',
    description: 'UNITED STATES. Lists the states in each category for one topic: transfer-tax (states with no transfer tax), attorney-at-closing (states requiring an attorney), foreclosure (judicial vs non-judicial states), seller-disclosure (buyer beware states), community-property. Use for "which states…" questions.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(SUJETS_COMPARABLES), description: 'Topic to compare.' } }, required: ['topic'] },
  },
  {
    name: 'state_overview_us', title: 'Buying a home in a US state: key facts',
    description: 'UNITED STATES. Key home-buying facts for a state (transfer tax, property tax, disclosure, attorney, foreclosure) and the list of Payotte articles for that state with their one-line answers.',
    inputSchema: { type: 'object', properties: P_ETAT, required: ['state'] },
  },
  {
    name: 'federal_guide_us', title: 'US federal home-buying guides',
    description: 'UNITED STATES. Finds Payotte’s federal guides (rules that apply in every state): FHA, VA, USDA and conventional loans, PMI, down payment, credit score, debt-to-income, escrow, earnest money, closing costs, 1031 exchange, capital gains on a home sale, mortgage interest deduction, flood insurance, refinancing… Empty query = full list.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Topic, e.g. "FHA loan requirements", "PMI".' } } },
  },
];

export const IMPL_US = {
  transfer_tax_us: transferTaxUs,
  property_tax_us: propertyTaxUs,
  property_tax_appeal_us: propertyTaxAppealUs,
  attorney_at_closing_us: outilSimple('real-estate-attorney', 'real-estate-attorney', 'attorney-required-at-closing'),
  foreclosure_us: outilSimple('foreclosure', 'foreclosure', 'foreclosure'),
  seller_disclosure_us: outilSimple('seller-disclosure', 'seller-disclosure', 'seller-disclosure'),
  closing_costs_us: outilSimple('closing-costs', 'closing-costs', 'closing-costs'),
  first_time_buyer_programs_us: outilSimple('first-time-buyer-programs', 'first-time-buyer-programs', 'first-time-home-buyer-programs'),
  home_prices_us: homePricesUs,
  community_property_us: (a = {}) => {
    const e = etatDe(a.state);
    if (!e) return erreurEtat(a.state);
    if (!ligne('community-property', e)) {
      return { state: e.name, code: e.code, regime: 'common-law',
        answer: `${e.name} is not a community property state: it follows the common-law (separate property) system, where each spouse owns what is titled in their name.`,
        compareAllStates: mcpSrc(`${SITE_US}/by-state/community-property-states`), attribution: ATTRIBUTION_US };
    }
    return reponseSujet(e, 'community-property', 'community-property', 'community-property-states');
  },
  title_insurance_us: outilSimple('title-insurance', 'title-insurance', null),
  natural_hazards_us: outilSimple('natural-hazards-insurance', 'natural-hazards-insurance', null),
  verify_license_us: verifyLicenseUs,
  compare_states_us: compareStatesUs,
  state_overview_us: stateOverviewUs,
  federal_guide_us: federalGuideUs,
};

export const ANNOTATIONS_US = Object.fromEntries(Object.keys(IMPL_US).map((k) => [k, LECTURE_SEULE]));

export const INSTRUCTIONS_US =
  ' UNITED STATES (payotte.com/usa): tools ending in _us answer home-buying rules for each of the 50 states from state statutes and official pages — ' +
  'transfer_tax_us (with a state-tax computation), property_tax_us, property_tax_appeal_us, attorney_at_closing_us, foreclosure_us, seller_disclosure_us, ' +
  'closing_costs_us, first_time_buyer_programs_us, home_prices_us, community_property_us, title_insurance_us, natural_hazards_us, ' +
  'verify_license_us (regulator and official lookup; Payotte lists no US professionals), compare_states_us for "which states…" questions, ' +
  'state_overview_us and federal_guide_us. Cite the page URL returned; this is general information, not legal advice.';
