/**
 * mx.js — les outils MCP de Payotte Mexique (préparés le 15 oct. 2026, branche brouillon/mcp-mexique). NE PAS DÉPLOYER avant la mise en
 * ligne de payotte.com/mexico : chaque réponse renvoie vers une page du site, qui doit exister.
 *
 * Données GÉNÉRÉES par payotte-astro-mexique/scripts/mx/export-mcp.mjs (mx.json) : impôt d'acquisition et droit d'inscription LUS dans
 * les lois 2026 (53 municipios ; les autres ne sont pas calculés), taux Banxico, prix SHF par État et indice par municipio, tableaux
 * « by state », guides et pages métier. Le calcul est une COPIE FIDÈLE de src/lib/mx/fraisAchat.ts, recontrôlée par scripts/check-mx.mjs
 * sur les cas du site. Vocabulaire : aucun professionnel n'est listé au Mexique, et ni notaire ni avocat ne le sera (publicité
 * encadrée). Les outils disent OÙ le lecteur vérifie un titre ; jamais « verified by Payotte ».
 */
import MX from './data/mx.json' with { type: 'json' };

const SITE_MX = 'https://payotte.com/mexico';
const ATTRIBUTION_MX =
  'Data: Payotte Mexico (https://payotte.com/mexico) — cite Payotte with a link to the page given. Acquisition tax and recording fees read in each municipality\'s and state\'s 2026 laws; ' +
  'mortgage rates from the Banco de México; appraisal values and price index from the Sociedad Hipotecaria Federal (cited, not relicensed). General information, not tax, legal or financial advice.';
