/**
 * es.js — les outils MCP de Payotte Espagne (préparés le 15 oct. 2026, branche brouillon/mcp-espagne). NE PAS DÉPLOYER avant la mise
 * en ligne de payotte.com/spain : chaque réponse renvoie vers une page du site, qui doit exister.
 *
 * Données GÉNÉRÉES par payotte-astro-espagne/scripts/es/export-mcp.mjs (src/data/es.json) ; le CALCUL (src/esCalc.js) est le module
 * du site empaqueté par esbuild (src/lib/es/fraisAchat.ts, calculateurs.ts, pret.ts), pas une copie à la main ; scripts/check-es.mjs
 * le recontrôle sur des cas du site. Vocabulaire : aucun professionnel n'est listé en Espagne, aucun avocat ne le sera ; les outils
 * disent OÙ le lecteur vérifie une inscription ; jamais « verified by Payotte ».
 */
import ES from './data/es.json' with { type: 'json' };
import { fraisAchat, REGIONS, FA, irnr, mensualite } from './esCalc.js';

const SITE_ES = 'https://payotte.com/spain';
const ATTRIBUTION_ES =
  'Data: Payotte Spain (https://payotte.com/spain), CC BY 4.0 — cite Payotte with a link to the page given. Tax rates read in the consolidated texts of the BOE and the foral ' +
  'Diputaciones; reference rates from the Banco de España; appraised values from the Spanish ministry\'s statistics; house price index from the INE. General information, not tax, legal or financial advice.';
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const eur = (n) => '€' + Math.round(n).toLocaleString('en-GB');
const P = ES.prices;
const ALIAS = { madrid: 'community-of-madrid', valencia: 'valencian-community', 'comunitat-valenciana': 'valencian-community', 'comunidad-valenciana': 'valencian-community',
  cataluna: 'catalonia', catalunya: 'catalonia', andalucia: 'andalusia', baleares: 'balearic-islands', 'illes-balears': 'balearic-islands', canarias: 'canary-islands',
  'pais-vasco': 'basque-country', euskadi: 'basque-country', navarra: 'navarre', 'castilla-y-leon': 'castile-and-leon', 'region-de-murcia': 'murcia', 'region-of-murcia': 'murcia', asturies: 'asturias' };
/** Region slug from a region name, its Spanish name or a covered city. */
function regionDe(v) {
  const n = norm(v); if (!n) return null;
  if (FA.regions[n]) return n;
  if (ALIAS[n]) return ALIAS[n];
  const r = P.regions.find((x) => norm(x.name) === n || norm(x.name_es) === n); if (r) return r.slug;
  const c = P.cities.find((x) => x.slug === n || norm(x.name) === n || norm(x.name_es) === n); return c ? c.region : null;
}
const nomR = (k) => P.regions.find((r) => r.slug === k)?.name ?? FA.regions[k].nom_en;

