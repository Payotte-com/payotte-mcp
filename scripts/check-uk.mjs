// check-uk.mjs — les outils MCP Royaume-Uni (src/uk.js) contre les exemples officiels déjà contrôlés sur le site
// (payotte-astro-uk/scripts/uk/check-frais-achat.mjs). Sortie 1 si un montant dérive. Usage : node scripts/check-uk.mjs
import { taxeAchat, IMPL_UK, TOOLS_UK } from '../src/uk.js';
const cas = [[295000, 'england', 'mover', false, 4750], [500000, 'england', 'first-time', false, 10000], [300000, 'england', 'additional', false, 20000],
  [500001, 'england', 'first-time', false, 15000.05], [300000, 'england', 'mover', true, 11000], [295000, 'northern-ireland', 'mover', false, 4750],
  [235000, 'scotland', 'mover', false, 1800], [875000, 'scotland', 'mover', false, 63350], [250000, 'scotland', 'first-time', false, 1500],
  [250000, 'scotland', 'additional', false, 22100], [280000, 'wales', 'mover', false, 3300], [300000, 'wales', 'additional', false, 19950], [300000, 'wales', 'first-time', false, 4500]];
let ko = 0;
for (const [p, n, s, nr, att] of cas) { const o = taxeAchat(p, n, s, nr).taxe; if (Math.abs(o - att) > 0.01) { ko++; console.log(`✗ ${p} ${n} ${s}${nr ? ' non-résident' : ''} → ${o} (attendu ${att})`); } }
for (const t of TOOLS_UK) if (!IMPL_UK[t.name]) { ko++; console.log(`✗ outil sans implémentation : ${t.name}`); }
const r = IMPL_UK.purchase_tax_uk({ price: 300000, nation: 'Scotland', situation: 'first-time' }); if (!r.answer?.includes('£4,000')) { ko++; console.log('✗ purchase_tax_uk', r); }
const h = IMPL_UK.house_prices_uk({ area: 'Leeds' }); if (!h.average_price) { ko++; console.log('✗ house_prices_uk', h); }
const g = IMPL_UK.guide_uk({ query: 'Home Report' }); if (!g.results?.length) { ko++; console.log('✗ guide_uk', g); }
const c = IMPL_UK.check_professional_uk({ trade: 'solicitor' }); if (!c.page) { ko++; console.log('✗ check_professional_uk', c); }
if (ko) { console.log(`\n✗ ${ko} écart(s).`); process.exit(1); }
console.log(`✓ ${cas.length} cas de taxe conformes, ${TOOLS_UK.length} outils _uk branchés.`); console.log(JSON.stringify(r.answer)); console.log(JSON.stringify(h.answer));
