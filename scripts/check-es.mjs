// check-es.mjs — les outils MCP Espagne (src/es.js) contre des cas déjà contrôlés sur le site (payotte-astro-espagne/scripts/es/
// check-frais-achat.mjs, recalculés à la main depuis les textes). Sortie 1 si un montant dérive. Usage : node scripts/check-es.mjs
import { IMPL_ES } from '../src/es.js';
const pc = (price, region, o = {}) => IMPL_ES.purchase_costs_es({ price, region, ...o });
const cas = [
  ['Andalousie 300 000', pc(300000, 'Andalusia').buyer_total, 21201.14], ['Marbella → Andalousie', pc(300000, 'Marbella').region, 'Andalusia'],
  ['Catalogne 700 000 ITP', pc(700000, 'Cataluña').line_items[0].amount, 71000], ['Madrid neuf 150 000', pc(150000, 'madrid', { new_home: true }).buyer_total, 15910.43],
  ['Canaries neuf 200 000 IGIC', pc(200000, 'Canarias', { new_home: true }).line_items[0].amount, 14000], ['Pays basque 300 000', pc(300000, 'Bilbao', { reference_value: 400000 }).line_items[0].amount, 12000],
  ['Ceuta neuf minimum', pc(200000, 'Ceuta', { new_home: true }).total_is_lower_limit, true], ['Notaire 250 000', pc(250000, 'murcia').notary_deed_fee, 364.26],
  ['IRNR 100 000 hors UE', IMPL_ES.non_resident_tax_es({ cadastral_value: 100000 }).tax, 480], ['IRNR UE', IMPL_ES.non_resident_tax_es({ cadastral_value: 100000, eu_eea_resident: true }).tax, 380],
  ['Prêt 200 000 25 ans 3,134 %', Math.round(IMPL_ES.mortgage_payment_es({ loan_amount: 200000 }).monthly_payment), 962],
  ['Prix Marbella', IMPL_ES.house_prices_es({ place: 'Marbella' }).appraised_value_eur_m2, 4528.3],
  ['Avocat non listé', IMPL_ES.check_professional_es({ trade: 'abogado' }).trade, 'property-lawyer'],
  ['Guide NIE trouvé', IMPL_ES.guide_es({ query: 'NIE number' }).results.length > 0, true],
  ['Tableau young-buyer-rates', Object.keys(IMPL_ES.compare_regions_es({ topic: 'young-buyer-rates' }).regions).length, 19],
];
let ko = 0;
for (const [n, got, att] of cas) { if (got !== att) { ko++; console.log(`✗ ${n} : attendu ${att}, obtenu ${got}`); } else console.log(`✓ ${n}`); }
if (ko) { console.log(`\n✗ ${ko} écart(s).`); process.exit(1); }
console.log(`\n✓ ${cas.length} cas conformes.`);
