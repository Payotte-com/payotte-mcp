/**
 * dossierRevision.js — « Dossier de révision » d'évaluation foncière, à forfait (2026-09-28).
 *
 * ⛔ ÉTEINT PAR DÉFAUT. Rien ne se vend tant que `EF_DOSSIER_ACTIF = "1"` n'est pas posé ET que
 * les secrets Stripe n'existent pas. Deux portes du brief (docs/evaluation-fonciere/BRIEF-PRODUIT.md
 * du site) restent à franchir AVANT d'allumer :
 *   1. l'avis écrit d'un avocat en droit municipal sur le modèle (dossier préparé, signé et déposé
 *      par le propriétaire ; titre réservé d'évaluateur agréé ; TAQ) ;
 *   2. la politique de confidentialité : elle dit « 48 heures » pour les demandes de contact ;
 *      un dossier garde nom, adresse et réponses 30 jours → la page /privacy doit le dire avant.
 * En attendant, le propriétaire (Grégory) teste le parcours complet avec ?essai=<CONTACTS_TOKEN>.
 *
 * DÉCISION DU PROPRIÉTAIRE (28 sept. 2026) : « Le classement est gratuit, le reste peut être
 * vendable. […] Ça sera qu'un forfait par dossier. » Aucun référencement rémunéré : les renvois
 * vers les évaluateurs agréés sont gratuits.
 *
 * TROIS LIGNES QUI NE BOUGENT PAS (le risque juridique du produit tient dedans) :
 *   - Payotte ne donne AUCUNE opinion de valeur. La valeur écrite au formulaire est celle que le
 *     PROPRIÉTAIRE avance, « à titre indicatif », avec SES ventes comparables. Jamais « valeur
 *     recommandée », jamais « votre maison vaut ».
 *   - Le propriétaire signe et dépose lui-même. Payotte ne représente personne, ni devant
 *     l'évaluateur ni au TAQ.
 *   - Les cas faibles sont REFUSÉS avant paiement (taxes, voisin, délai passé), et les cas
 *     complexes (plex, 3 M$ et plus, non résidentiel) RENVOYÉS gratuitement à un évaluateur agréé.
 *
 * Aucune rédaction par IA : les motifs se composent à partir des réponses, mot pour mot.
 * Faits juridiques : docs/evaluation-fonciere/FAITS.md (LFM art. 129-138.5, 263.2), vérifiés le
 * 2026-09-28.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const FORMULAIRE_URL = 'https://cdn-contenu.quebec.ca/cdn-contenu/adm/min/affaires-municipales/publications/evaluation_fonciere/documentation/FOR_demande_revision_role_evaluation_fonciere.pdf';
const TTL_DOSSIER = 30 * 86400;
const MAX_MOTIFS_CHAMP = 850;   // au-delà, le champ renvoie à l'annexe ajoutée au PDF

// ─────────────────────────────────────────────────────────────── utilitaires
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = Number(String(v ?? '').replace(/[\s$ ]/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
const txt = (v, max = 1500) => String(v ?? '').trim().slice(0, max);
const money = (n) => `${Math.round(n).toLocaleString('fr-CA')} $`;
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const dateLongue = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d === 1 ? '1er' : d} ${MOIS[m - 1]} ${y}`; };
const addDays = (iso, n) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const aujourdHui = () => new Date().toISOString().slice(0, 10);

function page(title, body, { status = 200 } = {}) {
  const html = `<!doctype html><html lang="fr-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} · Payotte</title>
<style>
:root{--red:#C8102E;--ink:#211c1e;--ink2:#4f4749;--muted:#8a8284;--line:#e8e2e2;--bg:#f7f5f4;--card:#fff;--ok:#1f7a44}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;padding:0 16px}
.w{max-width:780px;margin:0 auto;padding:32px 0 64px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
header a{color:var(--ink);font-weight:700;text-decoration:none;font-size:20px}header span{color:var(--red);font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700}
h1{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:30px;line-height:1.15;margin:0 0 10px}
h2{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:21px;margin:28px 0 10px}
p,li{color:var(--ink2)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin:16px 0}
.flag{border-left:4px solid var(--red)}.ok{border-left:4px solid var(--ok)}
fieldset{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:16px 18px;margin:18px 0}
legend{font-weight:700;padding:0 6px}label{display:block;font-size:14px;font-weight:600;margin:10px 0 4px}
.h{font-weight:400;color:var(--muted);font-size:13px}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=date],select,textarea{width:100%;padding:9px 10px;border:1px solid #cfc7c8;border-radius:8px;font:inherit;background:#fff}
textarea{min-height:90px}.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.chk{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:8px 0}.chk input{margin-top:4px}
button,.btn{display:inline-block;background:var(--red);color:#fff;border:0;border-radius:9px;padding:12px 20px;font:700 15px system-ui,sans-serif;text-decoration:none;cursor:pointer}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left;vertical-align:top}
.mono{white-space:pre-wrap;background:#faf8f8;border:1px solid var(--line);border-radius:8px;padding:12px;font:14px/1.5 Georgia,serif;color:var(--ink)}
small,.muted{color:var(--muted)}a{color:var(--red)}
@media print{body{background:#fff}.noprint{display:none}.card,fieldset{break-inside:avoid}}
</style></head><body><div class="w"><header><a href="https://payotte.com">Payotte</a><span>Dossier de révision</span></header>${body}
<p class="muted" style="margin-top:40px;font-size:13px">Information générale basée sur des sources publiques. Ce n'est ni un avis juridique ni une évaluation agréée. Payotte ne donne aucune opinion de valeur et ne représente personne. Une demande de révision peut aussi entraîner une hausse de la valeur.</p>
</div></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' } });
}

const actif = (env) => env.EF_DOSSIER_ACTIF === '1' && Boolean(env.STRIPE_SECRET_KEY) && Boolean(env.STRIPE_WEBHOOK_SECRET);
const essaiOk = (env, v) => Boolean(env.CONTACTS_TOKEN) && typeof v === 'string' && v.length > 8 && v === env.CONTACTS_TOKEN;
const prixCents = (env) => { const n = Number(env.EF_PRIX_CENTS); return Number.isInteger(n) && n >= 1000 ? n : 9900; };

// ─────────────────────────────────────────────────────────────── 1. questionnaire
function formulaireHtml(env, url, erreurs = [], v = {}) {
  const essai = url.searchParams.get('essai') || v.essai || '';
  const enEssai = essaiOk(env, essai);
  const val = (k) => esc(v[k] ?? '');
  const coche = (k) => (v[k] ? ' checked' : '');
  const comp = (i) => `<div class="row">
      <div><label>Adresse de la vente ${i}</label><input type="text" name="c${i}_adresse" value="${val(`c${i}_adresse`)}"></div>
      <div><label>Date <span class="h">(AAAA-MM)</span></label><input type="text" name="c${i}_date" placeholder="2025-06" value="${val(`c${i}_date`)}"></div>
      <div><label>Prix de vente ($)</label><input type="number" name="c${i}_prix" min="0" step="1000" value="${val(`c${i}_prix`)}"></div>
    </div><label>En quoi elle ressemble à votre immeuble <span class="h">(type, taille, âge, secteur)</span></label><input type="text" name="c${i}_note" value="${val(`c${i}_note`)}">`;
  const bandeau = actif(env)
    ? `<div class="card ok"><strong>Forfait : ${money(prixCents(env) / 100)}</strong>, payé seulement si votre demande passe notre vérification. Les cas sans motif recevable ou trop complexes sont refusés avant tout paiement.</div>`
    : enEssai
      ? `<div class="card flag"><strong>Mode essai</strong> (propriétaire de Payotte) : le parcours est complet, sans paiement.</div>`
      : `<div class="card flag"><strong>Bientôt disponible.</strong> Le dossier de révision n'est pas encore offert. Vous pouvez remplir le questionnaire pour voir si votre demande serait recevable : rien n'est facturé ni conservé.</div>`;
  return page('Préparer votre demande de révision', `
<h1>Préparer votre demande de révision</h1>
<p>En 10 minutes, vous obtenez le <strong>formulaire officiel prérempli</strong>, vos motifs rédigés, votre date limite, les frais de dépôt et la liste des pièces à joindre. Vous signez et déposez vous-même.</p>
${bandeau}
${erreurs.length ? `<div class="card flag"><strong>À corriger :</strong><ul>${erreurs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form method="POST" action="/ef/dossier">
<input type="hidden" name="essai" value="${esc(enEssai ? essai : '')}">
<fieldset><legend>1. L'immeuble et l'avis</legend>
  <label>Municipalité où l'immeuble est situé</label><input type="text" name="municipalite" required value="${val('municipalite')}">
  <div class="row">
    <div><label>Numéro civique</label><input type="text" name="u_num" required value="${val('u_num')}"></div>
    <div><label>Rue</label><input type="text" name="u_rue" required value="${val('u_rue')}"></div>
    <div><label>App. <span class="h">(s'il y a lieu)</span></label><input type="text" name="u_app" value="${val('u_app')}"></div>
  </div>
  <label>Cadastre et numéro de lot <span class="h">(sur l'avis ou le certificat de localisation, facultatif)</span></label><input type="text" name="cadastre" value="${val('cadastre')}">
  <label>Vous contestez</label>
  <select name="situation">
    <option value="depot"${v.situation === 'modification' ? '' : ' selected'}>l'avis d'évaluation d'un rôle (nouveau rôle ou rôle en vigueur)</option>
    <option value="modification"${v.situation === 'modification' ? ' selected' : ''}>un avis de modification reçu en cours de rôle</option>
  </select>
  <div class="row">
    <div><label>Date d'envoi de l'avis</label><input type="date" name="date_avis" required value="${val('date_avis')}"></div>
    <div><label>N° de l'avis de modification <span class="h">(s'il y a lieu)</span></label><input type="text" name="no_modif" value="${val('no_modif')}"></div>
  </div>
  <div class="row">
    <div><label>Valeur du terrain ($)</label><input type="number" name="v_terrain" min="0" step="100" value="${val('v_terrain')}"></div>
    <div><label>Valeur du bâtiment ($)</label><input type="number" name="v_batiment" min="0" step="100" value="${val('v_batiment')}"></div>
    <div><label>Valeur de l'immeuble ($)</label><input type="number" name="v_total" min="0" step="100" required value="${val('v_total')}"></div>
  </div>
  <label>Type d'immeuble</label>
  <select name="type">
    <option value="unifamiliale"${v.type === 'unifamiliale' ? ' selected' : ''}>Maison unifamiliale</option>
    <option value="copropriete"${v.type === 'copropriete' ? ' selected' : ''}>Copropriété (condo)</option>
    <option value="plex"${v.type === 'plex' ? ' selected' : ''}>Plex ou immeuble à revenus (2 logements ou plus)</option>
    <option value="autre"${v.type === 'autre' ? ' selected' : ''}>Commercial, terrain vacant, agricole ou autre</option>
  </select>
</fieldset>

<fieldset><legend>2. Les faits au rôle <span class="h">(comparez l'inscription au rôle avec vos documents)</span></legend>
  <table><tr><th></th><th>Inscrit au rôle</th><th>Selon vos documents</th></tr>
  <tr><td>Superficie du terrain (m²)</td><td><input type="number" name="i_terrain_role" step="0.1" value="${val('i_terrain_role')}"></td><td><input type="number" name="i_terrain_reel" step="0.1" value="${val('i_terrain_reel')}"></td></tr>
  <tr><td>Aire d'étages (m²)</td><td><input type="number" name="i_aire_role" step="0.1" value="${val('i_aire_role')}"></td><td><input type="number" name="i_aire_reel" step="0.1" value="${val('i_aire_reel')}"></td></tr>
  <tr><td>Nombre de logements</td><td><input type="number" name="i_log_role" step="1" value="${val('i_log_role')}"></td><td><input type="number" name="i_log_reel" step="1" value="${val('i_log_reel')}"></td></tr>
  <tr><td>Année de construction</td><td><input type="number" name="i_annee_role" step="1" value="${val('i_annee_role')}"></td><td><input type="number" name="i_annee_reel" step="1" value="${val('i_annee_reel')}"></td></tr>
  </table>
  <label>Document qui prouve les données réelles <span class="h">(ex. : certificat de localisation de 2019, plans)</span></label><input type="text" name="i_piece" value="${val('i_piece')}">
  <label>Autre erreur ou omission <span class="h">(sous-sol non fini inscrit comme fini, garage inexistant…)</span></label><textarea name="i_autre">${val('i_autre')}</textarea>
</fieldset>

<fieldset><legend>3. Défauts de l'immeuble</legend>
  <label>Défauts qui existaient déjà à la date de référence du rôle <span class="h">(fondation, toiture, infiltration, contamination, nuisance…)</span></label><textarea name="defauts">${val('defauts')}</textarea>
  <label>Pièces qui les documentent <span class="h">(rapport d'inspection, soumissions, photos datées)</span></label><input type="text" name="defauts_pieces" value="${val('defauts_pieces')}">
</fieldset>

<fieldset><legend>4. Ventes comparables <span class="h">(les vôtres : des immeubles semblables vendus près de la date de référence)</span></legend>
  ${comp(1)}${comp(2)}${comp(3)}
  <label>La valeur que vous avancez, à titre indicatif ($) <span class="h">(c'est VOTRE estimation ; Payotte n'en donne aucune)</span></label><input type="number" name="valeur_demandeur" min="0" step="1000" value="${val('valeur_demandeur')}">
</fieldset>

<fieldset><legend>5. D'autres raisons ?</legend>
  <label class="chk"><input type="checkbox" name="r_taxes" value="1"${coche('r_taxes')}> Mes taxes ont trop augmenté</label>
  <label class="chk"><input type="checkbox" name="r_voisin" value="1"${coche('r_voisin')}> Mon voisin est évalué moins cher</label>
  <label class="chk"><input type="checkbox" name="r_hausse" value="1"${coche('r_hausse')}> La hausse depuis le dernier rôle est trop forte</label>
</fieldset>

<fieldset><legend>6. Vous</legend>
  <div class="row">
    <div><label>Prénom</label><input type="text" name="d_prenom" required value="${val('d_prenom')}"></div>
    <div><label>Nom</label><input type="text" name="d_nom" required value="${val('d_nom')}"></div>
  </div>
  <label class="chk"><input type="checkbox" name="d_meme_adresse" value="1"${v.d_num ? '' : ' checked'}> J'habite l'immeuble visé</label>
  <div class="row">
    <div><label>N° civique <span class="h">(si différent)</span></label><input type="text" name="d_num" value="${val('d_num')}"></div>
    <div><label>Rue</label><input type="text" name="d_rue" value="${val('d_rue')}"></div>
    <div><label>App.</label><input type="text" name="d_app" value="${val('d_app')}"></div>
  </div>
  <div class="row">
    <div><label>Municipalité, province</label><input type="text" name="d_ville" value="${val('d_ville')}"></div>
    <div><label>Code postal</label><input type="text" name="d_cp" required value="${val('d_cp')}"></div>
  </div>
  <div class="row">
    <div><label>Téléphone de jour</label><input type="tel" name="d_tel" value="${val('d_tel')}"></div>
    <div><label>Courriel <span class="h">(pour recevoir le dossier)</span></label><input type="email" name="d_courriel" required value="${val('d_courriel')}"></div>
  </div>
</fieldset>

<fieldset><legend>7. Ce que vous acceptez</legend>
  <label class="chk"><input type="checkbox" name="ok_role" value="1" required${coche('ok_role')}> Je comprends que Payotte prépare un dossier à partir de <strong>mes</strong> réponses, sans donner d'opinion de valeur ni me représenter, et que je signe et dépose moi-même ma demande.</label>
  <label class="chk"><input type="checkbox" name="ok_hausse" value="1" required${coche('ok_hausse')}> Je comprends qu'une demande de révision peut mener à une baisse, à un maintien <strong>ou à une hausse</strong> de la valeur.</label>
  <label class="chk"><input type="checkbox" name="ok_donnees" value="1" required${coche('ok_donnees')}> J'accepte que mes réponses soient conservées 30 jours pour produire et me remettre le dossier (<a href="https://payotte.com/privacy">confidentialité</a>).</label>
</fieldset>
<button type="submit">Vérifier ma demande →</button>
</form>`);
}

// ─────────────────────────────────────────────────────────────── 2. lecture et tri
function lireReponses(fd) {
  const v = {};
  for (const [k, val] of fd.entries()) if (typeof val === 'string') v[k] = val.trim().slice(0, 2000);
  return v;
}

function ecarts(v) {
  const e = [];
  const pair = (role, reel, libelle, unite) => {
    const a = num(v[role]), b = num(v[reel]);
    if (a != null && b != null && Math.abs(a - b) > 0.0001) e.push({ libelle, role: a, reel: b, unite });
  };
  pair('i_terrain_role', 'i_terrain_reel', 'Superficie du terrain inscrite', 'm²');
  pair('i_aire_role', 'i_aire_reel', "Aire d'étages inscrite", 'm²');
  pair('i_log_role', 'i_log_reel', 'Nombre de logements inscrit', '');
  pair('i_annee_role', 'i_annee_reel', 'Année de construction inscrite', '');
  return e;
}
function comparables(v) {
  const c = [];
  for (const i of [1, 2, 3]) {
    const adresse = txt(v[`c${i}_adresse`], 200), prix = num(v[`c${i}_prix`]);
    if (adresse && prix) c.push({ adresse, date: txt(v[`c${i}_date`], 7), prix, note: txt(v[`c${i}_note`], 200) });
  }
  return c;
}

/** Échéance, calculée comme dans l'outil MCP fenetre_revision (LFM art. 130-132, 134). */
function echeance(v, m) {
  const avis = /^\d{4}-\d{2}-\d{2}$/.test(v.date_avis || '') ? v.date_avis : null;
  if (!avis) return { erreur: "La date d'envoi de l'avis est requise." };
  // L'avis d'un NOUVEAU rôle part entre le dépôt (15 août-1er nov.) et le 1er mars de sa 1re année.
  // Le calendrier ne connaît le nouveau rôle qu'après sa publication par le MAMH : on le déduit
  // de la date de l'avis.
  let debut = m.premierExercice;
  if (v.situation !== 'modification' && avis >= `${m.prochainRole - 1}-08-15`) debut = m.prochainRole;
  const general = `${debut}-04-30`;
  const finFevrier = `${debut}-02-${(debut % 4 === 0 && (debut % 100 !== 0 || debut % 400 === 0)) ? 29 : 28}`;
  let date = general, regle = `avant le 1er mai ${debut} (règle générale, LFM art. 130)`;
  if (v.situation === 'modification') {
    const j60 = addDays(avis, 60);
    if (j60 > date) { date = j60; regle = "60 jours après l'envoi de l'avis de modification (LFM art. 132)"; }
    else regle = "avant le 1er mai qui suit l'entrée en vigueur du rôle, plus tardif que les 60 jours après l'avis (LFM art. 132)";
  } else if (avis > finFevrier) {
    const j60 = addDays(avis, 60);
    if (j60 > date) { date = j60; regle = "60 jours après l'envoi de l'avis, expédié après la fin février (LFM art. 131)"; }
  }
  return { date, regle, roleDebut: debut, roleFin: debut + 2, reference: `${debut - 2}-07-01` };
}

