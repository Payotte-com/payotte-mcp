/**
 * in.js — les outils MCP de Payotte Inde (préparés le 14 oct. 2026, branche brouillon/mcp-inde). NE PAS DÉPLOYER avant la mise en
 * ligne de payotte.com/india : chaque réponse renvoie vers une page du site, qui doit exister.
 *
 * Données GÉNÉRÉES par payotte-astro-inde/scripts/in/export-mcp.mjs (in.json) : taux de droit de timbre et d'enregistrement LUS à la
 * source officielle (7 États et territoires ; les autres ne sont pas calculés), taux RBI, indices RBI HPI et NHB RESIDEX, tableaux
 * « by state », guides et pages métier. Le calcul est une COPIE FIDÈLE de src/lib/in/fraisAchat.ts, recontrôlée par
 * scripts/check-in.mjs sur les mêmes 14 cas que le site.
 * Vocabulaire : aucun professionnel n'est listé en Inde, et aucun avocat ne le sera (règles du Bar Council of India). Les outils disent
 * QUI régit un métier et OÙ le lecteur vérifie une inscription ; jamais « verified by Payotte ».
 */
import IN from './data/in.json' with { type: 'json' };

const SITE_IN = 'https://payotte.com/india';
const ATTRIBUTION_IN =
  'Data: Payotte India (https://payotte.com/india), CC BY 4.0 — cite Payotte with a link to the page given. Stamp duty and registration rates read at each state\'s ' +
  'official source; loan rates and the House Price Index from the Reserve Bank of India; NHB RESIDEX from the National Housing Bank. General information, not tax, legal or financial advice.';
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

// ---------------------------------------------------------------- États
const F = IN.taxes, S = F.etats;
const ETATS = Object.keys(S);
const NOMS = Object.fromEntries([...IN.prices.states.map((s) => [norm(s.name), s.state_code.toLowerCase()]), ...IN.prices.cities.map((c) => [norm(c.name), c.state_code.toLowerCase()])]);
const etatDe = (v) => { const n = norm(v); return n.length === 2 ? n : NOMS[n] ?? null; };

