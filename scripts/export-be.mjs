// export-be.mjs — données des outils MCP Belgique (src/be.js), tirées de la même source que le site payotte-astro (branche main) :
// frais d'achat des 3 Régions (src/data/be/frais-achat.json), prix Statbel des communes (prix-communes.json, prix-gemeenten-vl.json),
// front matter et « En bref / In het kort / In short » des guides et pages métier FR, NL et EN. Rien n'est recopié à la main.
// À relancer après toute correction du site. Le script vit ici (et non dans payotte-astro) pour ne rien ajouter à la branche main du site.
// Usage : node scripts/export-be.mjs [racine-du-site] [sortie]
//   défauts : ~/Payotte/payotte-astro  et  src/data/be.json de ce dépôt
import fs from 'node:fs'; import path from 'node:path';
const HOME = process.env.HOME;
const R = process.argv[2] ?? `${HOME}/Payotte/payotte-astro`;
const ICI = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SORTIE = process.argv[3] ?? path.join(ICI, 'src/data/be.json');
const SITE = 'https://payotte.com';
const lire = (f) => JSON.parse(fs.readFileSync(path.join(R, f), 'utf8'));
const plat = (t) => t.replace(/\\\*/g, '\u0000').replace(/\*+([^*\n]+?)\*+/g, '$1').replace(/\*/g, '').replace(/\u0000/g, '*').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
const TITRES_BREF = /\n## (?:En bref|In het kort|In short)\s*\n/;
function md(f, base) {
  const t = fs.readFileSync(f, 'utf8'); const m = t.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const champ = (k) => { const r = m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm')); return r ? r[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"') : null; };
  const court = (('\n' + m[2]).split(TITRES_BREF)[1] ?? '').split(/\n## /)[0].trim().split(/\n\s*\n/)[0] ?? '';
  const s = champ('slug');
  return { slug: s, title: champ('titre'), description: champ('description'), answer: plat(court), checked: champ('date_verification'), url: `${SITE}${base}/${s}`,
    fr: champ('equivalent_fr'), draft: Number(champ('aSourcer') ?? 0) > 0 };
}
const dossier = (d, base) => fs.readdirSync(path.join(R, d)).filter((f) => f.endsWith('.md')).sort().map((f) => md(path.join(R, d, f), base)).filter((g) => !g.draft && g.answer);

// Prix : on garde les 11 dernières années (la page en montre dix) et les 4 derniers trimestres.
const bloc = (b) => (b ? { n: b.n, med: b.med, q1: b.q1, q3: b.q3 } : null);
const annees = (a, dern) => Object.fromEntries(Object.keys(a).sort().filter((y) => Number(y) > Number(dern) - 11)
  .map((y) => [y, { houses: bloc(a[y].maisons), apartments: bloc(a[y].appartements) }]));
const zone = (z, url, extra = {}) => ({ name: z.nom, slug: z.slug, url, ...extra });
function prix(f, dern, urlCommune, urlProvince, urlRegions) {
  const P = lire(f);
  return { source: P.source, source_url: P.url, licence: P.licence, generated: P.genere, last_year: P.derniereAnnee, last_quarters: P.derniersTrimestres, threshold: P.seuil,
    regions: Object.entries(P.regions).map(([k, a]) => ({ region: k, years: annees(a, P.derniereAnnee), url: urlRegions[k] })),
    provinces: P.provinces.map((p) => ({ ...zone(p, urlProvince(p)), years: annees(p.annees, P.derniereAnnee) })),
    communes: P.communes.map((c) => ({ ...zone(c, urlCommune(c)), region: c.region, province: c.province, sales_last_4_quarters: c.ventes4T, years: annees(c.annees, P.derniereAnnee),
      quarters: (c.trimestres ?? []).filter((t) => P.derniersTrimestres.includes(t.periode)).map((t) => ({ period: t.periode, houses: bloc(t.maisons), apartments: bloc(t.appartements) })) })) };
}
const W = prix('src/data/be/prix-communes.json', null, (c) => `${SITE}/belgique/${c.slug}`, (p) => `${SITE}/belgique/province/${p.slug}`,
  { bruxelles: `${SITE}/belgique/region/bruxelles-capitale`, wallonie: `${SITE}/belgique/region/wallonie` });
const V = prix('src/data/be/prix-gemeenten-vl.json', null, (c) => `${SITE}/belgie/${c.slug}`, (p) => `${SITE}/belgie/provincie/${p.slug.replace(/^provincie-/, '')}`,
  { flandre: `${SITE}/belgie/regio/vlaanderen` });
// Pages anglaises : les 19 communes bruxelloises + Waterloo (src/lib/be/communesEn.ts) ; la Région de Bruxelles-Capitale en anglais.
const ANGLAIS = new Set([...W.communes.filter((c) => c.region === 'bruxelles').map((c) => c.slug), 'waterloo']);
for (const c of W.communes) if (ANGLAIS.has(c.slug)) c.url_en = `${SITE}/belgium/${c.slug}`;
W.regions.find((r) => r.region === 'bruxelles').url_en = `${SITE}/belgium/region/brussels-capital`;

const frais = lire('src/data/be/frais-achat.json');
const out = {
  _note: 'Généré par scripts/export-be.mjs (depuis payotte-astro, branche main) ; ne pas modifier à la main.',
  generated: new Date().toISOString().slice(0, 10),
  costs: frais,
  prices: { wallonia_brussels: W, flanders: V },
  pages: { costs: { fr: `${SITE}/belgique/frais-achat`, nl: `${SITE}/belgie/aankoopkosten`, en: `${SITE}/belgium/purchase-costs` },
    capacity: { fr: `${SITE}/belgique/capacite-emprunt`, nl: `${SITE}/belgie/leencapaciteit`, en: `${SITE}/belgium/borrowing-capacity` },
    home: { fr: `${SITE}/belgique`, nl: `${SITE}/belgie`, en: `${SITE}/belgium` } },
  guides: { fr: dossier('src/content/be-guides', '/belgique/guides'), nl: dossier('src/content/be-guides-nl', '/belgie/gidsen'), en: dossier('src/content/be-guides-en', '/belgium/guides') },
  professions: { regulators: lire('src/data/be/metiers.json').metiers,
    fr: dossier('src/content/be-metiers', '/belgique/metiers'), nl: dossier('src/content/be-metiers-nl', '/belgie/beroepen'), en: dossier('src/content/be-metiers-en', '/belgium/professions') },
};
fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
fs.writeFileSync(SORTIE, JSON.stringify(out) + '\n');
const g = out.guides, p = out.professions;
console.log(`✓ ${SORTIE} (${(fs.statSync(SORTIE).size / 1024).toFixed(0)} Ko) : guides ${g.fr.length} FR / ${g.nl.length} NL / ${g.en.length} EN, métiers ${p.fr.length}/${p.nl.length}/${p.en.length}, communes ${W.communes.length + V.communes.length}`);