function trier(v, m, ech, e, c) {
  const total = num(v.v_total);
  const renvois = [];
  if (v.type === 'plex' || v.type === 'autre' || (num(v.i_log_reel) ?? num(v.i_log_role) ?? 1) >= 2) renvois.push('un plex, un immeuble à revenus ou un immeuble non résidentiel');
  if (total != null && total >= 3000000) renvois.push('une valeur de 3 M$ ou plus (délai et enjeux particuliers)');
  if (renvois.length) return { verdict: 'renvoi', raisons: renvois };
  if (ech.date < aujourdHui()) return { verdict: 'refus', raisons: [`le délai général est passé depuis le ${dateLongue(ech.date)}`] };
  const fort = e.length > 0 || txt(v.i_autre).length >= 20 || txt(v.defauts).length >= 30 || c.length > 0;
  if (!fort) {
    const faibles = [v.r_taxes && 'le montant des taxes', v.r_voisin && "l'évaluation du voisin", v.r_hausse && 'la hausse par rapport au rôle précédent'].filter(Boolean);
    return { verdict: 'refus', raisons: [faibles.length ? `${faibles.join(', ')} ne sont pas des motifs recevables` : 'aucun motif recevable : ni erreur au rôle, ni défaut documenté, ni vente comparable'] };
  }
  return { verdict: 'ok', raisons: [] };
}