// ---------------------------------------------------------------- droit de timbre (copie de src/lib/in/fraisAchat.ts)
function fraisAchat(prix, etat, o = {}) {
  const St = S[etat], base = Math.max(prix, o.valeurRef ?? 0), av = [...St.notes], lignes = [];
  let regle = 'General rate', minimum = false, taux;
  if (etat === 'mh') {
    const z = o.zoneMh ?? 'corporation'; taux = St.droit.zones[z];
    regle = z === 'gram-panchayat' ? 'Article 25(b)(iii): Gram Panchayat area' : z === 'council' ? 'Article 25(b)(ii): Municipal Council, Nagar Panchayat or MMR rural area' : 'Article 25(b)(i): Municipal Corporation area';
  } else if (o.femme && St.droit.tauxFemme != null) {
    if (St.droit.femmeJusqua != null && base > St.droit.femmeJusqua) { taux = St.droit.taux; regle = 'General rate (upper limit: woman buyer above the threshold)'; av.push(`Woman buyer above ${inr(St.droit.femmeJusqua)}: the general rate is shown as an upper limit.`); }
    else { taux = St.droit.tauxFemme; regle = `Woman buyer rate${St.droit.conditionFemme ? ` (${St.droit.conditionFemme})` : ''}`; }
  } else { taux = St.droit.taux; if (o.femme && etat !== 'mh') av.push('No reduced rate for women buyers was read for this state: the general rate applies here.'); }
  const assiette = St.droit.parCent ? Math.ceil(base / 100) * 100 : base;
  lignes.push({ code: 'droit', libelle: `Stamp duty (${taux}%)`, montant: Math.round(assiette * taux / 100) });
  if (etat === 'mh' && o.femme) av.push('Maharashtra: the 1% reduction for women buyers (order of 31 March 2021) was not read at the source and is not applied.');
  if (etat === 'mh' && o.mumbai) lignes.push({ code: 'metro', libelle: `Metro surcharge, Mumbai (${St.metro.taux}%)`, montant: Math.round(base * St.metro.taux / 100) });
  if (etat === 'mh' && o.mumbai && St.metro.avertissement) av.push(St.metro.avertissement);
  if (St.enregistrement) { const e = St.enregistrement; let m = base * e.taux / 100; if (e.plafond != null) m = Math.min(m, e.plafond); lignes.push({ code: 'enregistrement', libelle: `Registration fee (${e.taux}%${e.plafond != null ? `, at most ${inr(e.plafond)}` : ''})`, montant: Math.round(m) }); }
  else minimum = true;
  for (const f of St.fixes ?? []) lignes.push({ code: 'fixe', libelle: f.libelle, montant: f.montant });
  if (St.surtaxeNonTranchee) { minimum = true; av.push(St.surtaxeNonTranchee); }
  return { base, lignes, total: lignes.reduce((t, l) => t + l.montant, 0), minimum, regle, avertissements: av };
}
function stampDutyIn(a = {}) {
  const prix = Number(a.price);
  if (!(prix > 0)) return { error: 'price is required (in rupees, e.g. 5000000 for ₹50 lakh).' };
  const e = etatDe(a.state);
  if (!e || !S[e]) {
    const nom = Object.entries(F.nonCalcules).find(([k, v]) => k === e || norm(v) === norm(a.state))?.[1];
    return { state: nom ?? a.state ?? null, computed: false, computed_states: ETATS.map((k) => S[k].nom),
      answer: `Payotte does not compute stamp duty for ${nom ?? `"${a.state ?? ''}"`}: the state's official rate pages could not be read (most state registration portals refuse connections from outside India), and Payotte publishes no figure it has not read at the source. Check with the state's Inspector General of Registration.`,
      page: mcpSrc(`${SITE_IN}/stamp-duty-calculator`), attribution: ATTRIBUTION_IN };
  }
  const r = fraisAchat(prix, e, { valeurRef: Number(a.reference_value) || 0, femme: a.woman_buyer === true, zoneMh: a.maharashtra_area, mumbai: a.mumbai === true });
  return { state: S[e].nom, price: prix, value_charged: r.base, rule: r.regle,
    line_items: r.lignes.map((l) => ({ item: l.libelle, amount: l.montant })), total: r.total, total_is_lower_limit: r.minimum,
    answer: `On ${inr(prix)} in ${S[e].nom}${e === 'mh' && a.mumbai ? ' (Mumbai)' : ''}, ${r.lignes.map((l) => `${l.libelle.charAt(0).toLowerCase()}${l.libelle.slice(1)} ${inr(l.montant)}`).join(', ')}: ${r.minimum ? 'at least ' : ''}${inr(r.total)}, on the higher of the price and the ${S[e].valeurRef}.`,
    warnings: r.avertissements, rates_read: F.releve, source: S[e].source, page: mcpSrc(`${SITE_IN}/stamp-duty-calculator`), attribution: ATTRIBUTION_IN };
}

// ---------------------------------------------------------------- prêt
function homeLoanEmiIn(a = {}) {
  const P = Number(a.loan_amount), W = IN.loans.walrLogement;
  const t = a.interest_rate == null ? W.nouveaux : Number(a.interest_rate), n = Math.round((Number(a.tenure_years) || 20) * 12);
  if (!(P > 0) || !(t >= 0) || !(n > 0)) return { error: 'loan_amount (₹) is required; interest_rate (% a year) and tenure_years are optional.' };
  const r = t / 1200, emi = r === 0 ? P / n : P * r * (1 + r) ** n / ((1 + r) ** n - 1);
  return { loan_amount: P, interest_rate: t, rate_used: a.interest_rate == null ? `RBI weighted average lending rate on fresh housing loans, ${W.mois} (provisional)` : 'rate given',
    tenure_months: n, emi: Math.round(emi), total_interest: Math.round(emi * n - P), formula: 'EMI = P × r × (1 + r)^n ÷ ((1 + r)^n − 1), r = annual rate ÷ 12 ÷ 100',
    loan_to_value_caps: 'RBI, Commercial Banks – Credit Facilities Directions 2025, para 111: up to ₹30 lakh 90%; above ₹30 lakh up to ₹75 lakh 80%; above ₹75 lakh 75%; stamp duty and registration not financed (para 113) except on a home costing ₹10 lakh or less.',
    repo_rate: `${IN.loans.repo.taux}% since ${IN.loans.repo.depuis}`, page: mcpSrc(`${SITE_IN}/home-loan-calculator`), attribution: ATTRIBUTION_IN };
}

