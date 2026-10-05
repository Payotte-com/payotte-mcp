/**
 * visibiliteIa.js — service « Visibilité IA » (page /visibilite-ia-professionnels-immobilier).
 *
 * POST /vi/inscription — formulaire de la page (correctif 2, ronde 2, 5 oct. 2026).
 *   Remplace les courriels préremplis (mailto:), qui échouent sans logiciel de courriel.
 *   Fonctionne SANS JavaScript : POST classique (application/x-www-form-urlencoded), puis
 *   redirection 303 vers la page de confirmation du site, ou vers le formulaire avec ?erreur=… .
 *   Aucun paiement ici : le pro paie APRÈS vérification de son permis et de son secteur (promesse de
 *   la page). La demande part à Grégory (REPORT_TO), « Répondre » écrit au pro ; le pro reçoit un
 *   accusé de réception. Garde-fous : pot de miel, consentement coché, domaine réel, 5 demandes par
 *   jour et par courriel (empreinte HMAC), 200 demandes par jour au total.
 *   ⚠️ Le numéro de permis est FACULTATIF : le RECA (Alberta) n'en publie aucun — ne jamais l'exiger.
 */

const METIERS = {
  'real-estate-broker': { fr: 'Courtier immobilier', en: 'Real estate broker' },
  'mortgage-broker': { fr: 'Courtier hypothécaire', en: 'Mortgage broker' },
  'home-inspector': { fr: 'Inspecteur en bâtiment', en: 'Home inspector' },
  'notary-lawyer': { fr: 'Notaire / avocat', en: 'Notary / real estate lawyer' },
  'appraiser': { fr: 'Évaluateur agréé', en: 'Appraiser' },
};
const FORFAITS = {
  aucun: { fr: 'Aucun pour l’instant (je soumets mon nom)', en: 'None for now (I am submitting my name)' },
  fiche: { fr: 'Fiche IA', en: 'AI profile' },
  premium: { fr: 'Premium', en: 'Premium' },
  pro: { fr: 'Premium Pro', en: 'Premium Pro' },
};