function frais(deps, m, total) {
  const cle = deps.strip(m.nom) === 'quebec' ? 'quebec' : deps.strip(m.nom);
  const f = deps.EF_FRAIS[cle];
  const i = deps.efPalier(total ?? 0);
  return f ? { montant: f.frais[i], source: f.source, note: f.note ?? null, plafond: deps.EF_TAQ_2026[i] }
    : { montant: null, plafond: deps.EF_TAQ_2026[i] };
}

// ─────────────────────────────────────────────────────────────── 3. rédaction (sans IA)
function rediger(d) {
  const { v, e, c, ech } = d;
  const blocs = [];
  if (e.length || txt(v.i_autre)) {
    const lignes = e.map((x) => `${x.libelle} au rôle : ${x.role.toLocaleString('fr-CA')}${x.unite ? ' ' + x.unite : ''} ; selon ${txt(v.i_piece) || 'les documents du demandeur'} : ${x.reel.toLocaleString('fr-CA')}${x.unite ? ' ' + x.unite : ''}.`);
    if (txt(v.i_autre)) lignes.push(txt(v.i_autre));
    blocs.push(`ERREURS OU OMISSIONS À L'INSCRIPTION\n${lignes.map((l) => '- ' + l).join('\n')}`);
  }
  if (txt(v.defauts)) {
    blocs.push(`DÉFECTUOSITÉS EXISTANT À LA DATE DE RÉFÉRENCE (${dateLongue(ech.reference)})\n- ${txt(v.defauts)}${txt(v.defauts_pieces) ? `\n- Pièces : ${txt(v.defauts_pieces)}.` : ''}`);
  }
  if (c.length) {
    blocs.push(`VENTES D'IMMEUBLES COMPARABLES (relevées par le demandeur)\n${c.map((x, i) => `${i + 1}) ${x.adresse}${x.date ? `, vendu en ${x.date}` : ''}, au prix de ${money(x.prix)}${x.note ? ` (${x.note})` : ''}.`).join('\n')}`);
  }
  const vd = num(v.valeur_demandeur);
  blocs.push(`Le demandeur demande la révision de l'inscription${vd ? ` et avance, à titre indicatif, une valeur réelle de ${money(vd)}` : ''}.`);
  const motifs = blocs.join('\n\n');
  const total = num(v.v_total);
  const nature = `Valeur inscrite au rôle${num(v.v_terrain) ? ` : terrain ${money(num(v.v_terrain))}` : ''}${num(v.v_batiment) ? `, bâtiment ${money(num(v.v_batiment))}` : ''}${total ? `, immeuble ${money(total)}` : ''}. Conclusion recherchée : ${e.length || txt(v.i_autre) ? "correction des données d'inventaire et " : ''}réduction de la valeur de l'immeuble${vd ? ` à ${money(vd)}, selon le demandeur` : ''}.`;
  const pieces = [
    txt(v.i_piece) && `Preuve des données réelles : ${txt(v.i_piece)}`,
    txt(v.defauts_pieces) && `Preuve des défauts : ${txt(v.defauts_pieces)}`,
    c.length && "Preuve des ventes comparables (fiche de vente, extrait du Registre foncier ou annonce datée), pour chaque vente citée",
    'Copie de votre avis d\'évaluation',
    'Paiement des frais de dépôt exigés par l\'organisme municipal',
  ].filter(Boolean);
  return { motifs, nature, pieces };
}

