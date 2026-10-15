// check-be.mjs — les outils MCP Belgique (src/be.js) contre des cas calculés À PART (chiffres écrits ici à la main, depuis les textes),
// puis, si le site est présent, contre le module du site compilé à la volée (src/lib/be/fraisAchat.ts et capacite.ts, via esbuild).
// Sortie 1 au moindre écart de plus d'un centime. Usage : node scripts/check-be.mjs [racine-du-site]  (défaut ~/Payotte/payotte-astro)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fraisAchat, droitsEnregistrement, honoraires, fraisCredit, mensualite, capitalPour, prixMax, IMPL_BE, TOOLS_BE } from '../src/be.js';
const SITE = process.argv[2] ?? `${process.env.HOME}/Payotte/payotte-astro`;
let ko = 0; const ok = (l, c, d = '') => { if (!c) { ko++; console.log(`✗ ${l} ${d}`); } else console.log(`✓ ${l}`); };
const c2 = (n) => Math.round(n * 100) / 100;

// 1. Trois cas à 300 000 €, sole home : tout recalculé ici, sans lire la logique testée.
const JbisProp300 = 187.5 + 250 + 250 + 232.425 + 92.975 + 186005 * 0.00485 + 49905 * 0.003;   // barème Jbis, 7 tranches, puis 0,3 % au-delà
const hon = c2(257 + JbisProp300), tva = c2((hon + 855) * 0.21);
const autres = (ecriture) => c2(304 + 285 + ecriture + (304 + 100) * 0.21);
const attendu = { bruxelles: c2(12500 + hon + 855 + tva + autres(200)), wallonie: c2(9000 + hon + 855 + tva + autres(200)), flandre: c2(6000 + hon + 855 + tva + autres(100)) };
for (const [r, nom] of [['bruxelles', 'Brussels-Capital'], ['wallonie', 'Wallonia'], ['flandre', 'Flanders']]) {
  const o = IMPL_BE.purchase_costs_be({ price: 300000, region: nom });
  ok(`300 000 € ${nom} : ${o.total_purchase_costs} (attendu ${attendu[r]})`, Math.abs(o.total_purchase_costs - attendu[r]) < 0.015, JSON.stringify(o).slice(0, 200));
}
ok('arrondis du conseil : 17 218 / 13 718 / 10 618', [attendu.bruxelles, attendu.wallonie, attendu.flandre].map(Math.round).join('/') === '17218/13718/10618');

// 2. Droits d'enregistrement : cas du contrôle du site (check-frais-achat.mjs)
for (const [l, o, a] of [['Bruxelles 300 000 HPU', droitsEnregistrement(300000, 'bruxelles', true), 12500], ['Bruxelles 600 000 HPU', droitsEnregistrement(600000, 'bruxelles', true), 50000],
  ['Bruxelles 600 001 HPU', droitsEnregistrement(600001, 'bruxelles', true), 75000.13], ['Bruxelles 300 000 sans HPU', droitsEnregistrement(300000, 'bruxelles', false), 37500],
  ['Wallonie 300 000 HPU', droitsEnregistrement(300000, 'wallonie', true), 9000], ['Wallonie 250 000 sans HPU', droitsEnregistrement(250000, 'wallonie', false), 31250],
  ['Flandre 300 000 HPU', droitsEnregistrement(300000, 'flandre', true), 6000], ['Flandre 200 000 HPU', droitsEnregistrement(200000, 'flandre', true), 2133],
  ['Flandre 230 000 HPU hors centre', droitsEnregistrement(230000, 'flandre', true), 4600], ['Flandre 230 000 HPU ville-centre', droitsEnregistrement(230000, 'flandre', true, true), 2733],
  ['Flandre 300 000 sans HPU', droitsEnregistrement(300000, 'flandre', false), 36000]]) ok(l, Math.abs(o - a) < 0.015, `${o} ≠ ${a}`);
ok('Honoraires Jbis 300 000 €', Math.abs(honoraires(300000, true) - hon) < 0.015);
const Gbis240 = 102.6 + 109.4 + 91.25 + 15495 * 0.00547 + 18595 * 0.00365 + 175910 * 0.00182;
const cr = fraisCredit(240000, true);
ok('Crédit 240 000 € : honoraires Gbis', Math.abs(cr.honoraires - c2(Gbis240)) < 0.015);
ok('Crédit 240 000 € : total', Math.abs(cr.total - c2(2640 + 792 + 270 + c2(Gbis240) + 627 + c2((c2(Gbis240) + 627) * 0.21) + 100)) < 0.015);

// 3. Capacité : échéancier mois par mois
for (const [cap, taux, ans] of [[250000, 3.5, 25], [180000, 2.9, 20], [100000, 0, 10]]) {
  const m = mensualite(cap, taux, ans); let reste = cap; for (let k = 0; k < ans * 12; k++) reste = reste * (1 + taux / 1200) - m;
  ok(`échéancier ${cap} € à ${taux} % sur ${ans} ans`, Math.abs(reste) < 0.01 && Math.abs(capitalPour(m, taux, ans) - cap) < 0.01);
}
ok('mensualité 250 000 € / 3,5 % / 25 ans = 1 251,56 €', Math.abs(mensualite(250000, 3.5, 25) - 1251.56) < 0.01);
for (const [b, r, h] of [[350000, 'bruxelles', true], [350000, 'wallonie', true], [350000, 'flandre', true], [500000, 'bruxelles', false]]) {
  const p = prixMax(b, r, h), t = (x) => x + fraisAchat(x, r, h).total;
  ok(`prix maximal ${r}${h ? ' HPU' : ''} budget ${b} → ${p}`, t(p) <= b && t(p + 1) > b);
}

