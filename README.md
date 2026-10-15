# payotte-mcp

Serveur **MCP** (Model Context Protocol) de Payotte — l'annuaire immobilier canadien de professionnels
**vérifiés** branché dans les IA, et les données immobilières de 9 pays (Canada, France,
États-Unis, Royaume-Uni, Australie, Inde, Brésil, Mexique, Espagne).

- **Hébergement** : Cloudflare Workers, palier gratuit (100 000 requêtes/jour).
- **Zéro état, zéro maintenance** : le worker lit en direct les feeds statiques de payotte.com
  (`/api/experts.json`, `/api/regulators.json`, `/api/market.json`), régénérés à chaque
  déploiement normal du site. Rien à mettre à jour ici quand les fiches changent.
- **Transport** : Streamable HTTP sans état (POST JSON-RPC sur `/mcp`). Aucune dépendance.

## Les 69 outils

Liste générée depuis `tools/list` (version 1.13.0). Le Canada porte les fiches d'experts ; les autres pays exposent les règles, taxes, frais et prix de leurs sections sur payotte.com.


### Canada (14)

| Outil | Titre |
|---|---|
| `evaluation_adresse` | Évaluation foncière à une adresse / Property assessment at an address |
| `taxe_bienvenue_adresse` | Taxe de bienvenue à une adresse / Land transfer tax at an address |
| `risques_annee_construction` | Risques selon l’année de construction / Risks by construction year |
| `trouver_expert` | Trouver un expert immobilier vérifié / Find a verified real-estate expert |
| `verifier_titre` | Vérifier un titre professionnel / Which regulator governs this title |
| `stats_marche` | Statistiques du marché immobilier par ville / Per-city housing-market stats |
| `taux_courants` | Taux d'intérêt canadiens courants / Current Canadian interest rates |
| `taxe_mutation` | Calculer la taxe de mutation / Compute the land transfer tax |
| `acheter_ou_louer` | Acheter ou louer ? / Rent vs buy in a city |
| `salaire_requis` | Salaire requis pour acheter / Income needed to buy in a city |
| `contacter_expert` | Contacter l'expert vérifié / Contact the verified expert |
| `fenetre_revision` | Échéance pour contester son évaluation foncière / Property-assessment appeal deadline (Canada) |
| `frais_revision` | Frais d'une demande de révision / Assessment review filing fee (Canada) |
| `estimer_economie` | Économie de taxes d'une baisse d'évaluation / Tax saving of an assessment reduction (Quebec) |

### France (4)

| Outil | Titre |
|---|---|
| `frais_notaire_fr` | Frais de notaire en France / French notary fees |
| `stats_marche_fr` | Prix immobiliers DVF en France / French property prices (DVF) |
| `trouver_professionnel_fr` | Trouver un professionnel en France / Find a French real-estate firm |
| `verifier_titre_fr` | Vérifier le titre d’un professionnel en France / Check a French professional’s credential |

### États-Unis / United States (16)

| Outil | Titre |
|---|---|
| `transfer_tax_us` | US real estate transfer tax by state |
| `property_tax_us` | US property tax by state |
| `property_tax_appeal_us` | US property tax appeal deadline by state |
| `attorney_at_closing_us` | Is an attorney required at closing? (US, by state) |
| `foreclosure_us` | US foreclosure process by state |
| `seller_disclosure_us` | US seller disclosure law by state |
| `closing_costs_us` | US closing costs by state (items set by law) |
| `first_time_buyer_programs_us` | US first-time home buyer programs by state |
| `home_prices_us` | US median home value by state and main city |
| `community_property_us` | US community property states |
| `title_insurance_us` | US title insurance rates by state |
| `natural_hazards_us` | US natural hazards and home insurance by state |
| `verify_license_us` | Verify a US real estate professional’s license |
| `compare_states_us` | Compare the 50 US states on one rule |
| `state_overview_us` | Buying a home in a US state: key facts |
| `federal_guide_us` | US federal home-buying guides |

### Royaume-Uni / United Kingdom (5)

| Outil | Titre |
|---|---|
| `purchase_tax_uk` | UK purchase tax on a home: SDLT, LBTT or LTT |
| `house_prices_uk` | UK average house prices (UK House Price Index) |
| `compare_nations_uk` | UK property rules compared across the four nations |
| `guide_uk` | Payotte UK guides: buying, renting and owning a home |
| `check_professional_uk` | Who regulates a UK property professional, and where to check one |

### Australie / Australia (5)

| Outil | Titre |
|---|---|
| `purchase_duty_au` | Australian transfer (stamp) duty on a home, by state |
| `house_prices_au` | Australian dwelling prices (ABS) |
| `compare_states_au` | Australian property rules compared across the states |
| `guide_au` | Payotte Australia guides: buying, renting and owning a home |
| `check_professional_au` | Who regulates an Australian property professional, and where to check one |

### Inde / India (6)