// ─────────────────────────────────────────────────────────────── 4. PDF prérempli
async function formulairePdf(d) {
  const res = await fetch(FORMULAIRE_URL, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) throw new Error(`formulaire officiel indisponible (HTTP ${res.status})`);
  const pdf = await PDFDocument.load(await res.arrayBuffer());
  const form = pdf.getForm();
  const { v, m, ech, r } = d;
  // Certains champs sont des « peignes » à longueur fixe (exercices : 12 cases, téléphone : 10,
  // code postal : 6). Un texte trop long faisait échouer setText EN SILENCE : on coupe à la
  // longueur permise, et un champ introuvable est journalisé au lieu d'être avalé.
  const set = (nom, val) => {
    if (!val) return;
    try {
      const f = form.getTextField(nom);
      const max = f.getMaxLength();
      f.setText(max ? String(val).slice(0, max) : String(val));
    } catch (err) { console.log(`[dossier] champ « ${nom} » : ${err.message}`); }
  };
  const choisir = (nom, prefixe) => {
    try {
      const g = form.getRadioGroup(nom);
      // Correspondance EXACTE d'abord : « Modification » et « Modification non effectuée »
      // commencent pareil, et le préfixe seul cochait la mauvaise case.
      const norm = (o) => o.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const opts = g.getOptions();
      const opt = opts.find((o) => norm(o) === prefixe) ?? opts.find((o) => norm(o).startsWith(prefixe));
      if (opt) g.select(opt);
    } catch { /* idem */ }
  };
  const cocher = (nom) => { try { form.getCheckBox(nom).check(); } catch { /* idem */ } };

  set('Exercices financiers auxquels sapplique le rôle', `${ech.roleDebut}${ech.roleDebut + 1}${ech.roleFin}`);
  set("Nom de la Municipalité locale au rôle de laquelle l'unité est inscrite", m.nom);
  set("Numéro de l'adresse de l'unité d'évaluation", v.u_num);
  set("Nom de la voie publique de l'adresse de l'unité d'évaluation", v.u_rue);
  set("Numéro d'appartement de l'adresse de l'unité d'évaluation", v.u_app);
  set('Cadastre et numéro de lot', v.cadastre);
  choisir('Demandeur', 'propri');
  choisir('Situation', v.situation === 'modification' ? 'modification' : 'd');
  set("Numéro de l'avis de modification", v.no_modif);
  set('Prénom du demandeur', v.d_prenom);
  set('Nom du demandeur', v.d_nom);
  const memeAdresse = v.d_meme_adresse === '1' || !v.d_num;
  set("Numéro de l'adresse du demandeur", memeAdresse ? v.u_num : v.d_num);
  set("Nom de la voie publique de l'adresse du demandeur", memeAdresse ? v.u_rue : v.d_rue);
  set("Numéro d'appartement de l'adresse du demandeur", memeAdresse ? v.u_app : v.d_app);
  set('Municipalité, province ou état, pays', memeAdresse ? `${m.nom}, Québec, Canada` : v.d_ville);
  set('Code postal', String(v.d_cp || '').replace(/\s+/g, '').toUpperCase());
  set('Téléphone de jour', String(v.d_tel || '').replace(/\D+/g, '').replace(/^1(?=\d{10}$)/, ''));
  set('Courriel', v.d_courriel);
  set('Nom du signataire', `${v.d_prenom} ${v.d_nom}`.trim());
  cocher('Valeur');
  if (d.e.length || txt(v.i_autre)) { cocher('Autre'); set('Si autre, veuillez préciser', "Correction des données d'inventaire"); }
  const vd = num(v.valeur_demandeur);
  if (vd) set('Valeur réelle selon le demandeur, à titre indicatif', money(vd));
  set("Nature de l'inscription visée et conclusion recherchée", r.nature);
  const annexe = r.motifs.length > MAX_MOTIFS_CHAMP;
  set('Motifs invoqués', annexe ? `${r.motifs.slice(0, MAX_MOTIFS_CHAMP - 60).replace(/\s+\S*$/, '')}… (suite à l'annexe jointe)` : r.motifs);

  if (annexe) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    let p = pdf.addPage([612, 792]);
    let y = 740;
    p.drawText('Annexe : motifs invoqués (texte complet)', { x: 54, y, size: 13, font: bold });
    y -= 24;
    const largeur = 504, taille = 10;
    for (const para of r.motifs.split('\n')) {
      const mots = para.split(' ');
      let ligne = '';
      const flush = () => {
        if (y < 60) { p = pdf.addPage([612, 792]); y = 740; }
        p.drawText(ligne, { x: 54, y, size: taille, font, color: rgb(0.13, 0.11, 0.12) });
        y -= 14; ligne = '';
      };
      for (const w of mots) {
        const essai = ligne ? `${ligne} ${w}` : w;
        if (font.widthOfTextAtSize(essai, taille) > largeur) flush(), ligne = w; else ligne = essai;
      }
      flush();
    }
  }
  return pdf.save();
}