export async function handleInscription(request, env, h) {
  const { SITE, REPORT_TO, EMAIL_RE, domainExists, bumpCounter, hmacHex } = h;
  const ct = request.headers.get('content-type') || '';
  let b = {};
  if (ct.includes('application/json')) b = (await request.json().catch(() => ({}))) || {};
  else { const f = await request.formData().catch(() => null); if (f) for (const [k, v] of f.entries()) b[k] = typeof v === 'string' ? v : ''; }

  const fr = b.lang !== 'en';
  const page = fr ? '/visibilite-ia-professionnels-immobilier' : '/en/ai-visibility-real-estate-professionals';
  const merci = fr ? '/inscription-recue' : '/en/registration-received';
  const retour = (code) => Response.redirect(`${SITE}${page}?erreur=${code}#inscription`, 303);

  if (b.url_hp) return Response.redirect(`${SITE}${merci}`, 303);            // pot de miel : un robot a rempli le champ caché
  const propre = (v, n = 200) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n).trim();
  const nom = propre(b.nom, 120);
  const courriel = propre(b.courriel, 160).toLowerCase();
  const metier = METIERS[b.metier] ? b.metier : '';
  const forfait = FORFAITS[b.forfait] ? b.forfait : 'aucun';
  const formule = b.formule === 'annuelle' ? 'annuelle' : 'mensuelle';
  const secteur = propre(b.secteur, 80);
  const secteurLibre = propre(b.secteur_libre, 120);
  if (b.consentement !== 'oui' && b.consentement !== true) return retour('consentement');
  if (!nom || !EMAIL_RE.test(courriel)) return retour('champs');
  if (!metier || (!secteur && !secteurLibre)) return retour('metier');
  if (!(await domainExists(courriel))) return retour('domaine');
  const jour = new Date().toISOString().slice(0, 10);
  if (env.COUNTERS) {
    const rh = (await hmacHex(env, courriel)).slice(0, 16);
    if ((await bumpCounter(env, `vii:${rh}:${jour}`, 3 * 86400)) > 5) return retour('limite');
    if ((await bumpCounter(env, `vii:total:${jour}`, 3 * 86400)) > 200) return retour('limite');
  }

  const tel = propre(b.tel, 40), site = propre(b.site_web, 160), permis = propre(b.permis, 60), note = propre(b.note, 600);
  const fiche = {
    recu: new Date().toISOString(), lang: fr ? 'fr' : 'en', nom, courriel, tel, metier, secteur, secteurLibre,
    site, permis, forfait, formule: forfait === 'aucun' ? null : formule, note,
  };
  // Trace durable de la demande (la boîte de courriel n'est pas un registre) : 400 jours.
  if (env.COUNTERS) await env.COUNTERS.put(`vi:inscription:${fiche.recu}:${(await hmacHex(env, courriel)).slice(0, 8)}`, JSON.stringify(fiche), { expirationTtl: 400 * 86400 });

  if (env.RESEND_API_KEY) {
    const lieu = secteur ? `${secteur}${secteurLibre ? ` (précisé : ${secteurLibre})` : ''}` : `HORS LISTE : ${secteurLibre}`;
    const corps = [
      `Nouvelle inscription — Visibilité IA`, '',
      `Nom : ${nom}`, `Courriel : ${courriel}`, ...(tel ? [`Téléphone : ${tel}`] : []),
      `Métier : ${METIERS[metier].fr}`, `Secteur : ${lieu}`,
      ...(site ? [`Site : ${site}`] : []), `Permis : ${permis || '— (non fourni)'}`,
      `Forfait : ${FORFAITS[forfait].fr}${forfait === 'aucun' ? '' : ` · formule ${formule}`}`,
      `Langue : ${fr ? 'français' : 'anglais'}`,
      ...(note ? ['', note] : []),
      '', 'À faire : vérifier le permis et le secteur, dire au pro laquelle des trois possibilités est la sienne (A recommandé, B nouveau secteur, C fiche professionnelle), puis envoyer le paiement s’il y a lieu.',
      '— « Répondre » écrit directement au pro.',
    ].join('\n');
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Payotte <relais@payotte.com>', to: [REPORT_TO], reply_to: courriel,
        subject: `[Visibilité IA] ${FORFAITS[forfait].fr} — ${nom} (${METIERS[metier].fr})`, text: corps,
      }),
    }).catch(() => null);
    // Accusé au pro : il sait ce qui se passe ensuite, et qu'il ne paie rien avant la vérification.
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Payotte <relais@payotte.com>', to: [courriel], reply_to: REPORT_TO,
        subject: fr ? 'Nous avons bien reçu votre inscription — Payotte' : 'We received your registration — Payotte',
        text: (fr
          ? [`Bonjour ${nom},`, '', 'Merci, nous avons bien reçu votre inscription.', '',
             'La suite : nous vérifions votre permis et votre secteur, puis nous vous écrivons pour vous dire laquelle des trois possibilités est la vôtre : expert recommandé, nouveau secteur ou fiche professionnelle.',
             forfait === 'aucun' ? '' : `Pour le forfait ${FORFAITS[forfait].fr}, le lien de paiement vous parviendra après cette vérification. Vous ne payez rien avant.`,
             '', 'Une question d’ici là ? Répondez simplement à ce courriel.', '', '— Grégory Payotte', 'https://payotte.com']
          : [`Hello ${nom},`, '', 'Thank you, we received your registration.', '',
             'Next: we check your licence and your sector, then write to tell you which of the three possibilities is yours: recommended expert, new sector or professional profile.',
             forfait === 'aucun' ? '' : `For the ${FORFAITS[forfait].en} plan, the payment link will reach you after this check. You pay nothing before.`,
             '', 'Any question in the meantime? Just reply to this email.', '', '— Grégory Payotte', 'https://payotte.com']).filter((x) => x !== null).join('\n'),
        headers: { 'Auto-Submitted': 'auto-replied' },
      }),
    }).catch(() => null);
  }
  await bumpCounter(env, `vi:insc:${forfait}:${new Date().toISOString().slice(0, 7)}`, 400 * 86400);
  return Response.redirect(`${SITE}${merci}${forfait === 'aucun' ? '' : `?forfait=${forfait}`}`, 303);
}