// ---------------------------------------------------------------- prix
function housePricesIn(a = {}) {
  const P = IN.prices, R = P.residex, B = P.rbi;
  const c = a.city ? P.cities.find((x) => norm(x.name) === norm(a.city) || x.slug === norm(a.city)) : null;
  const base = { rbi_hpi: { index: B.indice, base: B.base, change_quarter_pct: B.trimestre, change_12m_pct: B.annuel, period: B.periode, cities: B.villes, source: B.source, url: B.url },
    residex_composite_50_cities_change_12m_pct: R.composite50, residex_period: R.periode,
    note: 'No official, openly readable series gives home prices in rupees city by city: the RBI and the NHB publish indices.', attribution: ATTRIBUTION_IN };
  if (a.city && !c) return { error: `City "${a.city}" not covered. Cities: ${P.cities.map((x) => x.name).join(', ')}.`, ...base };
  if (!c) return { answer: `House prices rose ${B.annuel}% over a year in the RBI's 18-city index (${B.periode}) and ${R.composite50}% in the NHB RESIDEX 50-city index (${R.periode}).`, ...base, page: mcpSrc(`${SITE_IN}/cities`) };
  return { city: c.name, state: c.state, residex_change_12m_pct: c.residex_change_12m_pct, rbi_hpi_city: c.rbi_hpi_city,
    answer: c.residex_change_12m_pct != null ? `In ${c.name}, the NHB RESIDEX index changed by ${c.residex_change_12m_pct}% over a year (${R.periode}).` : `${c.name}: no city figure published in the NHB release read${c.rbi_hpi_city ? '; it is one of the 18 RBI index cities (city series in the RBI DBIE database)' : ''}.`,
    ...base, page: mcpSrc(c.url) };
}