// ─────────────────────────────────────────────────────────────── 5. pages
function pageRefus(tri, m, lienGuide) {
  return page('Demande non recevable', `
<h1>Votre demande ne devrait pas être retenue</h1>
<div class="card flag"><p>Nous ne préparerons pas ce dossier, et <strong>rien ne vous est facturé</strong>, parce que ${esc(tri.raisons.join(' ; '))}.</p></div>
<p>Une demande de révision doit s'appuyer sur une erreur au rôle, un défaut documenté ou des ventes comparables. Québec.ca le rappelle : le montant des taxes ne justifie pas une modification au rôle.</p>
<p><a class="btn" href="${lienGuide}">Lire le guide des preuves qui fonctionnent</a></p>
<p class="noprint"><a href="/ef/dossier">← Revenir au questionnaire</a></p>`);
}
function pageRenvoi(tri, m) {
  return page('Un évaluateur agréé est plus indiqué', `
<h1>Votre dossier mérite un évaluateur agréé</h1>
<div class="card flag"><p>Vous visez ${esc(tri.raisons.join(' et '))}. Pour ces cas, un dossier à forfait ne suffit pas : la preuve repose sur une analyse de valeur, et un recours au TAQ exige souvent un rapport d'expert.</p></div>
<p>Payotte ne facture rien et ne touche aucune commission pour ce renvoi.</p>
<p><a class="btn" href="https://payotte.com/appraiser">Trouver l'évaluateur agréé vérifié de mon secteur</a></p>
<p class="muted">Là où Payotte n'a encore personne : le répertoire de l'<a href="https://www.oeaq.qc.ca/">Ordre des évaluateurs agréés du Québec</a>.</p>`);
}

