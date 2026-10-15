// check-au.mjs — les outils MCP Australie (src/au.js) contre les exemples officiels déjà contrôlés sur le site
// (payotte-astro-australie/scripts/au/check-frais-achat.mjs). Sortie 1 si un montant dérive. Usage : node scripts/check-au.mjs
import { IMPL_AU, TOOLS_AU } from '../src/au.js';
const duty = (price, state, o = {}) => IMPL_AU.purchase_duty_au({ price, state, ...o });
const montant = (r, motif) => r.line_items?.find((l) => l.item.includes(motif))?.amount ?? 0;
const droit = (p, s, o) => duty(p, s, o).duty_due;
const avecSurtaxe = (p, s, o) => { const r = duty(p, s, o); return r.duty_due + montant(r, 'Foreign purchaser surcharge'); };
// [libellé, obtenu, attendu] — attendu issu des exemples officiels (VIC SRO, QLD QRO, WA RevenueWA, ACT DI2026-155) ou recalculé du barème
const cas = [
  ['VIC 500 000 $ : 25 070 $ (exemple officiel SRO)', droit(500000, 'VIC'), 25070],
  ['VIC 800 000 $ : 43 070 $ (exemple officiel SRO)', droit(800000, 'Victoria'), 43070],
  ['VIC 1 500 000 $ : 82 500 $ (exemple officiel SRO)', droit(1500000, 'vic'), 82500],
  ['VIC 2 500 000 $ : 142 500 $ (exemple officiel SRO)', droit(2500000, 'vic'), 142500],
  ['VIC 400 000 $, résidence principale : 16 370 $ (exemple officiel SRO)', droit(400000, 'vic', { principal_residence: true }), 16370],
  ['VIC 550 000 $, résidence principale : 24 970 $ (exemple officiel SRO)', droit(550000, 'vic', { principal_residence: true }), 24970],
  ['VIC 1 000 000 $, étranger : 55 000 + 80 000 (surtaxe 8 %, exemple officiel SRO)', avecSurtaxe(1000000, 'vic', { foreign_buyer: true }), 135000],
  ['VIC 600 000 $, premier acheteur : exonération', droit(600000, 'vic', { first_home_buyer: true }), 0],
  ['VIC 650 000 $, premier acheteur : borne haute = droit général 34 070 $', droit(650000, 'vic', { first_home_buyer: true }), 34070],
  ['QLD 850 000 $ : 31 275 $ (exemple officiel QRO)', droit(850000, 'qld'), 31275],
  ['QLD 950 000 $, home concession : 28 600 $ (exemple officiel QRO)', droit(950000, 'qld', { principal_residence: true }), 28600],
  ['QLD 795 000 $, premier achat : 19 890 $ (exemple officiel QRO)', droit(795000, 'qld', { first_home_buyer: true, principal_residence: true }), 19890],
  ['ACT 580 000 $, hors occupant : 14 856 $ (exemple officiel DI2026-155)', droit(580000, 'act'), 14856],
  ['ACT 580 000 $, Home Buyer Concession Scheme : taux nul', droit(580000, 'act', { first_home_buyer: true }), 0],
  ['WA 700 000 $, premier acheteur : 16 150 $', droit(700000, 'wa', { first_home_buyer: true }), 16150],
  ['WA 400 000 $, barème général (11 115 + 4,75 % × 40 000)', droit(400000, 'wa'), 11115 + 0.0475 * 40000],
  ['NSW 800 000 $, barème général (11 602 + 4,5 % × 413 000)', droit(800000, 'nsw'), 11602 + 0.045 * 413000],
  ['NSW 800 000 $, premier acheteur : exonération', droit(800000, 'nsw', { first_home_buyer: true }), 0],
  ['NSW 1 000 000 $, étranger : droit + 9 %', avecSurtaxe(1000000, 'nsw', { foreign_buyer: true }), 11602 + 0.045 * 613000 + 90000],
  ['TAS 500 000 $, premier acheteur : exonération expirée → 18 247,50 $', droit(500000, 'tas', { first_home_buyer: true }), 18247.5],
  ['NT 600 000 $ : 4,95 % = 29 700 $', droit(600000, 'nt'), 29700],
  ['NT 650 000 $, premier acheteur : 4,95 % − 18 601 $', droit(650000, 'nt', { first_home_buyer: true }), 0.0495 * 650000 - 18601],
  ['QLD 600 000 $, total avec enregistrement (17 325 + 4,5 % × 60 000 + 248,04 + 46,56 × 42)', duty(600000, 'qld').total_costs, 17325 + 0.045 * 60000 + 248.04 + 46.56 * 42],
  ['FIRB 900 000 $ existant (46 800 $) dans les lignes', montant(duty(900000, 'qld', { foreign_buyer: true }), 'FIRB'), 46800],
  ['FIRB 900 000 $ neuf (15 600 $) dans les lignes', montant(duty(900000, 'qld', { foreign_buyer: true, new_home: true }), 'FIRB'), 15600],
  ['SA 600 000 $ : non calculé, aucun montant', duty(600000, 'SA').duty_due, null],
  ['SA 600 000 $, premier achat neuf : droit nul', droit(600000, 'sa', { first_home_buyer: true, new_home: true }), 0],
];
let ko = 0;
for (const [l, o, a] of cas) {
  const ok = a === null ? o === null : typeof o === 'number' && Math.abs(o - a) <= 1;
  if (!ok) ko++;
  console.log(`${ok ? '✓' : '✗'} ${l} → ${o}${ok ? '' : ` (attendu ${a})`}`);
}
const sa = duty(600000, 'sa');
if (sa.computed !== false || sa.total_costs !== null || !/not computed, RevenueSA pages unreadable/i.test(sa.answer) || /%/.test(sa.answer)) { ko++; console.log('✗ SA doit répondre « not computed, RevenueSA pages unreadable » sans taux', sa.answer); }
else console.log('✓ SA : ' + sa.answer);
for (const t of TOOLS_AU) if (!IMPL_AU[t.name]) { ko++; console.log(`✗ outil sans implémentation : ${t.name}`); }
const h = IMPL_AU.house_prices_au({ area: 'Sydney' }); if (h.price_type !== 'median-established-house-transfers' || !h.price) { ko++; console.log('✗ house_prices_au Sydney', h); }
const hs = IMPL_AU.house_prices_au({ area: 'Victoria' }); if (hs.price_type !== 'mean-all-dwellings' || !hs.price) { ko++; console.log('✗ house_prices_au Victoria', hs); }
const c = IMPL_AU.compare_states_au({ topic: 'cooling-off-period' }); if (!c.states?.['New South Wales']) { ko++; console.log('✗ compare_states_au', c); }
const g = IMPL_AU.guide_au({ query: 'cooling-off period' }); if (!g.results?.length) { ko++; console.log('✗ guide_au', g); }
for (const t of ['real estate agent', 'mortgage broker', 'conveyancer', 'building inspector', 'property valuer']) { const p = IMPL_AU.check_professional_au({ trade: t }); if (!p.page) { ko++; console.log('✗ check_professional_au', t, p); } }
if (ko) { console.log(`\n✗ ${ko} écart(s).`); process.exit(1); }
console.log(`\n✓ ${cas.length} cas de droit conformes, ${TOOLS_AU.length} outils _au branchés.`);
console.log(JSON.stringify(duty(800000, 'vic').answer)); console.log(JSON.stringify(h.answer)); console.log(JSON.stringify(hs.answer));