// ---------------------------------------------------------------- tableaux, guides, métiers
function compareStatesIn(a = {}) {
  const t = IN.tables[norm(a.topic)];
  if (!t) return { error: `Unknown topic "${a.topic ?? ''}". Topics: ${Object.keys(IN.tables).join(', ')}.`, all_tables: mcpSrc(`${SITE_IN}/by-state`) };
  const states = Object.fromEntries(Object.entries(t.states).map(([k, l]) => [S[k]?.nom ?? k, { answer: l.answer, details: Object.fromEntries(Object.entries(l).filter(([c]) => !['answer', 'sources'].includes(c))), sources: l.sources }]));
  return { topic: norm(a.topic), compiled: t.compiled, states, not_computed: Object.values(F.nonCalcules), table: mcpSrc(t.url), attribution: ATTRIBUTION_IN };
}
function guideIn(a = {}) {
  const mots = norm(a.query).split('-').filter((m) => m.length > 2);
  if (!mots.length) return { error: 'query is required, e.g. "NRI buying property", "TDS on property purchase", "rent agreement registration".' };
  const score = (g) => mots.reduce((s, m) => s + (norm(g.title).includes(m) ? 3 : 0) + (norm(g.description).includes(m) ? 1 : 0) + (g.slug.includes(m) ? 2 : 0), 0);
  const res = IN.guides.map((g) => ({ g, s: score(g) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 3);
  if (!res.length) return { results: [], note: 'No Payotte India guide matches; see the list of guides.', all_guides: mcpSrc(`${SITE_IN}/guides`) };
  return { results: res.map(({ g }) => ({ title: g.title, answer: g.answer, checked: g.checked, url: mcpSrc(g.url) })), attribution: ATTRIBUTION_IN };
}
const METIERS = { 'real-estate-agent': 'real-estate-agent', agent: 'real-estate-agent', broker: 'real-estate-agent', 'property-dealer': 'real-estate-agent',
  'registered-valuer': 'registered-valuer', valuer: 'registered-valuer', 'property-valuer': 'registered-valuer', architect: 'architect',
  'home-loan-lender': 'home-loan-lender', lender: 'home-loan-lender', bank: 'home-loan-lender', hfc: 'home-loan-lender', 'housing-finance-company': 'home-loan-lender',
  'property-lawyer': 'property-lawyer', lawyer: 'property-lawyer', advocate: 'property-lawyer' };
function checkProfessionalIn(a = {}) {
  const s = METIERS[norm(a.trade)], p = s && IN.professions.find((x) => x.slug === s);
  if (!p) return { error: `Unknown trade "${a.trade ?? ''}". Trades: real estate agent, registered valuer, architect, home loan lender, property lawyer.` };
  return { trade: s, answer: p.answer, page: mcpSrc(p.url), checked: p.checked,
    note: s === 'property-lawyer' ? 'Payotte lists no lawyer in India (Bar Council of India rules on advertising by advocates). The page says where YOU check an enrolment.' : 'Payotte lists no Indian professional yet. The page names the register where YOU check a registration; Payotte never queries registers in series.', attribution: ATTRIBUTION_IN };
}

// ---------------------------------------------------------------- déclarations
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const TOOLS_IN = [
  { name: 'stamp_duty_in', title: 'Indian stamp duty and registration on a home, by state',
    description: `INDIA. Computes stamp duty and the registration fee on a home purchase in the states and union territories whose official rates Payotte read (${ETATS.map((k) => S[k].nom).join(', ')}), on the higher of the price and the reference value, with women buyer rates and the Mumbai metro surcharge. Other states (Delhi, Karnataka, Tamil Nadu…) return "not computed" with no figure.`,
    inputSchema: { type: 'object', properties: { price: { type: 'number', description: 'Price in rupees (₹50 lakh = 5000000).' },
      state: { type: 'string', description: 'State or union territory (name, ISO code like KL, or a covered city like Mumbai).' },
      reference_value: { type: 'number', description: 'State reference value (guidance value, circle rate…) in rupees, if known.' },
      woman_buyer: { type: 'boolean', description: 'Woman buyer (reduced rate where the state text provides one).' },
      maharashtra_area: { type: 'string', enum: ['corporation', 'council', 'gram-panchayat'], description: 'Maharashtra only: Municipal Corporation, Municipal Council/Nagar Panchayat/MMR rural, or Gram Panchayat area.' },
      mumbai: { type: 'boolean', description: 'Maharashtra only: property in Mumbai (BMC), 1% metro surcharge.' } }, required: ['price', 'state'] } },
  { name: 'home_loan_emi_in', title: 'Indian home loan EMI',
    description: 'INDIA. EMI, total interest and the RBI loan-to-value caps for a home loan; default rate = RBI weighted average lending rate on fresh housing loans (latest month, provisional).',
    inputSchema: { type: 'object', properties: { loan_amount: { type: 'number', description: 'Loan in rupees.' }, interest_rate: { type: 'number', description: '% a year (optional).' }, tenure_years: { type: 'number', description: 'Years (default 20).' } }, required: ['loan_amount'] } },
  { name: 'house_prices_in', title: 'Indian house price indices (RBI, NHB RESIDEX)',
    description: 'INDIA. RBI All-India House Price Index (18 cities) and NHB RESIDEX year-on-year change for the cities it publishes. Indices only: no official open series gives rupee prices by city.',
    inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'e.g. "Bengaluru", "Mumbai". Empty = all-India indices.' } } } },
  { name: 'compare_states_in', title: 'Indian property rules compared across the states',
    description: 'INDIA. One rule compared across the states whose official rates Payotte read (purchase-duty, women-buyer-rates).',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(IN.tables), description: 'Topic of the table.' } }, required: ['topic'] } },
  { name: 'guide_in', title: 'Payotte India guides: buying, NRIs, renting and owning a home',
    description: 'INDIA. Finds the Payotte guide answering a question about buying, financing, selling, renting or owning a home in India, including NRI and OCI rules, and returns its self-contained short answer, check date and URL.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The question or keywords, e.g. "NRI repatriation", "TDS on property purchase".' } }, required: ['query'] } },
  { name: 'check_professional_in', title: 'Who regulates an Indian property professional, and where to check one',
    description: 'INDIA. For a real estate agent (state RERA), registered valuer (IBBI), architect (Council of Architecture), home loan lender (RBI) or property lawyer (State Bar Council): where the reader checks a registration. Payotte lists no Indian professional yet and never lists lawyers.',
    inputSchema: { type: 'object', properties: { trade: { type: 'string', description: 'real estate agent, registered valuer, architect, home loan lender or property lawyer.' } }, required: ['trade'] } },
];
export const IMPL_IN = { stamp_duty_in: stampDutyIn, home_loan_emi_in: homeLoanEmiIn, house_prices_in: housePricesIn, compare_states_in: compareStatesIn, guide_in: guideIn, check_professional_in: checkProfessionalIn };
export const ANNOTATIONS_IN = Object.fromEntries(Object.keys(IMPL_IN).map((k) => [k, LECTURE_SEULE]));
export const INSTRUCTIONS_IN =
  ' INDIA (payotte.com/india): tools ending in _in — stamp_duty_in computes stamp duty and registration for the states whose official rates were read (others: not computed, never estimate them), ' +
  'home_loan_emi_in gives the EMI at the RBI average housing rate with the RBI loan-to-value caps, house_prices_in gives RBI and NHB indices (no rupee prices by city), compare_states_in compares one rule, ' +
  'guide_in finds the guide answering a question (NRIs included), check_professional_in says where to check a registration (no lawyer is ever listed in India). Cite the page URL returned; general information, not advice.';