function pageDossier(d, token) {
  const { v, m, ech, fr: f, r } = d;
  const vd = num(v.valeur_demandeur);
  return page(`Dossier ${token.slice(0, 8)}`, `
<h1>Votre dossier de demande de révision</h1>
<p class="muted">Dossier ${esc(token.slice(0, 8))} · préparé le ${dateLongue(d.cree.slice(0, 10))} · ${esc(v.d_prenom)} ${esc(v.d_nom)} · ${esc(v.u_num)} ${esc(v.u_rue)}${v.u_app ? ', app. ' + esc(v.u_app) : ''}, ${esc(m.nom)}</p>

<div class="card flag"><h2 style="margin-top:0">1. Votre date limite : ${dateLongue(ech.date)}</h2>
<p>Délai calculé : ${esc(ech.regle)}. Rôle ${ech.roleDebut}-${ech.roleFin}, valeurs au ${dateLongue(ech.reference)}. <strong>Votre avis d'évaluation fait foi</strong> : si sa date limite diffère, suivez-la. Envoyée par poste recommandée, la demande est réputée déposée le jour de l'envoi (LFM art. 135).</p></div>

<h2>2. Le formulaire officiel, déjà rempli</h2>
<p><a class="btn noprint" href="/ef/dossier/${token}/formulaire.pdf">Télécharger le formulaire prérempli (PDF)</a></p>
<p>Relisez chaque champ, <strong>datez et signez</strong>. Le formulaire est celui du ministère des Affaires municipales. Il faut une demande par unité d'évaluation.</p>

<h2>3. Où et comment le déposer</h2>
<ul>
<li>À l'<strong>organisme municipal responsable de l'évaluation</strong> indiqué sur votre avis (la ville ou la MRC), en personne ou par poste recommandée.</li>
<li>Avec les <strong>frais de dépôt</strong> : ${f.montant != null ? `<strong>${money(f.montant)}</strong> pour votre palier de valeur (<a href="${esc(f.source)}">barème officiel</a>)${f.note ? ` <small>(${esc(f.note)})</small>` : ''}` : 'montant fixé par règlement de votre municipalité (Payotte ne l\'a pas encore relevé)'}. La loi les plafonne à ${money(f.plafond)} pour votre palier (tarif du TAQ 2026). Sans paiement, la demande est réputée non déposée.</li>
<li>Gardez une copie de tout ce que vous envoyez, et la preuve d'envoi.</li>
</ul>

<h2>4. Vos motifs, tels qu'inscrits au formulaire</h2>
<div class="mono">${esc(r.motifs)}</div>
<p class="muted">Ces motifs reprennent vos réponses, sans ajout. Ils ne constituent pas une opinion de valeur de Payotte${vd ? ` ; la valeur de ${money(vd)} est celle que vous avancez` : ''}.</p>

<h2>5. Les pièces à joindre</h2>
<ul>${r.pieces.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>

<h2>6. Et après ?</h2>
<ul>
<li>L'évaluateur répond par écrit au plus tard le <strong>1er septembre</strong> qui suit (report possible au 1er novembre, voire au 1er avril). Une visite est possible.</li>
<li>S'il propose une modification, vous avez <strong>30 jours</strong> pour conclure une entente écrite.</li>
<li>Sans entente : recours au <strong>TAQ</strong> dans les 60 jours de sa réponse, ou 30 jours après sa date limite s'il n'a pas répondu. Au TAQ, c'est à vous de prouver la valeur : un <a href="https://payotte.com/appraiser">évaluateur agréé</a> devient alors précieux.</li>
</ul>

<div class="card"><h2 style="margin-top:0">À savoir avant d'envoyer</h2>
<ul><li>La valeur peut aussi être <strong>haussée</strong> : l'évaluateur reconsidère l'ensemble du dossier (travaux sans permis, par exemple).</li>
<li>Payotte a préparé ce dossier à partir de vos réponses. Payotte n'est pas évaluateur agréé, ne donne aucune opinion de valeur et ne vous représente pas.</li></ul></div>
<p class="muted">Sources : Loi sur la fiscalité municipale, art. 129 à 138.5 et 263.2 ; <a href="https://www.quebec.ca/habitation-territoire/information-fonciere/evaluation-fonciere/demander-revision">Québec.ca</a> ; <a href="https://www.taq.gouv.qc.ca/">TAQ</a>. Guide complet : <a href="https://payotte.com/evaluation-fonciere/contester-evaluation-fonciere-quebec">payotte.com/evaluation-fonciere</a>.</p>
<p class="noprint"><button onclick="window.print()">Imprimer ce dossier</button></p>`);
}