const mcpSrc = (url) => (url ? url + (url.includes('?') ? '&' : '?') + 'src=mcp' : url);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const mxn = (n) => 'MX$' + Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------- impôt d'acquisition (copie de src/lib/mx/fraisAchat.ts)
const F = MX.taxes, MUN = F.municipios, UMA_J = F.uma.diaria, UMA_A = F.uma.anual;
const c2 = (x) => Math.round(x * 100) / 100;
function bareme(base, t) { let r = t[0]; for (const l of t) if (base >= l[0]) r = l; return r[1] + (base - r[0]) * r[2] / 100; }
function isai(base, m) {
  const M = MUN[m], ded = (M.abattementUmaAn ?? 0) * UMA_A + (M.abattementUmaJourAn ?? 0) * UMA_J * 365, b = Math.max(0, base - ded);
  let x;
  if (M.methode === 'taux') x = b * M.taux / 100;
  else if (M.methode === 'tranche') { let t = M.tranches[0]; for (const l of M.tranches) if (b >= l[0]) t = l; x = b * t[1] / 100; }
  else { const u = M.unite === 'UMA' ? UMA_J : 1; x = bareme(b / u, M.bareme) * u; }
  if (M.minimumUma != null) x = Math.max(x, M.minimumUma * UMA_J);
  return c2(x);
}
function rpp(base, etat) {
  const E = F.etats[etat]?.rpp; if (!E) return null;
  const fixe = (E.fixeMxn ?? 0) + (E.fixeUma ?? 0) * UMA_J; let v = 0; const tr = E.tranches;
  const dans = tr && (tr[tr.length - 1][0] == null || base <= tr[tr.length - 1][0]);
  if (tr && dans) v = tr.find((l) => l[0] == null || base <= l[0])[1];
  else if (E.taux != null) { v = base * E.taux / 100; if (E.minUma != null) v = Math.max(v, E.minUma * UMA_J); if (E.maxUma != null) v = Math.min(v, E.maxUma * UMA_J); if (E.maxMxn != null) v = Math.min(v, E.maxMxn); }
  return c2(fixe + v);
}
function fraisAchat(prix, m, ref = 0) {
  const M = MUN[m], base = Math.max(prix, ref), av = [...(M.notes ?? [])], t = isai(base, m), lignes = [{ item: M.impot, amount: t }];
  let sur = 0;
  if (M.surtaxe) { const s = c2(t * M.surtaxe / 100); sur += s; lignes.push({ item: `${M.surtaxeLibelle} (${M.surtaxe}% of the tax)`, amount: s }); }
  if (M.surtaxeBase) { const s = c2(base * M.surtaxeBase / 100); sur += s; lignes.push({ item: `${M.surtaxeLibelle} (${M.surtaxeBase}% of the base)`, amount: s }); }
  if (M.fixesUma) { const s = c2(M.fixesUma * UMA_J); sur += s; lignes.push({ item: `${M.fixesLibelle} (${M.fixesUma} UMA)`, amount: s }); }
  const r = rpp(base, M.etat);
  if (r != null) lignes.push({ item: 'Recording fee, Registro Público de la Propiedad', amount: r });
  else av.push(`The recording fee of ${F.etats[M.etat]?.nom ?? 'the state'} was not read at the source and is not included.`);
  if (F.etats[M.etat]?.rpp?.notes) av.push(...F.etats[M.etat].rpp.notes);
  return { base, lignes, isai: c2(t + sur), rpp: r, total: c2(lignes.reduce((s, l) => s + l.amount, 0)), minimum: r == null || F.etats[M.etat]?.rpp?.partiel === true, avertissements: av };
}
const MUNS = MX.prices.municipalities;
function trouverMun(v) {
  const n = norm(v); if (!n) return null;
  if (MUN[n]) return n;
  const z = MUNS.find((x) => norm(x.name) === n || norm(x.name.replace(/\s*\(.*\)$/, '')) === n || (x.localities ?? []).some((l) => norm(l) === n));
  return z ? z.slug : null;
}
function closingCostsMx(a = {}) {
  const prix = Number(a.price);
  if (!(prix > 0)) return { error: 'price is required (in Mexican pesos, e.g. 3000000 for MX$3 million).' };
  const m = trouverMun(a.municipality);
  if (!m || !MUN[m]) {
    const non = F.nonCalcules[m] ?? Object.entries(F.nonCalcules).find(([k]) => norm(k) === norm(a.municipality))?.[1];
    return { municipality: a.municipality ?? null, computed: false, computed_municipalities: Object.values(MUN).map((x) => x.nom),
      answer: non ? `Not computed: ${non}. Payotte publishes no figure it has not read at the source; ask the municipal treasury or the notary.`
        : `Payotte does not compute the acquisition tax of "${a.municipality ?? ''}" yet: each municipality's 2026 law sets it, and Payotte publishes no figure it has not read at the source.`,
      page: mcpSrc(`${SITE_MX}/closing-costs-calculator`), attribution: ATTRIBUTION_MX };
  }
  const M = MUN[m], r = fraisAchat(prix, m, Number(a.appraisal_or_cadastral_value) || 0);
  return { municipality: M.nom, state: F.etats[M.etat]?.nom ?? null, price: prix, value_taxed: r.base, tax_base_rule: M.base,
    line_items: r.lignes, acquisition_tax: r.isai, recording_fee: r.rpp, total: r.total, total_is_lower_limit: r.minimum,
    answer: `On ${mxn(prix)} in ${M.nom}, ${r.lignes.map((l) => `${l.item.charAt(0).toLowerCase()}${l.item.slice(1)} ${mxn(l.amount)}`).join(', ')}: ${r.minimum ? 'at least ' : ''}${mxn(r.total)} before notary fees, under the 2026 laws read.`,
    warnings: r.avertissements, not_included: 'notary fees, appraisal, certificate of liens, SRE fees for a foreign buyer, reductions for social housing or first homes', rules_read: F.releve,
    source: M.source, page: mcpSrc(m && MUNS.find((x) => x.slug === m)?.url || `${SITE_MX}/closing-costs-calculator`), attribution: ATTRIBUTION_MX };
}