| Outil | Titre |
|---|---|
| `stamp_duty_in` | Indian stamp duty and registration on a home, by state |
| `home_loan_emi_in` | Indian home loan EMI |
| `house_prices_in` | Indian house price indices (RBI, NHB RESIDEX) |
| `compare_states_in` | Indian property rules compared across the states |
| `guide_in` | Payotte India guides: buying, NRIs, renting and owning a home |
| `check_professional_in` | Who regulates an Indian property professional, and where to check one |

### Brésil / Brazil (6)

| Outil | Titre |
|---|---|
| `purchase_costs_br` | Brazilian home purchase costs: ITBI, notary deed, registration |
| `mortgage_payment_br` | Brazilian mortgage payment, SAC and Price |
| `capital_gains_tax_br` | Brazilian capital gains tax on selling a home |
| `compare_states_br` | Brazilian property costs and figures compared across the states |
| `guide_br` | Payotte Brazil guides: foreign buyers, buying, financing, selling, renting, owning |
| `check_professional_br` | Who regulates a Brazilian property professional, and where to check one |

### Mexique / Mexico (6)

| Outil | Titre |
|---|---|
| `closing_costs_mx` | Mexican property acquisition tax and recording fee, by municipality |
| `mortgage_payment_mx` | Mexican fixed-rate mortgage payment |
| `home_prices_mx` | Mexican home appraisal values and price index (SHF) |
| `compare_states_mx` | Mexican property rules and figures compared across the states |
| `guide_mx` | Payotte Mexico guides: foreign buyers, buying, selling, renting |
| `check_professional_mx` | Who regulates a Mexican property professional, and where to check one |

### Espagne / Spain (7)

| Outil | Titre |
|---|---|
| `purchase_costs_es` | Spanish purchase taxes and fees on a home, by region |
| `mortgage_payment_es` | Spanish mortgage monthly payment |
| `non_resident_tax_es` | Spanish non-resident tax on a home that is not let |
| `house_prices_es` | Spanish home values by city and region |
| `compare_regions_es` | Spanish property rules compared across the regions |
| `guide_es` | Payotte Spain guides: buying as a foreigner, taxes, renting and owning |
| `check_professional_es` | Who regulates a Spanish property professional, and where to check one |

Chaque réponse porte l'attribution **CC BY 4.0** (citer + lier payotte.com).

## Prérequis (une fois, ~10 min)

1. **Compte Cloudflare gratuit** : https://dash.cloudflare.com/sign-up (obligatoire pour déployer).
2. **Compte GitHub gratuit** (recommandé, pour lister le serveur dans les registres MCP → backlinks).

## Déployer

```bash
cd ~/Desktop/payotte-mcp
npm install                 # une fois
npx wrangler login          # ouvre le navigateur, se connecter au compte Cloudflare
npm run deploy              # → https://payotte-mcp.<sous-domaine>.workers.dev
```

⚠️ **Déployer d'abord le site payotte.com** (build du 23 juillet ou plus récent) : les feeds
`/api/regulators.json` et `/api/market.json` dont dépendent `verifier_titre` et `stats_marche`
sont dans ce build. (`/api/experts.json` est déjà en ligne.)

L'URL MCP à donner aux clients (Claude, etc.) : `https://payotte-mcp.<sous-domaine>.workers.dev/mcp`

## Tester en local (sans compte)

```bash
npm run dev                 # http://localhost:8787
curl -s localhost:8787/     # carte de visite du serveur
curl -s localhost:8787/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"trouver_expert","arguments":{"profession":"courtier immobilier","ville":"Montréal"}}}'
```

## Brancher dans Claude

- **Claude Code** : `claude mcp add --transport http payotte https://payotte-mcp.<sous-domaine>.workers.dev/mcp`
- **claude.ai** (Connecteurs) : Paramètres → Connecteurs → Ajouter un connecteur personnalisé → coller l'URL `/mcp`.

## Activer le relais de contact (contacter_expert)

Sans configuration, l'outil tourne en **mode répétition** (réponse simulée, aucun envoi). Pour l'activer :

1. **Côté site** : le fichier privé `/api/cx/{jeton}.json` doit être déployé (jeton dans
   `payotte-astro/src/lib/contactsToken.ts` — NE JAMAIS lier cette URL). Secret Cloudflare
   correspondant : `CONTACTS_TOKEN` (déjà posé).
2. **Compte Resend gratuit** (100 courriels/jour) : https://resend.com → ajouter le domaine
   `payotte.com` → poser les enregistrements DNS proposés (chez GoDaddy) → créer une clé API.
3. `printf 'LA_CLE' | npx wrangler secret put RESEND_API_KEY` puis c'est actif — aucun redéploiement requis.

Adresse d'expédition : `MAIL_FROM` dans wrangler.toml (défaut `Payotte <relais@payotte.com>`).

## Après le déploiement (l'antenne)

1. Lister le serveur dans le **registre MCP officiel** (via GitHub) + annuaires communautaires
   → backlinks tech + découvrabilité par les agents.
2. Angle RP : « premier annuaire immobilier canadien branché dans les IA ».