// ─────────────────────────────────────────────────────────────── 6. Stripe
async function creerSessionStripe(env, token, courriel, origin) {
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'cad',
    'line_items[0][price_data][product_data][name]': "Dossier de demande de révision d'évaluation foncière",
    'line_items[0][price_data][unit_amount]': String(prixCents(env)),
    'line_items[0][quantity]': '1',
    success_url: `${origin}/ef/dossier/merci?t=${token}`,
    cancel_url: `${origin}/ef/dossier`,
    customer_email: courriel,
    client_reference_id: token,
    'metadata[token]': token,
    locale: 'fr-CA',
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json();
  if (!res.ok || !j.url) throw new Error(`Stripe : ${j?.error?.message ?? res.status}`);
  return j.url;
}

async function signatureStripeValide(env, payload, entete) {
  const parts = Object.fromEntries(String(entete || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;   // rejeu : 5 minutes
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${payload}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== parts.v1.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

async function envoyerLien(env, d, token, origin) {
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Payotte <relais@payotte.com>',
      to: [d.v.d_courriel],
      subject: 'Votre dossier de demande de révision est prêt',
      html: `<p>Bonjour ${esc(d.v.d_prenom)},</p><p>Votre dossier est prêt : formulaire officiel prérempli, motifs, date limite (<strong>${dateLongue(d.ech.date)}</strong>), frais et pièces à joindre.</p><p><a href="${origin}/ef/dossier/${token}">Ouvrir mon dossier</a></p><p>Le lien reste valide 30 jours. Relisez, signez et déposez avant la date limite.</p><p>Payotte</p>`,
    }),
  });
}