// ---------------------------------------------------------------- prêt
function mortgagePaymentMx(a = {}) {
  const P = Number(a.loan_amount), H = MX.loans.hypothecaire;
  const t = a.interest_rate == null ? H.taux : Number(a.interest_rate), n = Math.round((Number(a.term_years) || 20) * 12);
  if (!(P > 0) || !(t >= 0) || !(n > 0)) return { error: 'loan_amount (MXN) is required; interest_rate (% a year) and term_years are optional.' };
  const r = t / 1200, p = r === 0 ? P / n : P * r * (1 + r) ** n / ((1 + r) ** n - 1);
  return { loan_amount: P, interest_rate: t, rate_used: a.interest_rate == null ? `Banco de México average of advertised fixed-rate mortgage offers, ${H.mois} (${H.hypothese})` : 'rate given',
    term_months: n, monthly_payment: Math.round(p), total_interest: Math.round(p * n - P), formula: 'payment = P × r × (1 + r)^n ÷ ((1 + r)^n − 1), r = annual rate ÷ 12 ÷ 100',
    average_cat: `${H.cat}% (total annual cost with fees and insurance, same offers)`, banxico_target_rate: `${MX.loans.banxico.taux}% since ${MX.loans.banxico.depuis}`,
    page: mcpSrc(`${SITE_MX}/mortgage-calculator`), attribution: ATTRIBUTION_MX };
}

// ---------------------------------------------------------------- prix
function homePricesMx(a = {}) {
  const S = MX.prices.shf, n = norm(a.place);
  const base = { national: { median_appraisal: S.national.mediane, mean_appraisal: S.national.moyen, index_change_12m_pct: S.indiceNational.variation },
    measure: `${S.mesurePrix}; index: ${S.mesureIndice}`, source: S.source, source_url: S.url, consulted: S.consulte, attribution: ATTRIBUTION_MX };
  if (!n) return { answer: `Appraisal values of homes bought with a mortgage rose ${S.indiceNational.variation}% over a year in Mexico (SHF, Q2 2026); national median MX$${S.national.mediane.toLocaleString('en-US')}.`, ...base, page: mcpSrc(`${SITE_MX}/cities`) };
  const e = MX.prices.states.find((x) => norm(x.name) === n || x.slug === n);
  if (e) return { state: e.name, appraisal: e.appraisal, index_change_12m_pct: e.index_change_12m_pct,
    answer: `In ${e.name}, homes bought with a mortgage were appraised at a median of ${mxn(e.appraisal.mediane)} (Jan.-June 2026); the SHF index changed by ${e.index_change_12m_pct}% over a year.`, ...base, page: mcpSrc(e.url) };
  const m = MUNS.find((x) => x.slug === trouverMun(a.place));
  if (m) { const st = MX.prices.states.find((x) => x.code === m.code);
    return { municipality: m.name, state: m.state, index_change_12m_pct: m.index_change_12m_pct, state_median_appraisal: st.appraisal.mediane,
      answer: m.index_change_12m_pct != null ? `In ${m.name}, the SHF index changed by ${m.index_change_12m_pct}% over a year; prices in pesos exist by state only (${st.name}: median ${mxn(st.appraisal.mediane)}).` : `${m.name} has no SHF index of its own; ${st.name}: median appraisal ${mxn(st.appraisal.mediane)}, index ${st.index_change_12m_pct}% over a year.`,
      ...base, page: mcpSrc(m.url) }; }
  return { error: `Place "${a.place}" not covered. Give a Mexican state or one of the municipalities of payotte.com/mexico/cities.`, ...base };
}