// 4. Outils : tous branchés, chaque réponse cite une URL payotte.com et la licence
for (const t of TOOLS_BE) ok(`outil ${t.name} branché`, !!IMPL_BE[t.name]);
const rep = {
  purchase_costs_be: IMPL_BE.purchase_costs_be({ price: 300000, region: 'Flanders', loan_amount: 240000 }), borrowing_capacity_be: IMPL_BE.borrowing_capacity_be({ net_monthly_income: 4000, own_funds: 40000, region: 'Brussels-Capital' }),
  house_prices_be: IMPL_BE.house_prices_be({ area: 'Liège' }), compare_regions_be: IMPL_BE.compare_regions_be({ price: 300000 }),
  guide_be: IMPL_BE.guide_be({ query: 'registration duties' }), check_professional_be: IMPL_BE.check_professional_be({ trade: 'notary' }) };
for (const [n, r] of Object.entries(rep)) { const j = JSON.stringify(r); ok(`${n} : pas d'erreur, URL payotte.com, CC BY 4.0`, !r.error && /https:\/\/payotte\.com\/(belgium|belgique|belgie)/.test(j) && j.includes('CC BY 4.0'), j.slice(0, 160)); }
ok('check_professional_be ne nomme aucun cabinet (pas de fiche)', !/fiches|firm selected/.test(JSON.stringify(rep.check_professional_be)));
for (const [q, aire] of [['Gent', 'Gent'], ['Ixelles', 'Ixelles'], ['Brussels', 'Brussels-Capital Region'], ['Bruxelles', 'Bruxelles'], ['Wallonia', 'Wallonia'], ['Provincie Antwerpen', 'Provincie Antwerpen'], ['Namur', 'Namur']]) {
  const h = IMPL_BE.house_prices_be({ area: q }); ok(`house_prices_be(${q}) → ${h.area}`, h.area === aire, JSON.stringify(h).slice(0, 120));
}
ok('guide_be en néerlandais', IMPL_BE.guide_be({ query: 'huurwaarborg', language: 'nl' }).results?.[0]?.language === 'nl');
ok('guide_be en français', IMPL_BE.guide_be({ query: 'droits enregistrement', language: 'fr' }).results?.[0]?.language === 'fr');
for (const t of ['estate agent', 'makelaar', 'courtier', 'notaris', 'surveyor', 'PEB']) ok(`check_professional_be(${t})`, !IMPL_BE.check_professional_be({ trade: t }).error);
ok('région inconnue refusée', !!IMPL_BE.purchase_costs_be({ price: 300000, region: 'Mars' }).error);

// 5. Comparaison avec le site (si présent) : grille de prix × Régions × HPU × ville-centre, crédit et prix maximal
if (fs.existsSync(path.join(SITE, 'src/lib/be/fraisAchat.ts'))) {
  const { build } = createRequire(path.join(SITE, 'package.json'))('esbuild');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-be-'));
  for (const [src, out] of [['fraisAchat', 'fa'], ['capacite', 'cap']]) await build({ entryPoints: [path.join(SITE, `src/lib/be/${src}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile: path.join(tmp, `${out}.mjs`), logLevel: 'silent' });
  const FA = await import(path.join(tmp, 'fa.mjs')), CAP = await import(path.join(tmp, 'cap.mjs'));
  let n = 0, ecarts = 0;
  for (const prix of [80000, 150000, 199999, 220000, 240000, 250000, 300000, 450000, 599999, 600000, 600001, 750000, 1200000]) for (const r of ['bruxelles', 'wallonie', 'flandre']) for (const h of [true, false]) for (const c of [false, true]) {
    const a = FA.fraisAchat(prix, r, h, c), b = fraisAchat(prix, r, h, c); n++;
    for (const k of Object.keys(a)) if (Math.abs(a[k] - b[k]) > 1e-9) { ecarts++; console.log(`✗ site ≠ MCP ${prix} ${r} hpu=${h} centre=${c} ${k}: ${a[k]} / ${b[k]}`); }
  }
  for (const cap of [100000, 240000, 300000, 450000]) for (const h of [true, false]) { const a = FA.fraisCredit(cap, h), b = fraisCredit(cap, h); n++; if (Math.abs(a.total - b.total) > 1e-9) { ecarts++; console.log(`✗ crédit ${cap} ${h}`); } }
  for (const bud of [200000, 350000, 500000, 900000]) for (const r of ['bruxelles', 'wallonie', 'flandre']) for (const h of [true, false]) { n++; if (CAP.prixMax(bud, r, h) !== prixMax(bud, r, h)) { ecarts++; console.log(`✗ prixMax ${bud} ${r} ${h}`); } }
  ok(`${n} cas identiques au module du site (${SITE})`, ecarts === 0);
} else console.log(`(site absent : ${SITE} — comparaison avec src/lib/be/*.ts sautée)`);
console.log(ko ? `\n✗ ${ko} écart(s).` : '\n✓ outils MCP Belgique conformes.');
process.exit(ko ? 1 : 0);