function purchaseCostsEs(a = {}) {
  const prix = Number(a.price);
  if (!(prix > 0)) return { error: 'price is required (in euros, e.g. 300000).' };
  const k = regionDe(a.region);
  if (!k) return { error: `Unknown region "${a.region ?? ''}". Regions: ${REGIONS.map(nomR).join(', ')} (a covered city also works).` };
  const type = a.new_home === true ? 'new' : 'resale';
  const r = fraisAchat(prix, k, { valeurRef: Number(a.reference_value) || 0, type });
  const lab = { itp: 'Transfer tax (ITP)', iva: 'VAT (IVA)', igic: 'Canary Islands IGIC', ipsi: 'IPSI (rate not read: not computed)', ajd: 'Stamp duty on the deed (AJD)', registre: 'Land registry (registration + presentation)' };
  const lignes = r.lignes.map((l) => ({ item: lab[l.code], rate_pct: l.taux, amount: l.montant }));
  return { region: nomR(k), price: prix, home: type, value_taxed: r.base, line_items: lignes, buyer_total: r.total, total_is_lower_limit: r.minimum,
    notary_deed_fee: r.notaire, notary_note: 'By default the seller pays the notary\'s deed and the buyer the first copy (Civil Code art. 1455); copies and folios not computed.',
    answer: `On a ${eur(prix)} ${type === 'new' ? 'new' : 'resale'} home in ${nomR(k)}, ${lignes.filter((l) => l.amount != null).map((l) => `${l.item.toLowerCase()} ${eur(l.amount)}`).join(', ')}: ${r.minimum ? 'at least ' : ''}${eur(r.total)} for the buyer at the general rates${r.foral ? ' (foral rules, real value)' : ', on the higher of the price and the Catastro reference value'}.`,
    not_applied: 'Reduced rates (young buyers, large families, disability, main home under caps), the 20% Catalan rate for large holders, the optional notary discount.',
    rates_read: FA.releve, source: FA.regions[k][type === 'new' ? 'ajd_neuf' : 'itp'].source, page: mcpSrc(`${SITE_ES}/purchase-costs-calculator`), attribution: ATTRIBUTION_ES };
}
function mortgagePaymentEs(a = {}) {
  const C = Number(a.loan_amount), TM = ES.loans.tipoMedio;
  const t = a.interest_rate == null ? TM.taux : Number(a.interest_rate), y = Number(a.term_years) || 25;
  if (!(C > 0) || !(t >= 0) || !(y > 0)) return { error: 'loan_amount (€) is required; interest_rate (% a year) and term_years are optional.' };
  const m = mensualite(C, t, y);
  return { loan_amount: C, interest_rate: t, rate_used: a.interest_rate == null ? `Banco de España average rate on mortgages over three years for open-market housing, ${TM.mois}` : 'rate given',
    term_years: y, monthly_payment: Math.round(m * 100) / 100, total_interest: Math.round(m * y * 12 - C), formula: 'payment = P × r × (1 + r)^n ÷ ((1 + r)^n − 1), r = annual rate ÷ 12 ÷ 100',
    euribor_12m: `${ES.loans.euribor.taux}% (${ES.loans.euribor.mois})`, loan_to_value: 'Spanish law sets no maximum loan-to-value; the lender decides.',
    page: mcpSrc(`${SITE_ES}/mortgage-calculator`), attribution: ATTRIBUTION_ES };
}
function nonResidentTaxEs(a = {}) {
  const v = Number(a.cadastral_value);
  if (!(v > 0)) return { error: 'cadastral_value (€, on the IBI bill) is required.' };
  const j = Math.min(365, Number(a.days_owned) || 365), part = Number(a.share_pct) || 100, ue = a.eu_eea_resident === true;
  const r = irnr(v, a.values_revised === true, j, part, ue);
  return { tax_year: ES.irnr.exercice, imputed_income: r.revenu, rate_pct: r.taux, tax: r.impot,
    answer: `A non-resident ${ue ? 'living in the EU/EEA' : 'living outside the EU/EEA'} who does not let the home pays ${eur(r.impot)} of non-resident income tax for ${ES.irnr.exercice} on a cadastral value of ${eur(v)} (${a.values_revised ? '1.1' : '2'}% imputed income × ${r.taux}%${j < 365 ? `, ${j} days` : ''}${part < 100 ? `, ${part}% share` : ''}).`,
    filing: 'Form 210; for 2026 imputed income, from 1 April to 31 December 2027 (AEAT).', next: ES.irnr.aVenir,
    page: mcpSrc(`${SITE_ES}/non-resident-tax-calculator`), attribution: ATTRIBUTION_ES };
}
function housePricesEs(a = {}) {
  const V = P.valor_tasado, I = P.ipv;
  const base = { national: { appraised_value_eur_m2: V.national, change_12m_pct: V.nationalAn, period: V.periode, ipv_change_12m_pct: I.national },
    measure: V.mesure, sources: [{ title: V.source, url: V.url }, { title: I.source, url: I.url }], attribution: ATTRIBUTION_ES };
  const n = norm(a.place);
  if (!n) return { answer: `Appraised home values averaged ${eur(V.national)}/m² in Spain in ${V.periode} (+${V.nationalAn}% over a year); the INE house price index rose ${I.national}%.`, ...base, page: mcpSrc(`${SITE_ES}/cities`) };
  const c = P.cities.find((x) => x.slug === n || norm(x.name) === n || norm(x.name_es) === n);
  if (c) return { city: c.name, region: nomR(c.region), appraised_value_eur_m2: c.appraised_value_eur_m2, valuations: c.valuations, appraised_change_12m_pct: c.appraised_change_12m_pct, population_2025: c.population_2025,
    answer: `In ${c.name}, open-market homes were appraised at ${eur(c.appraised_value_eur_m2)}/m² on average in ${V.periode} (${c.valuations} valuations)${c.appraised_change_12m_pct != null ? `, ${c.appraised_change_12m_pct > 0 ? '+' : ''}${c.appraised_change_12m_pct}% over a year` : ''}.`, ...base, page: mcpSrc(c.url) };
  const k = regionDe(a.place), r = k && P.regions.find((x) => x.slug === k);
  if (r) return { region: r.name, appraised_value_eur_m2: r.appraised_value_eur_m2, appraised_change_12m_pct: r.appraised_change_12m_pct, ipv_change_12m_pct: r.ipv_change_12m_pct,
    answer: `In ${r.name}, homes were appraised at ${eur(r.appraised_value_eur_m2)}/m² in ${V.periode} (+${r.appraised_change_12m_pct}% over a year); the INE index rose ${r.ipv_change_12m_pct}%.`, ...base, page: mcpSrc(r.url) };
  return { error: `"${a.place}" is not covered. Cities: ${P.cities.map((x) => x.name).join(', ')}.`, ...base };
}
function compareRegionsEs(a = {}) {
  const t = ES.tables[norm(a.topic)];
  if (!t) return { error: `Unknown topic "${a.topic ?? ''}". Topics: ${Object.keys(ES.tables).join(', ')}.`, all_tables: mcpSrc(`${SITE_ES}/by-region`) };
  const regions = Object.fromEntries(Object.entries(t.regions).map(([k, l]) => [nomR(k), { answer: l.answer, details: Object.fromEntries(Object.entries(l).filter(([c]) => !['answer', 'sources'].includes(c))), sources: l.sources }]));
  return { topic: norm(a.topic), compiled: t.compiled, regions, table: mcpSrc(t.url), attribution: ATTRIBUTION_ES };
}
function guideEs(a = {}) {
  const mots = norm(a.query).split('-').filter((m) => m.length > 2);
  if (!mots.length) return { error: 'query is required, e.g. "NIE number", "3% withholding non-resident seller", "tourist rental registration".' };
  const score = (g) => mots.reduce((s, m) => s + (norm(g.title).includes(m) ? 3 : 0) + (norm(g.description).includes(m) ? 1 : 0) + (g.slug.includes(m) ? 2 : 0), 0);
  const res = ES.guides.map((g) => ({ g, s: score(g) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 3);
  if (!res.length) return { results: [], note: 'No Payotte Spain guide matches; see the list of guides.', all_guides: mcpSrc(`${SITE_ES}/guides`) };
  return { results: res.map(({ g }) => ({ title: g.title, answer: g.answer, checked: g.checked, url: mcpSrc(g.url) })), attribution: ATTRIBUTION_ES };
}
const METIERS = { 'real-estate-agent': 'real-estate-agent', agent: 'real-estate-agent', 'estate-agent': 'real-estate-agent', 'agente-inmobiliario': 'real-estate-agent', api: 'real-estate-agent',
  'property-valuer': 'property-valuer', valuer: 'property-valuer', tasador: 'property-valuer', 'sociedad-de-tasacion': 'property-valuer', appraiser: 'property-valuer',
  architect: 'architect', arquitecto: 'architect', aparejador: 'architect', 'arquitecto-tecnico': 'architect',
  'mortgage-lender': 'mortgage-lender', lender: 'mortgage-lender', bank: 'mortgage-lender', 'mortgage-broker': 'mortgage-lender', 'credit-intermediary': 'mortgage-lender',
  'property-lawyer': 'property-lawyer', lawyer: 'property-lawyer', abogado: 'property-lawyer', solicitor: 'property-lawyer' };
function checkProfessionalEs(a = {}) {
  const s = METIERS[norm(a.trade)], p = s && ES.professions.find((x) => x.slug === s);
  if (!p) return { error: `Unknown trade "${a.trade ?? ''}". Trades: real estate agent, property valuer, architect, mortgage lender, property lawyer.` };
  return { trade: s, answer: p.answer, page: mcpSrc(p.url), checked: p.checked,
    note: s === 'property-lawyer' ? 'Payotte lists no lawyer in Spain (the Spanish code of conduct makes a lawyer answerable for advertising by a third party). The page says where YOU check a lawyer.' : 'Payotte lists no Spanish professional yet. The page names the register where YOU check a registration; Payotte never queries registers in series.', attribution: ATTRIBUTION_ES };
}

const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const TOOLS_ES = [
  { name: 'purchase_costs_es', title: 'Spanish purchase taxes and fees on a home, by region',
    description: 'SPAIN. Computes transfer tax (ITP) on a resale home, or VAT/IGIC and stamp duty (AJD) on a new home, plus land registry fees and the notary\'s deed fee, at the general rates of each of the 17 regions, Ceuta and Melilla (official texts read), on the higher of the price and the Catastro reference value.',
    inputSchema: { type: 'object', properties: { price: { type: 'number', description: 'Price in euros.' }, region: { type: 'string', description: 'Region (English or Spanish name) or a covered city (e.g. "Marbella", "Andalucía").' },
      new_home: { type: 'boolean', description: 'New home bought from the developer (VAT + AJD) instead of a resale home (ITP).' }, reference_value: { type: 'number', description: 'Catastro reference value in euros, if known.' } }, required: ['price', 'region'] } },
  { name: 'mortgage_payment_es', title: 'Spanish mortgage monthly payment',
    description: 'SPAIN. Monthly payment and total interest of a repayment mortgage; default rate = Banco de España average rate on mortgages over three years (latest month). Also returns the 12-month Euribor.',
    inputSchema: { type: 'object', properties: { loan_amount: { type: 'number', description: 'Loan in euros.' }, interest_rate: { type: 'number', description: '% a year (optional).' }, term_years: { type: 'number', description: 'Years (default 25).' } }, required: ['loan_amount'] } },
  { name: 'non_resident_tax_es', title: 'Spanish non-resident tax on a home that is not let',
    description: 'SPAIN. Non-resident income tax (IRNR) for 2026 on the imputed income of a home a non-resident keeps without letting it: 2% (or 1.1%) of the cadastral value, taxed at 24% (19% for EU/EEA residents).',
    inputSchema: { type: 'object', properties: { cadastral_value: { type: 'number', description: 'Cadastral value in euros (IBI bill).' }, values_revised: { type: 'boolean', description: 'Municipal cadastral values revised in the last ten years (1.1%).' },
      days_owned: { type: 'number', description: 'Days owned in the year (default 365).' }, share_pct: { type: 'number', description: 'Ownership share in % (default 100).' }, eu_eea_resident: { type: 'boolean', description: 'Resident of an EU/EEA state (19%); otherwise 24% (UK, Canada, USA…).' } }, required: ['cadastral_value'] } },
  { name: 'house_prices_es', title: 'Spanish home values by city and region',
    description: 'SPAIN. Ministry average appraised value per m² (Q2 2026) for 55 cities and the 19 regions, its change over a year, and the INE house price index by region.',
    inputSchema: { type: 'object', properties: { place: { type: 'string', description: 'City or region, e.g. "Marbella", "Balearic Islands". Empty = Spain.' } } } },
  { name: 'compare_regions_es', title: 'Spanish property rules compared across the regions',
    description: 'SPAIN. One rule compared across the 19 regions: purchase-tax, new-home-taxes, young-buyer-rates, large-family-rates, appraised-values, house-price-index, agent-registers, stressed-market-areas.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(ES.tables), description: 'Topic of the table.' } }, required: ['topic'] } },
  { name: 'guide_es', title: 'Payotte Spain guides: buying as a foreigner, taxes, renting and owning',
    description: 'SPAIN. Finds the Payotte guide answering a question about buying (including as a foreign or non-resident buyer: NIE, IRNR, 3% withholding, golden visa), financing, selling, renting or owning a home in Spain, and returns its short answer, check date and URL.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The question or keywords.' } }, required: ['query'] } },
  { name: 'check_professional_es', title: 'Who regulates a Spanish property professional, and where to check one',
    description: 'SPAIN. For a real estate agent (regional registers), property valuer (Banco de España), architect (colegios), mortgage lender (Banco de España) or property lawyer (bar associations): where the reader checks. Payotte lists no Spanish professional yet and never lists lawyers.',
    inputSchema: { type: 'object', properties: { trade: { type: 'string', description: 'real estate agent, property valuer, architect, mortgage lender or property lawyer.' } }, required: ['trade'] } },
];
export const IMPL_ES = { purchase_costs_es: purchaseCostsEs, mortgage_payment_es: mortgagePaymentEs, non_resident_tax_es: nonResidentTaxEs, house_prices_es: housePricesEs,
  compare_regions_es: compareRegionsEs, guide_es: guideEs, check_professional_es: checkProfessionalEs };
export const ANNOTATIONS_ES = Object.fromEntries(Object.keys(IMPL_ES).map((k) => [k, LECTURE_SEULE]));
export const INSTRUCTIONS_ES =
  ' SPAIN (payotte.com/spain): tools ending in _es — purchase_costs_es computes transfer tax or VAT + AJD, registry and notary fees in each region at the general rates (reduced rates not applied), ' +
  'mortgage_payment_es gives the monthly payment at the Banco de España average rate, non_resident_tax_es computes the yearly IRNR on a home not let, house_prices_es gives appraised values per m² and the INE index, ' +
  'compare_regions_es compares one rule across the 19 regions, guide_es finds the guide answering a question (foreign buyers included), check_professional_es says where to check a registration (no lawyer is ever listed). Cite the page URL returned; general information, not advice.';