// ---------------------------------------------------------------- tableaux, guides, métiers
const NOM_ETAT = Object.fromEntries(MX.prices.states.map((s) => [s.code, s.name]));
function compareStatesMx(a = {}) {
  const t = MX.tables[norm(a.topic)];
  if (!t) return { error: `Unknown topic "${a.topic ?? ''}". Topics: ${Object.keys(MX.tables).join(', ')}.`, all_tables: mcpSrc(`${SITE_MX}/by-state`) };
  const states = Object.fromEntries(Object.entries(t.states).map(([k, l]) => [NOM_ETAT[k] ?? k, { answer: l.answer, details: Object.fromEntries(Object.entries(l).filter(([c]) => !['answer', 'sources'].includes(c))), sources: l.sources }]));
  return { topic: norm(a.topic), compiled: t.compiled, licence: t.licence, states, table: mcpSrc(t.url), attribution: ATTRIBUTION_MX };
}
function guideMx(a = {}) {
  const mots = norm(a.query).split('-').filter((m) => m.length > 2);
  if (!mots.length) return { error: 'query is required, e.g. "fideicomiso", "selling as a non-resident", "restricted zone".' };
  const score = (g) => mots.reduce((s, m) => s + (norm(g.title).includes(m) ? 3 : 0) + (norm(g.description).includes(m) ? 1 : 0) + (g.slug.includes(m) ? 2 : 0), 0);
  const res = MX.guides.map((g) => ({ g, s: score(g) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 3);
  if (!res.length) return { results: [], note: 'No Payotte Mexico guide matches; see the list of guides.', all_guides: mcpSrc(`${SITE_MX}/guides`) };
  return { results: res.map(({ g }) => ({ title: g.title, answer: g.answer, checked: g.checked, url: mcpSrc(g.url) })), attribution: ATTRIBUTION_MX };
}
const METIERS = { 'real-estate-agent': 'real-estate-agent', agent: 'real-estate-agent', realtor: 'real-estate-agent', broker: 'real-estate-agent', 'asesor-inmobiliario': 'real-estate-agent',
  appraiser: 'appraiser', valuer: 'appraiser', 'perito-valuador': 'appraiser', 'mortgage-lender': 'mortgage-lender', lender: 'mortgage-lender', bank: 'mortgage-lender', sofom: 'mortgage-lender',
  notary: 'notary', notario: 'notary', 'notario-publico': 'notary', lawyer: 'real-estate-lawyer', attorney: 'real-estate-lawyer', abogado: 'real-estate-lawyer', 'real-estate-lawyer': 'real-estate-lawyer' };
function checkProfessionalMx(a = {}) {
  const s = METIERS[norm(a.trade)], p = s && MX.professions.find((x) => x.slug === s);
  if (!p) return { error: `Unknown trade "${a.trade ?? ''}". Trades: real estate agent, appraiser, mortgage lender, notary, real estate lawyer.` };
  return { trade: s, answer: p.answer, page: mcpSrc(p.url), checked: p.checked,
    note: s === 'notary' || s === 'real-estate-lawyer' ? 'Payotte lists no notary or lawyer in Mexico (their advertising is restricted). The page says where YOU check an appointment or a professional licence.' : 'Payotte lists no Mexican professional yet. The page names the register where YOU check a registration; Payotte never queries registers in series.', attribution: ATTRIBUTION_MX };
}

// ---------------------------------------------------------------- déclarations
const LECTURE_SEULE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const TOOLS_MX = [
  { name: 'closing_costs_mx', title: 'Mexican property acquisition tax and recording fee, by municipality',
    description: `MEXICO. Computes the property acquisition tax (ISAI, ISABI, ISTD… set by each municipality or state) and the state's fee to record the deed on a home purchase, from the 2026 laws read, in ${Object.keys(MUN).length} municipalities (Cancún, Playa del Carmen, Tulum, Puerto Vallarta, Bahía de Banderas, Los Cabos, La Paz, Mazatlán, San Miguel de Allende, Mérida, Guadalajara, Querétaro, Tijuana…). Base = the higher of the price and the appraisal or cadastral value. Others return "not computed" with no figure. Notary fees are not computed.`,
    inputSchema: { type: 'object', properties: { price: { type: 'number', description: 'Price in Mexican pesos (MX$3 million = 3000000).' },
      municipality: { type: 'string', description: 'Municipality or locality, e.g. "Cancún", "Nuevo Vallarta", "Cabo San Lucas", "San Miguel de Allende".' },
      appraisal_or_cadastral_value: { type: 'number', description: 'Appraisal or cadastral value in MXN, if higher than the price.' } }, required: ['price', 'municipality'] } },
  { name: 'mortgage_payment_mx', title: 'Mexican fixed-rate mortgage payment',
    description: 'MEXICO. Monthly payment and total interest of a fixed-rate peso mortgage; default rate = Banco de México average of advertised fixed-rate offers (latest month), with the average CAT and the Banxico target rate.',
    inputSchema: { type: 'object', properties: { loan_amount: { type: 'number', description: 'Loan in MXN.' }, interest_rate: { type: 'number', description: '% a year (optional).' }, term_years: { type: 'number', description: 'Years (default 20).' } }, required: ['loan_amount'] } },
  { name: 'home_prices_mx', title: 'Mexican home appraisal values and price index (SHF)',
    description: 'MEXICO. Sociedad Hipotecaria Federal figures: median and mean appraisal value of homes bought with a mortgage by state (Jan.-June 2026), and the price index change over a year by state or municipality. Prices in pesos exist by state only.',
    inputSchema: { type: 'object', properties: { place: { type: 'string', description: 'A Mexican state or municipality, e.g. "Quintana Roo", "Mérida". Empty = national.' } } } },
  { name: 'compare_states_mx', title: 'Mexican property rules and figures compared across the states',
    description: 'MEXICO. One rule or figure compared across the states: acquisition-tax, recording-fee, home-prices, price-change, home-loans, rented-homes, agent-licensing.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: Object.keys(MX.tables), description: 'Topic of the table.' } }, required: ['topic'] } },
  { name: 'guide_mx', title: 'Payotte Mexico guides: foreign buyers, buying, selling, renting',
    description: 'MEXICO. Finds the Payotte guide answering a question about buying (restricted zone, fideicomiso, notary, deed), financing, selling (income tax for residents and non-residents), renting or owning a home in Mexico, and returns its self-contained short answer, check date and URL.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The question or keywords, e.g. "fideicomiso permit cost", "selling as a non-resident".' } }, required: ['query'] } },
  { name: 'check_professional_mx', title: 'Who regulates a Mexican property professional, and where to check one',
    description: 'MEXICO. For a real estate agent (state licence where one exists), appraiser (SHF register), mortgage lender (CNBV, CONDUSEF), notary (appointed by the state) or real estate lawyer (cédula profesional): where the reader checks. Payotte lists no Mexican professional yet and never lists notaries or lawyers.',
    inputSchema: { type: 'object', properties: { trade: { type: 'string', description: 'real estate agent, appraiser, mortgage lender, notary or real estate lawyer.' } }, required: ['trade'] } },
];
export const IMPL_MX = { closing_costs_mx: closingCostsMx, mortgage_payment_mx: mortgagePaymentMx, home_prices_mx: homePricesMx, compare_states_mx: compareStatesMx, guide_mx: guideMx, check_professional_mx: checkProfessionalMx };
export const ANNOTATIONS_MX = Object.fromEntries(Object.keys(IMPL_MX).map((k) => [k, LECTURE_SEULE]));
export const INSTRUCTIONS_MX =
  ' MEXICO (payotte.com/mexico): tools ending in _mx — closing_costs_mx computes the property acquisition tax and the recording fee from the 2026 laws read (others: not computed, never estimate them), ' +
  'mortgage_payment_mx gives the payment at the Banco de México average offer, home_prices_mx gives SHF appraisal values by state and index changes, compare_states_mx compares one rule across the states, ' +
  'guide_mx finds the guide answering a question (foreign buyers, fideicomiso, restricted zone included), check_professional_mx says where to check a professional (no notary or lawyer is ever listed). Amounts in MXN; cite the page URL returned; general information, not advice.';