// ─────────────────────────────────────────────────────────────── 7. routeur
export async function handleDossierRevision(request, env, url, deps) {
  const origin = url.origin;
  const p = url.pathname;
  const guidePreuves = `${deps.SITE}/evaluation-fonciere/preuves-demande-revision`;

  if (request.method === 'GET' && p === '/ef/dossier') return formulaireHtml(env, url);

  if (request.method === 'POST' && p === '/ef/dossier') {
    const v = lireReponses(await request.formData());
    const erreurs = [];
    if (!num(v.v_total)) erreurs.push("La valeur de l'immeuble inscrite à l'avis est requise.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.d_courriel || '')) erreurs.push('Le courriel est invalide.');
    if (!(v.ok_role && v.ok_hausse && v.ok_donnees)) erreurs.push('Les trois cases de la section 7 sont requises.');
    let trouve = null;
    try { trouve = await deps.efMunicipalite(v.municipalite); } catch { trouve = { error: 'Calendrier indisponible, réessayez dans un instant.' } }
    if (trouve?.error) erreurs.push(trouve.error);
    if (erreurs.length) return formulaireHtml(env, url, erreurs, v);
    const m = trouve.m;
    const ech = echeance(v, m);
    if (ech.erreur) return formulaireHtml(env, url, [ech.erreur], v);
    const e = ecarts(v), c = comparables(v);
    const tri = trier(v, m, ech, e, c);
    if (tri.verdict === 'refus') return pageRefus(tri, m, guidePreuves);
    if (tri.verdict === 'renvoi') return pageRenvoi(tri, m);

    const enEssai = essaiOk(env, v.essai);
    if (!actif(env) && !enEssai) {
      // Éteint : on dit que la demande serait recevable, on ne garde RIEN.
      return page('Demande recevable', `<h1>Votre demande semble recevable</h1><div class="card ok"><p>Votre date limite serait le <strong>${dateLongue(ech.date)}</strong>. Le dossier de révision n'est pas encore offert : vos réponses n'ont pas été conservées.</p></div><p><a class="btn" href="${deps.SITE}/evaluation-fonciere/contester-evaluation-fonciere-quebec">Lire le guide complet pour déposer vous-même</a></p>`);
    }
    delete v.essai;
    const d = { v, m, ech, e, c, fr: frais(deps, m, num(v.v_total)), cree: new Date().toISOString(), paye: enEssai, essai: enEssai };
    d.r = rediger(d);
    const token = crypto.randomUUID();
    await env.COUNTERS.put(`efd:${token}`, JSON.stringify(d), { expirationTtl: TTL_DOSSIER });
    if (enEssai) return Response.redirect(`${origin}/ef/dossier/${token}`, 303);
    try {
      return Response.redirect(await creerSessionStripe(env, token, v.d_courriel, origin), 303);
    } catch (err) {
      console.log(`[dossier] ${err.message}`);
      return page('Paiement indisponible', '<h1>Le paiement est momentanément indisponible</h1><p>Réessayez dans quelques minutes. Rien ne vous a été facturé.</p>', { status: 502 });
    }
  }

  if (request.method === 'POST' && p === '/ef/stripe-webhook') {
    if (!env.STRIPE_WEBHOOK_SECRET) return new Response('off', { status: 404 });
    const payload = await request.text();
    if (!(await signatureStripeValide(env, payload, request.headers.get('Stripe-Signature')))) return new Response('signature', { status: 400 });
    const ev = JSON.parse(payload);
    if (ev.type === 'checkout.session.completed' && ev.data?.object?.payment_status === 'paid') {
      const token = ev.data.object.client_reference_id;
      const raw = token && await env.COUNTERS.get(`efd:${token}`);
      if (raw) {
        const d = JSON.parse(raw);
        if (!d.paye) {
          d.paye = true; d.payeLe = new Date().toISOString(); d.stripeSession = ev.data.object.id;
          await env.COUNTERS.put(`efd:${token}`, JSON.stringify(d), { expirationTtl: TTL_DOSSIER });
          await envoyerLien(env, d, token, origin);
        }
      }
    }
    return new Response('ok');
  }

  if (request.method === 'GET' && p === '/ef/dossier/merci') {
    const t = url.searchParams.get('t') || '';
    return page('Merci', `<h1>Merci !</h1><p>Dès la confirmation du paiement, votre dossier est prêt et vous recevez le lien par courriel.</p><p><a class="btn" href="/ef/dossier/${esc(t)}">Ouvrir mon dossier</a></p><p class="muted">Si la page dit que le paiement n'est pas confirmé, patientez une minute et rechargez.</p>`);
  }

  const mt = p.match(/^\/ef\/dossier\/([0-9a-f-]{36})(\/formulaire\.pdf)?$/);
  if (request.method === 'GET' && mt) {
    const raw = await env.COUNTERS.get(`efd:${mt[1]}`);
    if (!raw) return page('Dossier introuvable', '<h1>Dossier introuvable</h1><p>Ce lien a expiré (30 jours) ou il est invalide.</p>', { status: 404 });
    const d = JSON.parse(raw);
    if (!d.paye) return page('Paiement en attente', '<h1>Paiement en cours de confirmation</h1><p>Rechargez cette page dans une minute.</p>', { status: 402 });
    if (mt[2]) {
      try {
        const bytes = await formulairePdf(d);
        return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="demande-revision-${d.m.nom.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf"`, 'Cache-Control': 'no-store' } });
      } catch (err) {
        return page('Formulaire indisponible', `<h1>Le formulaire est momentanément indisponible</h1><p>${esc(err.message)}. Réessayez plus tard, ou remplissez le <a href="${FORMULAIRE_URL}">formulaire officiel</a> avec les motifs de votre dossier.</p>`, { status: 502 });
      }
    }
    return pageDossier(d, mt[1]);
  }
  return null;
}
