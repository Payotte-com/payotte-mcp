// esCalc.js — GÉNÉRÉ par payotte-astro-espagne/scripts/es/export-mcp.mjs (esbuild de src/lib/es/fraisAchat.ts, calculateurs.ts, pret.ts) ; ne pas modifier à la main.

// src/data/es/frais-achat.json
var frais_achat_default = {
  _note: "G\xE9n\xE9r\xE9 par scripts/es/gen-frais-achat.py ; ne pas modifier \xE0 la main. Taux g\xE9n\xE9raux (personne physique) ; taux r\xE9duits en note.",
  releve: "2026-10-15",
  national: {
    base_imponible: {
      regle: "max(valeur de r\xE9f\xE9rence du Catastro \xE0 la date du fait g\xE9n\xE9rateur, prix/valeur d\xE9clar\xE9e) ; sans valeur de r\xE9f\xE9rence : max(valeur d\xE9clar\xE9e, prix, valeur de march\xE9)",
      source: {
        titre: "Real Decreto Legislativo 1/1993 (TRLITPAJD)",
        url: "https://www.boe.es/buscar/act.php?id=BOE-A-1993-25359",
        article: "art. 10.1-2 (Ley 11/2021); art. 30.1 for AJD",
        consulte: "2026-10-15"
      },
      hors_champ: "Navarre et Pays basque (normes forales, valeur r\xE9elle)"
    },
    ajd_hypotheque_sujet_passif: {
      regle: "le pr\xEAteur (prestamista)",
      source: {
        titre: "Real Decreto Legislativo 1/1993 (TRLITPAJD)",
        url: "https://www.boe.es/buscar/act.php?id=BOE-A-1993-25359",
        article: "art. 29, second paragraph (RDL 17/2018, in force 10/11/2018)",
        consulte: "2026-10-15"
      }
    },
    iva_neuf: {
      impot: "IVA",
      taux: 10,
      taux_reduit: {
        taux: 4,
        condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
      },
      source: {
        titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
        url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
        article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
        consulte: "2026-10-15"
      },
      note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
    },
    notaire: {
      type: "brackets_marginal",
      base: "valeur fiscalement v\xE9rifi\xE9e, \xE0 d\xE9faut valeur d\xE9clar\xE9e (Anexo II, norma primera)",
      fixe_jusqu_a_6010_12: 90.151816,
      tranches_pour_mille: [
        {
          de: 6010.12,
          jusqu_a: 30050.61,
          pour_mille: 4.5
        },
        {
          de: 30050.61,
          jusqu_a: 60101.21,
          pour_mille: 1.5
        },
        {
          de: 60101.21,
          jusqu_a: 150253.03,
          pour_mille: 1
        },
        {
          de: 150253.03,
          jusqu_a: 601012.1,
          pour_mille: 0.5
        },
        {
          de: 601012.1,
          jusqu_a: 601012104e-2,
          pour_mille: 0.3
        },
        {
          de: 601012104e-2,
          jusqu_a: null,
          pour_mille: null,
          note: "libre accord"
        }
      ],
      rebaja_pct: 5,
      descuento_facultatif_max_pct: 10,
      non_calcule: [
        "copies autoris\xE9es : 3,005061 \u20AC/folio, moiti\xE9 \xE0 partir du 12e folio (n\xFAmero 4)",
        "folios de matrice \xE0 partir du 5e : 3,005061 \u20AC/face (n\xFAmero 7)",
        "nombre de folios inconnu \u2192 \xAB not computed \xBB",
        "acte d'hypoth\xE8que s\xE9par\xE9"
      ],
      exemples_matrice_apres_rebaja: {
        "150000": 316.64,
        "250000": 364.26,
        "400000": 435.51
      },
      source: {
        titre: "Real Decreto 1426/1989, Arancel de los Notarios (consolidated text, last updated 17/11/2011)",
        url: "https://www.boe.es/buscar/act.php?id=BOE-A-1989-28111",
        article: "Anexo I, n\xFAmero 2.1; n\xFAmeros 4 and 7; Anexo II",
        consulte: "2026-10-15"
      },
      source_descuento: {
        titre: "Real Decreto-ley 6/2000",
        url: "https://www.boe.es/buscar/act.php?id=BOE-A-2000-11836",
        article: "art. 35.1",
        consulte: "2026-10-15"
      },
      source_rebaja: {
        titre: "Real Decreto-ley 8/2010",
        url: "https://www.boe.es/buscar/act.php?id=BOE-A-2010-8228",
        article: "disposici\xF3n adicional octava.Uno.1",
        consulte: "2026-10-15"
      }
    },
    registre: {
      type: "brackets_marginal",
      fixe_jusqu_a_6010_12: 24.040484,
      tranches_pour_mille: [
        {
          de: 6010.12,
          jusqu_a: 30050.61,
          pour_mille: 1.75
        },
        {
          de: 30050.61,
          jusqu_a: 60101.21,
          pour_mille: 1.25
        },
        {
          de: 60101.21,
          jusqu_a: 150253.03,
          pour_mille: 0.75
        },
        {
          de: 150253.03,
          jusqu_a: 601012.1,
          pour_mille: 0.3
        },
        {
          de: 601012.1,
          jusqu_a: null,
          pour_mille: 0.2
        }
      ],
      minimum: 24.040484,
      maximum: 2181.673939,
      reductions_successives_pct: [
        5,
        5
      ],
      reductions_detail: [
        "5 % sur tout le n\xFAmero 2 (RD 1427/1989 Anexo I n\xFAmero 2.1, issu du RD 1612/2011 / RDL 8/2010 DA 8\xAA.Uno.2)",
        "5 % suppl\xE9mentaire pour la compraventa de viviendas, appliqu\xE9 apr\xE8s la rebaja initiale (RDL 6/2000, art. 36.1)"
      ],
      ordre_application: "interpr\xE9tation : bar\xE8me \u2192 plafond/plancher \u2192 \u22125 % \u2192 \u22125 % (l'ordre min/max vs rebajas n'est pas explicite)",
      presentation_fixe: 6.010121,
      exemples_inscription_apres_reductions: {
        "150000": 154.42,
        "250000": 181.59,
        "400000": 222.21
      },
      source: {
        titre: "Real Decreto 1427/1989, Arancel de los Registradores de la Propiedad (consolidated text, last updated 17/11/2011)",
        url: "https://www.boe.es/buscar/act.php?id=BOE-A-1989-28112",
        article: "Anexo I, n\xFAmeros 1 and 2",
        consulte: "2026-10-15"
      },
      source_reduction_vivienda: {
        titre: "Real Decreto-ley 6/2000",
        url: "https://www.boe.es/buscar/act.php?id=BOE-A-2000-11836",
        article: "art. 36.1",
        consulte: "2026-10-15"
      },
      propose: "projet de RD modifiant l'arancel registral (Ministerio de Justicia, 18/09/2026) = PROPOS\xC9, non lu, non appliqu\xE9"
    },
    gestoria: {
      montant: null,
      raison: "honoraires libres, aucun bar\xE8me officiel lu"
    },
    qui_paie: {
      itp: "acqu\xE9reur (TRLITPAJD art. 8.a)",
      notaire: "matrice : vendeur ; premi\xE8re copie et frais post\xE9rieurs \xE0 la vente : acheteur, sauf pacte contraire (C\xF3digo Civil art. 1455)",
      plusvalia_municipale: "vendeur dans une vente (TRLRHL art. 106.1.b) ; l'acheteur est substitut si le vendeur est une personne physique non r\xE9sidente (art. 106.2)"
    }
  },
  regions: {
    andalusia: {
      nom_en: "Andalusia",
      nom_es: "Andaluc\xEDa",
      regime: "commun",
      itp: {
        type: "flat",
        taux: 7,
        source: {
          titre: "Ley 5/2021, de 20 de octubre, de Tributos Cedidos de la Comunidad Aut\xF3noma de Andaluc\xEDa",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2021-17915",
          article: "art. 41",
          consulte: "2026-10-15"
        },
        vigueur: "2021-10-27",
        derniere_modification: "texte original (pas de modification de l'art. 41) ; texte consolid\xE9 mis \xE0 jour le 31/12/2025"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.2,
        source: {
          titre: "Ley 5/2021 (Andaluc\xEDa)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2021-17915",
          article: "art. 49",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "Taux r\xE9duits art. 43 (6 % vivienda habitual \u2264150 000 \u20AC ; 3,5 % <35 ans, handicap, famille nombreuse\u2026 avec plafonds 150 000/250 000 \u20AC) ; AJD r\xE9duits art. 50.",
      statut: "COMPLET"
    },
    aragon: {
      nom_en: "Aragon",
      nom_es: "Arag\xF3n",
      regime: "commun",
      itp: {
        type: "brackets",
        mode: "marginal",
        tranches: [
          {
            jusqu_a: 4e5,
            taux: 8
          },
          {
            jusqu_a: 45e4,
            taux: 8.5
          },
          {
            jusqu_a: 5e5,
            taux: 9
          },
          {
            jusqu_a: 75e4,
            taux: 9.5
          },
          {
            jusqu_a: null,
            taux: 10
          }
        ],
        source: {
          titre: "Decreto Legislativo 1/2005, texto refundido tributos cedidos de Arag\xF3n",
          url: "https://www.boe.es/buscar/act.php?id=BOA-d-2005-90006",
          article: "art. 121-1",
          consulte: "2026-10-15"
        },
        vigueur: "2016-01-01",
        derniere_modification: "Ley 10/2015 (effets 1/1/2016) ; texte consolid\xE9 mis \xE0 jour le 07/07/2025 (Ley 3/2025, autres articles)"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.5,
        source: {
          titre: "Decreto Legislativo 1/2005 (Arag\xF3n)",
          url: "https://www.boe.es/buscar/act.php?id=BOA-d-2005-90006",
          article: "art. 122-1",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "Bar\xE8me \xAB valor bien hasta / cuota \xEDntegra / resto / tipo \xBB, appliqu\xE9 \xAB en la misma proporci\xF3n \xBB \xE0 la base liquidable. Bonifications art. 121-4 (12,5 % de la cuota, <35 ans etc., valeur \u2264100 000 \u20AC) et 121-5 (familles nombreuses, 50 %). Accord PP-VOX d'avril 2026 = propos\xE9, non adopt\xE9 \xE0 notre connaissance.",
      statut: "COMPLET"
    },
    asturias: {
      nom_en: "Asturias",
      nom_es: "Principado de Asturias",
      regime: "commun",
      itp: {
        type: "brackets",
        mode: "single_rate_by_value",
        tranches: [
          {
            jusqu_a: 3e5,
            taux: 8
          },
          {
            jusqu_a: 5e5,
            taux: 9
          },
          {
            jusqu_a: null,
            taux: 10
          }
        ],
        source: {
          titre: "Decreto Legislativo 2/2014, texto refundido tributos cedidos del Principado de Asturias",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2015-945",
          article: "art. 26",
          consulte: "2026-10-15"
        },
        vigueur: "2014-10-30",
        derniere_modification: "texte original de l'art. 26 ; texte consolid\xE9 mis \xE0 jour le 31/12/2025"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.2,
        source: {
          titre: "Decreto Legislativo 2/2014 (Asturias)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2015-945",
          article: "art. 34",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "ATTENTION : un seul taux sur la valeur totale selon la tranche (\xAB atendiendo al valor \xEDntegro del bien \xBB), pas de calcul marginal (effet de seuil). Taux r\xE9duits art. 32 bis (4 % \u2264150 000 \u20AC, 6 % au-del\xE0 : jeunes \u226435 ans, familles nombreuses/monoparentales, zones rurales\u2026).",
      statut: "COMPLET"
    },
    "balearic-islands": {
      nom_en: "Balearic Islands",
      nom_es: "Illes Balears",
      regime: "commun",
      itp: {
        type: "brackets",
        mode: "marginal_average_rate",
        tranches: [
          {
            jusqu_a: 4e5,
            taux: 8
          },
          {
            jusqu_a: 6e5,
            taux: 9
          },
          {
            jusqu_a: 1e6,
            taux: 10
          },
          {
            jusqu_a: 2e6,
            taux: 12
          },
          {
            jusqu_a: null,
            taux: 13
          }
        ],
        source: {
          titre: "Decreto Legislativo 1/2014, texto refundido tributos cedidos de las Illes Balears",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2014-6925",
          article: "art. 10.a)",
          consulte: "2026-10-15"
        },
        vigueur: "2023-01-01",
        derniere_modification: "lettre a) : Ley 11/2022 (1/1/2023) ; art. 10 derni\xE8re mise \xE0 jour 13/06/2026 (Ley 4/2026, lettre d.3\xBA seulement)"
      },
      ajd_neuf: {
        type: "brackets",
        mode: "single_rate_by_value",
        tranches: [
          {
            jusqu_a: 999999.99,
            taux: 1.5
          },
          {
            jusqu_a: null,
            taux: 2
          }
        ],
        source: {
          titre: "Decreto Legislativo 1/2014 (Illes Balears)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2014-6925",
          article: "art. 15 (1.5%); art. 17 bis (2% if the value is \u20AC1,000,000 or more)",
          consulte: "2026-10-15"
        }
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "Tipo medio = cuota du bar\xE8me / valeur totale, arrondi \xE0 2 d\xE9cimales (art. 10, dernier alin\xE9a de b). Taux r\xE9duits : 4 % vivienda habitual \u2264270 151,20 \u20AC (art. 10.c) ; 2 % <36 ans etc. (10.d) ; bonification 100 % art. 14 quater (<30 ans/handicap, revenus, hypoth\xE8que \u226560 %).",
      statut: "COMPLET"
    },
    "canary-islands": {
      nom_en: "Canary Islands",
      nom_es: "Canarias",
      regime: "commun_igic",
      itp: {
        type: "flat",
        taux: 6.5,
        source: {
          titre: "Decreto Legislativo 1/2009, texto refundido tributos cedidos de Canarias",
          url: "https://www.boe.es/buscar/act.php?id=BOC-j-2009-90008",
          article: "art. 31.1.a)",
          consulte: "2026-10-15"
        },
        vigueur: "2026-01-01",
        derniere_modification: "Ley 9/2025, de 23 de diciembre (disp. final 11.19), mise \xE0 jour publi\xE9e le 29/12/2025"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1,
        source: {
          titre: "Decreto Legislativo 1/2009 (Canarias)",
          url: "https://www.boe.es/buscar/act.php?id=BOC-j-2009-90008",
          article: "art. 36 (1% for deeds of transactions subject to IGIC or VAT; 0.75% otherwise)",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IGIC",
        taux: 7,
        taux_reduits: [
          {
            taux: 5,
            condition: "vivienda habitual, base \u2264200 000 \u20AC (300 000/400 000 \u20AC familles nombreuses), aucun autre logement (art. 38.Cuatro)"
          },
          {
            taux: 3,
            condition: "vivienda habitual + \u226440 ans / famille nombreuse / handicap \u226565 % / violence de genre / monoparentale, revenus \u226446 455 \u20AC (+15 315 \u20AC conjointe), base \u2264200 000 \u20AC (art. 38.Dos)"
          },
          {
            taux: 0,
            condition: "VPO livr\xE9es par le promoteur (art. 38.Uno)"
          }
        ],
        source: {
          titre: "Decreto Legislativo 1/2025, de 13 de octubre, texto refundido IGIC y AIEM (Canarias)",
          url: "https://www.boe.es/buscar/act.php?id=BOC-j-2025-90249",
          article: "art. 32 (tipo general 7%); art. 38.Cinco (viviendas au tipo general)",
          consulte: "2026-10-15"
        }
      },
      note: "ITP r\xE9duit 5 % (vivienda habitual, base \u2264200 000 \u20AC, aucun autre logement) art. 31.1.a ; 1 % familles nombreuses/handicap/monoparentales (art. 32-33 bis) ; 0 % VPO 1re vivienda habitual (art. 34).",
      statut: "COMPLET"
    },
    cantabria: {
      nom_en: "Cantabria",
      nom_es: "Cantabria",
      regime: "commun",
      itp: {
        type: "flat",
        taux: 9,
        source: {
          titre: "Decreto Legislativo 62/2008, texto refundido Ley de Medidas Fiscales en materia de Tributos cedidos (Cantabria)",
          url: "https://www.boe.es/buscar/act.php?id=BOCT-c-2008-90028",
          article: "art. 9.1.A)",
          consulte: "2026-10-15"
        },
        vigueur: "2016-01-01",
        derniere_modification: "apartado 1 : Ley 6/2015 ; art. 9 derni\xE8re mise \xE0 jour 30/04/2026 (Ley 5/2026 : apartados 2, 3.c, 4, 7)"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.5,
        source: {
          titre: "Decreto Legislativo 62/2008 (Cantabria)",
          url: "https://www.boe.es/buscar/act.php?id=BOCT-c-2008-90028",
          article: "art. 13.3",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "Vivienda habitual : 7 % jusqu'\xE0 300 000 \u20AC, 9 % au-del\xE0 (art. 9.2) ; 4 % familles nombreuses/monoparentales, handicap 33-65 %, <40 ans, VPO, communes en d\xE9peuplement (9.3, plafond 300 000 \u20AC art. 9.7). AJD vivienda habitual 1 % (13.3), 0,1 % cas 13.4.",
      statut: "COMPLET"
    },
    "castilla-la-mancha": {
      nom_en: "Castilla-La Mancha",
      nom_es: "Castilla-La Mancha",
      regime: "commun",
      itp: {
        type: "flat",
        taux: 9,
        source: {
          titre: "Ley 8/2013, de 21 de noviembre, de Medidas Tributarias de Castilla-La Mancha",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2014-1368",
          article: "art. 19.1",
          consulte: "2026-10-15"
        },
        vigueur: "2016-06-01",
        derniere_modification: "art. 19 modifi\xE9 par Ley 1/2026, de 26 de marzo (DOCM 30/03/2026, en vigueur 31/03/2026) sur les apartados 2, 6 et 9 seulement ; apartado 1 inchang\xE9. Le texte consolid\xE9 BOE n'int\xE8gre PAS encore la Ley 1/2026."
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.5,
        source: {
          titre: "Ley 8/2013 (Castilla-La Mancha)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2014-1368",
          article: "art. 21.1",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "Ley 1/2026 lue au DOCM (https://www.boe.es/ccaa/docm/2026/061/q10660-10683.pdf) : 6 % 1re vivienda habitual \u2264240 000 \u20AC avec hypoth\xE8que >50 % ; 5 % handicap/famille nombreuse/monoparentale ; 3 % <36 ans. AJD 0,75 % / 0,50 % / 0,25 %.",
      statut: "COMPLET"
    },
    "castile-and-leon": {
      nom_en: "Castile and Le\xF3n",
      nom_es: "Castilla y Le\xF3n",
      regime: "commun",
      itp: {
        type: "brackets",
        mode: "marginal",
        tranches: [
          {
            jusqu_a: 25e4,
            taux: 8
          },
          {
            jusqu_a: null,
            taux: 10
          }
        ],
        source: {
          titre: "Decreto Legislativo 1/2013, texto refundido tributos propios y cedidos de Castilla y Le\xF3n",
          url: "https://www.boe.es/buscar/act.php?id=BOCL-h-2013-90254",
          article: "art. 24.1.a) and art. 25.1",
          consulte: "2026-10-15"
        },
        vigueur: "2013-09-19",
        derniere_modification: "texte original (art. 24 et 25.1) ; texte consolid\xE9 mis \xE0 jour le 14/05/2024"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.5,
        source: {
          titre: "Decreto Legislativo 1/2013 (Castilla y Le\xF3n)",
          url: "https://www.boe.es/buscar/act.php?id=BOCL-h-2013-90254",
          article: "art. 24.2",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "R\xE9duits art. 25.3 (4 % vivienda habitual : famille nombreuse, handicap \u226565 %, tous acqu\xE9reurs <36 ans, VPO) et 25.4 (0,01 %, <36 ans + communes rurales art. 7.1.c) ; conditions de revenus art. 28 (31 500 \u20AC / 37 800 \u20AC). Consolidation BOE de mai 2024 : modification 2025-2026 non exclue (aucune trouv\xE9e).",
      statut: "COMPLET"
    },
    catalonia: {
      nom_en: "Catalonia",
      nom_es: "Catalu\xF1a",
      regime: "commun",
      itp: {
        type: "brackets",
        mode: "marginal_average_rate",
        tranches: [
          {
            jusqu_a: 6e5,
            taux: 10
          },
          {
            jusqu_a: 9e5,
            taux: 11
          },
          {
            jusqu_a: 15e5,
            taux: 12
          },
          {
            jusqu_a: null,
            taux: 13
          }
        ],
        source: {
          titre: "Decreto Legislativo 1/2024, libro sexto del C\xF3digo tributario de Catalunya",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2024-6951",
          article: "art. 641-1.1",
          consulte: "2026-10-15"
        },
        vigueur: "2025-06-27",
        derniere_modification: "Decreto-ley 5/2025, de 25 de marzo (en vigueur 27/06/2025)"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.5,
        source: {
          titre: "Decreto Legislativo 1/2024 (Catalu\xF1a)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2024-6951",
          article: "art. 642-1.d)",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "20 % si l'acqu\xE9reur est \xAB gran tenedor \xBB ou pour un immeuble entier (641-1.5 et 6) ; 7 % VPO (641-1.2) ; 5 % jeunes \u226435 ans, familles nombreuses/monoparentales, handicap \u226565 %, victimes de violence machiste, avec revenus \u226436 000 \u20AC (641-2 \xE0 641-5 bis). AJD : bonification 100 % jeunes \u226435 ans (642-6).",
      statut: "COMPLET"
    },
    extremadura: {
      nom_en: "Extremadura",
      nom_es: "Extremadura",
      regime: "commun",
      itp: {
        type: "brackets",
        mode: "marginal",
        tranches: [
          {
            jusqu_a: 36e4,
            taux: 8
          },
          {
            jusqu_a: 6e5,
            taux: 10
          },
          {
            jusqu_a: null,
            taux: 11
          }
        ],
        source: {
          titre: "Decreto Legislativo 1/2018, texto refundido tributos cedidos de Extremadura",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2018-8159",
          article: "art. 36",
          consulte: "2026-10-15"
        },
        vigueur: "2018-05-24",
        derniere_modification: "texte original de l'art. 36 ; texte consolid\xE9 mis \xE0 jour le 04/08/2026 (Ley 2/2026)"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.5,
        source: {
          titre: "Decreto Legislativo 1/2018 (Extremadura)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2018-8159",
          article: "art. 46",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "R\xE9duits : 7 % vivienda habitual \u2264200 000 \u20AC et revenus \u226430 000/55 000 \u20AC (art. 40) ; 4 % m\xEAmes conditions + <36 ans / famille nombreuse / handicap \u226565 % (art. 41). Art. 40 bis abrog\xE9 par Ley 2/2026. AJD 0,5 % (art. 47).",
      statut: "COMPLET"
    },
    galicia: {
      nom_en: "Galicia",
      nom_es: "Galicia",
      regime: "commun",
      itp: {
        type: "flat",
        taux: 8,
        source: {
          titre: "Decreto Legislativo 1/2011, texto refundido tributos cedidos de Galicia",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2011-18161",
          article: "art. 14.Uno.1",
          consulte: "2026-10-15"
        },
        vigueur: "2024-01-01",
        derniere_modification: "apartado Uno : Ley 10/2023 ; art. 14 derni\xE8re mise \xE0 jour 31/12/2025 (Ley 5/2025)"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.5,
        source: {
          titre: "Decreto Legislativo 1/2011 (Galicia)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2011-18161",
          article: "art. 15.Uno",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "R\xE9duits : 7 % vivienda habitual (prix et patrimoine \u2264240 000 \u20AC + 30 000 \u20AC/membre) ; 3 % handicap \u226565 %, familles nombreuses (400 000 \u20AC), <36 ans, monoparentales, violence de genre ; 6 %/5 % zones rurales. AJD 1 % vivienda habitual, 0,5 % cas sp\xE9ciaux.",
      statut: "COMPLET"
    },
    "la-rioja": {
      nom_en: "La Rioja",
      nom_es: "La Rioja",
      regime: "commun",
      itp: {
        type: "flat",
        taux: 7,
        source: {
          titre: "Ley 10/2017, de 27 de octubre, disposiciones legales de La Rioja en materia de impuestos propios y tributos cedidos",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2017-13750",
          article: "art. 44.1",
          consulte: "2026-10-15"
        },
        vigueur: "2017-10-31",
        derniere_modification: "texte original de l'art. 44 ; texte consolid\xE9 mis \xE0 jour le 30/12/2025"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1,
        source: {
          titre: "Ley 10/2017 (La Rioja)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2017-13750",
          article: "art. 48",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "R\xE9duits art. 45 : 5 %/3 % familles nombreuses ; 5 % VPO (revenus) ; 4 % 1re vivienda habitual <40 ans (3 % communes annexe I) ; 5 % handicap \u226533 %. AJD 0,1 % art. 49.",
      statut: "COMPLET"
    },
    "community-of-madrid": {
      nom_en: "Community of Madrid",
      nom_es: "Comunidad de Madrid",
      regime: "commun",
      itp: {
        type: "flat",
        taux: 6,
        source: {
          titre: "Decreto Legislativo 1/2010, texto refundido tributos cedidos de la Comunidad de Madrid",
          url: "https://www.boe.es/buscar/act.php?id=BOCM-m-2010-90068",
          article: "art. 28",
          consulte: "2026-10-15"
        },
        vigueur: "2014-01-01",
        derniere_modification: "Ley 6/2013 ; texte consolid\xE9 mis \xE0 jour le 10/07/2026"
      },
      ajd_neuf: {
        type: "brackets",
        mode: "single_rate_by_value_with_smoothing",
        tranches: [
          {
            jusqu_a: 12e4,
            taux: 0.4
          },
          {
            jusqu_a: 18e4,
            taux: 0.5
          },
          {
            jusqu_a: null,
            taux: 0.75
          }
        ],
        applicable_a: "acqu\xE9reur personne physique (art. 32.1) ; sinon 0,75 % (art. 36)",
        lissage: "art. 37 : si une hausse de base entra\xEEne une hausse de cuota sup\xE9rieure \xE0 cette hausse, la cuota est r\xE9duite de l'exc\xE9dent",
        source: {
          titre: "Decreto Legislativo 1/2010 (Madrid)",
          url: "https://www.boe.es/buscar/act.php?id=BOCM-m-2010-90068",
          article: "art. 32.1.b)-d), art. 36, art. 37",
          consulte: "2026-10-15"
        }
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "ITP : 4 % familles nombreuses (art. 29) ; bonification 10 % de la cuota vivienda habitual \u2264250 000 \u20AC (art. 30 bis ; 100 % <35 ans en commune <2 500 hab.). AJD : m\xEAme bonification (art. 38 bis) ; 0,2 % VPP \u226490 m\xB2 (art. 32.1.a).",
      statut: "COMPLET"
    },
    murcia: {
      nom_en: "Region of Murcia",
      nom_es: "Regi\xF3n de Murcia",
      regime: "commun",
      itp: {
        type: "flat",
        taux: 7.75,
        source: {
          titre: "Decreto Legislativo 1/2010, texto refundido tributos cedidos de la Regi\xF3n de Murcia",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2011-10542",
          article: "art. 6.1",
          consulte: "2026-10-15"
        },
        vigueur: "2025-07-25",
        derniere_modification: "Ley 3/2025, de 23 de julio (art. 55.14)"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.5,
        source: {
          titre: "Decreto Legislativo 1/2010 (Murcia)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-2011-10542",
          article: "art. 7.1",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "R\xE9duits : 4 % VPO r\xE9gimen especial ; 3 % familles nombreuses, \u226440 ans (revenus <40 000 \u20AC), handicap \u226565 % (art. 6.5, 6.6, 6.9). AJD 0,1 % m\xEAmes publics (art. 7.4-7.6).",
      statut: "COMPLET"
    },
    "valencian-community": {
      nom_en: "Valencian Community",
      nom_es: "Comunitat Valenciana",
      regime: "commun",
      itp: {
        type: "brackets",
        mode: "single_rate_by_value",
        tranches: [
          {
            jusqu_a: 1e6,
            taux: 9
          },
          {
            jusqu_a: null,
            taux: 11
          }
        ],
        source: {
          titre: "Ley 13/1997, de 23 de diciembre, tramo auton\xF3mico del IRPF y restantes tributos cedidos (Comunitat Valenciana)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1998-8202",
          article: "art. 13.Uno",
          consulte: "2026-10-15"
        },
        vigueur: "2026-06-01",
        derniere_modification: "Ley 5/2025, de 30 de mayo, art. 33 (faits g\xE9n\xE9rateurs \xE0 partir du 01/06/2026) ; art. 13 derni\xE8re mise \xE0 jour 10/08/2026 (Ley 5/2026, apartado seis)"
      },
      ajd_neuf: {
        type: "flat",
        taux: 1.4,
        source: {
          titre: "Ley 13/1997 (Comunitat Valenciana)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1998-8202",
          article: "art. 14.Cuatro",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null,
        taux_vivienda_habitual: 0.1,
        source_vivienda_habitual: {
          titre: "Ley 13/1997, as amended by Ley 5/2026, de 31 de julio (in force 11/08/2026)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1998-8202",
          article: "art. 14.Uno.a)",
          consulte: "2026-10-15"
        }
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Art. 91 modifi\xE9 par RDL 29/2026 (6 oct. 2026, en vigueur 8 oct. 2026, en attente de convalidation au 15 oct.) avec effet au 1er d\xE9c. 2026 sur Uno.2.2\xBA, Uno.2.10\xBA et Dos.1.6\xBA ; le 10 % du logement (Uno.1.7\xBA) n'est pas touch\xE9."
      },
      note: "ITP : 11 % sur la totalit\xE9 si la valeur d\xE9passe 1 000 000 \u20AC (\xAB el tipo aplicable ser\xE1 el 11 % \xBB). R\xE9duits : 8 %/6 % <35 ans et VPO selon 180 000 \u20AC ; 4 % et 3 % (art. 13.Cuatro et Cinco). AJD : 1,4 % depuis le 01/06/2026 ; 0,1 % pour toute acquisition de vivienda habitual depuis le 11/08/2026.",
      statut: "COMPLET"
    },
    navarre: {
      nom_en: "Navarre",
      nom_es: "Comunidad Foral de Navarra",
      regime: "foral",
      itp: {
        type: "flat",
        taux: 6,
        source: {
          titre: "Decreto Foral Legislativo 129/1999, texto refundido ITPAJD (Navarra)",
          url: "https://www.boe.es/buscar/act.php?id=BON-n-1999-90001",
          article: "art. 8.1.a)",
          consulte: "2026-10-15"
        },
        vigueur: "2001-01-01",
        derniere_modification: "art. 8 derni\xE8re mise \xE0 jour 29/12/2023 (Ley Foral 22/2023, apartado 1.b.2\xBA) ; texte consolid\xE9 mis \xE0 jour le 20/04/2026"
      },
      ajd_neuf: {
        type: "flat",
        taux: 0.5,
        source: {
          titre: "Decreto Foral Legislativo 129/1999 (Navarra)",
          url: "https://www.boe.es/buscar/act.php?id=BON-n-1999-90001",
          article: "art. 22.2",
          consulte: "2026-10-15"
        },
        vigueur: null,
        derniere_modification: null
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Convenio Econ\xF3mico (Ley 28/1990, art. 32) : Navarre applique les m\xEAmes normes substantielles que l'\xC9tat (lu). Taux d'IVA de l'\xC9tat."
      },
      note: "R\xE9gime foral : base = \xAB valor real \xBB (art. 7), pas la valeur de r\xE9f\xE9rence du Catastro d'\xC9tat. R\xE9duits : 5 % familles avec \u22652 enfants sur 180 304 \u20AC max ; 4 % communes en risque de d\xE9peuplement (art. 8.1.b).",
      statut: "COMPLET"
    },
    "basque-country": {
      nom_en: "Basque Country",
      nom_es: "Pa\xEDs Vasco / Euskadi",
      regime: "foral",
      itp: {
        type: "flat",
        taux: 4,
        applicable_a: "transmission de logements (viviendas) ; 7 % pour les autres immeubles",
        condition: "l'acqu\xE9reur ne doit pas d\xE9tenir plus de 5 logements \xE0 plus de 50 % (d\xE9claration responsable), sinon 6 %",
        sources: [
          {
            territoire: "\xC1lava/Araba",
            titre: "Norma Foral 11/2003, del ITPAJD (updated text published by the Diputaci\xF3n Foral de \xC1lava, including DNUF 2/2026)",
            url: "https://web.araba.eus/documents/d/araba/indice_norma-foral-itp-ajd-cas-2-pdf",
            article: "art. 43.Uno.b) (4%); art. 56.2 (AJD 0.5%)",
            consulte: "2026-10-15"
          },
          {
            territoire: "Bizkaia",
            titre: "Norma Foral 1/2011, del ITPAJD (consolidated text Diputaci\xF3n Foral de Bizkaia, \xAB \xDAltima modificaci\xF3n normativa: 20/04/2026 \xBB)",
            url: "https://www.bizkaia.eus/documents/880307/15187815/ca_1_2011.pdf/50b78491-3852-b68f-f9d5-2db574a48917?t=1746431731226",
            article: "art. 13.b) (4%); art. 44.1 (AJD 0.50%)",
            consulte: "2026-10-15"
          },
          {
            territoire: "Gipuzkoa",
            titre: "Norma Foral 18/1987, del ITPAJD (\xAB Texto vigente \xBB, unofficial information copy of the Diputaci\xF3n Foral de Gipuzkoa, including DF-Norma 2/2026)",
            url: "https://www.gipuzkoa.eus/documents/2456431/2854433/NF+18-1987+(2025).pdf/fd85880e-c8c0-641d-eead-3869889f88ad?t=1747374492563",
            article: "art. 11.1.b) (4%); art. 29.2 (AJD 0.5%)",
            consulte: "2026-10-15"
          }
        ],
        vigueur: "voir chaque territoire",
        derniere_modification: "\xC1lava : NF 3/2025 (lettre b) ; Bizkaia : version 20/04/2026 ; Gipuzkoa : NF 1/2025 (BOG 15/05/2025)",
        source: {
          titre: "Normas forales del ITPAJD de \xC1lava (NF 11/2003), Bizkaia (NF 1/2011) y Gipuzkoa (NF 18/1987)",
          url: "https://www.euskadi.eus/impuestos-de-transmisiones-patrimoniales-y-actos-juridicos-documentados/web01-s2oga/es/",
          consulte: "2026-10-15",
          article: "\xC1lava/Araba: art. 43.Uno.b) (4%); art. 56.2 (AJD 0.5%); Bizkaia: art. 13.b) (4%); art. 44.1 (AJD 0.50%); Gipuzkoa: art. 11.1.b) (4%); art. 29.2 (AJD 0.5%)"
        }
      },
      ajd_neuf: {
        type: "flat",
        taux: 0.5,
        sources: [
          {
            territoire: "\xC1lava/Araba",
            titre: "Norma Foral 11/2003, del ITPAJD (updated text published by the Diputaci\xF3n Foral de \xC1lava, including DNUF 2/2026)",
            url: "https://web.araba.eus/documents/d/araba/indice_norma-foral-itp-ajd-cas-2-pdf",
            article: "art. 43.Uno.b) (4%); art. 56.2 (AJD 0.5%)",
            consulte: "2026-10-15"
          },
          {
            territoire: "Bizkaia",
            titre: "Norma Foral 1/2011, del ITPAJD (consolidated text Diputaci\xF3n Foral de Bizkaia, \xAB \xDAltima modificaci\xF3n normativa: 20/04/2026 \xBB)",
            url: "https://www.bizkaia.eus/documents/880307/15187815/ca_1_2011.pdf/50b78491-3852-b68f-f9d5-2db574a48917?t=1746431731226",
            article: "art. 13.b) (4%); art. 44.1 (AJD 0.50%)",
            consulte: "2026-10-15"
          },
          {
            territoire: "Gipuzkoa",
            titre: "Norma Foral 18/1987, del ITPAJD (\xAB Texto vigente \xBB, unofficial information copy of the Diputaci\xF3n Foral de Gipuzkoa, including DF-Norma 2/2026)",
            url: "https://www.gipuzkoa.eus/documents/2456431/2854433/NF+18-1987+(2025).pdf/fd85880e-c8c0-641d-eead-3869889f88ad?t=1747374492563",
            article: "art. 11.1.b) (4%); art. 29.2 (AJD 0.5%)",
            consulte: "2026-10-15"
          }
        ],
        source: {
          titre: "Normas forales del ITPAJD de \xC1lava (NF 11/2003), Bizkaia (NF 1/2011) y Gipuzkoa (NF 18/1987)",
          url: "https://www.euskadi.eus/impuestos-de-transmisiones-patrimoniales-y-actos-juridicos-documentados/web01-s2oga/es/",
          consulte: "2026-10-15",
          article: "\xC1lava/Araba: art. 43.Uno.b) (4%); art. 56.2 (AJD 0.5%); Bizkaia: art. 13.b) (4%); art. 44.1 (AJD 0.50%); Gipuzkoa: art. 11.1.b) (4%); art. 29.2 (AJD 0.5%)"
        }
      },
      iva_neuf: {
        impot: "IVA",
        taux: 10,
        taux_reduit: {
          taux: 4,
          condition: "VPO de r\xE9gimen especial o de promoci\xF3n p\xFAblica / vivienda protegida de calificaci\xF3n permanente, livr\xE9e par le promoteur (art. 91.Dos.1.6\xBA)"
        },
        source: {
          titre: "Ley 37/1992, del Impuesto sobre el Valor A\xF1adido (consolidated text)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
          article: "art. 91.Uno.1.7\xBA (10%); art. 91.Dos.1.6\xBA (4%)",
          consulte: "2026-10-15"
        },
        note: "Concierto Econ\xF3mico (Ley 12/2002, art. 26) : l'IVA est r\xE9gi par les m\xEAmes normes substantielles que l'\xC9tat (lu)."
      },
      territoires_identiques: true,
      note: "Les trois territoires ont le m\xEAme taux logement (4 %), le m\xEAme taux r\xE9duit 2,5 % (\u2264120 m\xB2 construits \u2014 Gipuzkoa : ou 96 m\xB2 utiles \u2014 ou famille nombreuse, avec vivienda habitual et pas d'autre logement >25 % dans la commune) et le m\xEAme AJD 0,5 %. \xC1lava : 1,5 % zones rurales. Base : valeur r\xE9elle / valeur minimale foral, pas la valeur de r\xE9f\xE9rence du Catastro d'\xC9tat.",
      statut: "COMPLET"
    },
    ceuta: {
      nom_en: "Ceuta",
      nom_es: "Ceuta",
      regime: "ciudad_autonoma",
      itp: {
        type: "flat",
        taux: 3,
        taux_nominal: 6,
        bonification_pct: 50,
        source: {
          titre: "Real Decreto Legislativo 1/1993 (TRLITPAJD)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1993-25359",
          article: "art. 11.1.a) (6%) and art. 57 bis.3.a) (rebate 50%)",
          consulte: "2026-10-15"
        },
        source_confirmation: {
          titre: "AEAT, Base Imponible y tipos Ceuta y Melilla",
          url: "https://sede.agenciatributaria.gob.es/Sede/declaraciones-informativas-otros-impuestos-tasas/impuesto-sobre-transmisiones-patrimoniales-actos-juridicos/itp-ajd-transmisiones-derechos-reales-fianzas/base-imponible-tipos-ceuta-melilla.html",
          article: "tableau TPO",
          consulte: "2026-10-15"
        },
        vigueur: "2003-01-01",
        derniere_modification: "art. 57 bis ajout\xE9 par Ley 53/2002 (en vigueur 01/01/2003), non modifi\xE9 depuis"
      },
      ajd_neuf: {
        type: "flat",
        taux: 0.25,
        taux_nominal: 0.5,
        bonification_pct: 50,
        source: {
          titre: "Real Decreto Legislativo 1/1993 (TRLITPAJD)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1993-25359",
          article: "art. 31.2 (0.5%) and art. 57 bis.1 (rebate 50%)",
          consulte: "2026-10-15"
        }
      },
      iva_neuf: {
        impot: "IPSI",
        taux: null,
        raison: "taux de l'IPSI sur la livraison de logements neufs fix\xE9 par l'ordonnance fiscale de la ville : texte non lu (non trouv\xE9 sur source officielle lisible)",
        source: {
          titre: "Ley 8/1991 (IPSI)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1991-7645",
          article: "art. 18.1",
          consulte: "2026-10-15"
        }
      },
      note: "Taux d'\xC9tat de repli (TRLITPAJD art. 11.1.a : 6 % ; art. 31.2 : 0,5 %), confirm\xE9s par la page AEAT \xAB Base Imponible y tipos Ceuta y Melilla \xBB (mise \xE0 jour 22/01/2026), avec bonification de 50 % de la cuota (art. 57 bis.3.a pour l'ITP ; art. 57 bis.1 pour l'AJD si le Registro est \xE0 Ceuta/Melilla). Taux effectifs : ITP 3 %, AJD 0,25 %. Logement neuf : IPSI (Ley 8/1991, art. 18 : taux fix\xE9s par ordonnance municipale entre 0,5 % et 10 %) \u2014 taux logement NON LU.",
      statut: "PARTIEL"
    },
    melilla: {
      nom_en: "Melilla",
      nom_es: "Melilla",
      regime: "ciudad_autonoma",
      itp: {
        type: "flat",
        taux: 3,
        taux_nominal: 6,
        bonification_pct: 50,
        source: {
          titre: "Real Decreto Legislativo 1/1993 (TRLITPAJD)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1993-25359",
          article: "art. 11.1.a) (6%) and art. 57 bis.3.a) (rebate 50%)",
          consulte: "2026-10-15"
        },
        source_confirmation: {
          titre: "AEAT, Base Imponible y tipos Ceuta y Melilla",
          url: "https://sede.agenciatributaria.gob.es/Sede/declaraciones-informativas-otros-impuestos-tasas/impuesto-sobre-transmisiones-patrimoniales-actos-juridicos/itp-ajd-transmisiones-derechos-reales-fianzas/base-imponible-tipos-ceuta-melilla.html",
          article: "tableau TPO",
          consulte: "2026-10-15"
        },
        vigueur: "2003-01-01",
        derniere_modification: "art. 57 bis ajout\xE9 par Ley 53/2002 (en vigueur 01/01/2003), non modifi\xE9 depuis"
      },
      ajd_neuf: {
        type: "flat",
        taux: 0.25,
        taux_nominal: 0.5,
        bonification_pct: 50,
        source: {
          titre: "Real Decreto Legislativo 1/1993 (TRLITPAJD)",
          url: "https://www.boe.es/buscar/act.php?id=BOE-A-1993-25359",
          article: "art. 31.2 (0.5%) and art. 57 bis.1 (rebate 50%)",
          consulte: "2026-10-15"
        }
      },
      iva_neuf: {
        impot: "IPSI",
        taux: 4,
        taux_reduit: {
          taux: 0.5,
          condition: "premi\xE8re transmission de logements de protection officielle par leurs promoteurs (Anexo 1, apartado TERCERO, 1\xBA)"
        },
        source: {
          titre: "Ordenanza fiscal del IPSI (operaciones interiores) de la Ciudad de Melilla, Anexo 1 (BOME n\xBA 5857, 4 mai 2021, p. 1300, Decreto n\xBA 584 du 30/04/2021)",
          url: "https://bomemelilla.es/bome/descargar/BOME-P-2021-1300.pdf",
          article: "Anexo 1, apartado TERCERO : \xAB La entrega de Bienes Inmuebles, tributar\xE1n al tipo del 4% \xBB; 0.5% pour la premi\xE8re transmission de VPO par les promoteurs",
          consulte: "2026-10-15"
        }
      },
      note: "Taux d'\xC9tat de repli (TRLITPAJD art. 11.1.a : 6 % ; art. 31.2 : 0,5 %), confirm\xE9s par la page AEAT \xAB Base Imponible y tipos Ceuta y Melilla \xBB (mise \xE0 jour 22/01/2026), avec bonification de 50 % de la cuota (art. 57 bis.3.a pour l'ITP ; art. 57 bis.1 pour l'AJD si le Registro est \xE0 Ceuta/Melilla). Taux effectifs : ITP 3 %, AJD 0,25 %. Logement neuf : IPSI \xE0 4 % sur la livraison d'immeubles (ordonnance municipale, Anexo 1 TERCERO, BOME du 4 mai 2021 ; 0,5 % pour la premi\xE8re transmission de VPO par le promoteur). Les avis BOME de 2023 et 2025 renvoient encore \xE0 ce d\xE9cret n\xB0 584/2021 ; modification ult\xE9rieure non exclue.",
      statut: "PARTIEL"
    }
  }
};

// src/lib/es/fraisAchat.ts
var FA = frais_achat_default;
var REGIONS = Object.keys(FA.regions).sort();
var r2 = (x) => Math.round(x * 100) / 100;
function marginal(v, tr) {
  let reste = v, bas = 0, cuota = 0;
  for (const t of tr) {
    const haut = t.jusqu_a ?? Infinity, part = Math.max(0, Math.min(reste, haut - bas));
    cuota += part * t.taux / 100;
    reste -= part;
    bas = haut;
    if (reste <= 0) break;
  }
  return cuota;
}
var unique = (v, tr) => (tr.find((t) => t.jusqu_a == null || v <= t.jusqu_a) ?? tr[tr.length - 1]).taux;
function lisse(v, tr) {
  let cuota = v * unique(v, tr) / 100;
  for (let i = 0; i < tr.length - 1; i++) {
    const s = tr[i].jusqu_a;
    if (v > s) cuota = Math.min(cuota, s * tr[i].taux / 100 + (v - s));
  }
  return cuota;
}
function impot(v, bloc) {
  if (bloc.type === "flat") return { taux: bloc.taux, montant: v * bloc.taux / 100 };
  const tr = bloc.tranches;
  switch (bloc.mode) {
    case "marginal": {
      const m = marginal(v, tr);
      return { taux: m / v * 100, montant: m };
    }
    // Balearic Islands: the average rate is rounded to two decimals (art. 10.b, last paragraph); Catalonia: average rate, no rounding read.
    case "marginal_average_rate": {
      let t = marginal(v, tr) / v * 100;
      if (bloc.arrondi_taux_moyen != null || /Balears/.test(bloc.source?.titre ?? "")) t = Math.round(t * 100) / 100;
      return { taux: t, montant: v * t / 100 };
    }
    case "single_rate_by_value": {
      const t = unique(v, tr);
      return { taux: t, montant: v * t / 100 };
    }
    case "single_rate_by_value_with_smoothing": {
      const m = lisse(v, tr);
      return { taux: m / v * 100, montant: m };
    }
    default:
      throw new Error(`mode inconnu : ${bloc.mode}`);
  }
}
function bareme(v, B) {
  let m = B.fixe_jusqu_a_6010_12;
  for (const t of B.tranches_pour_mille) {
    if (t.pour_mille == null || v <= t.de) continue;
    m += (Math.min(v, t.jusqu_a ?? Infinity) - t.de) * t.pour_mille / 1e3;
  }
  return m;
}
function registre(v) {
  const B = FA.national.registre;
  let m = Math.min(Math.max(bareme(v, B), B.minimum), B.maximum);
  for (const p of B.reductions_successives_pct) m *= 1 - p / 100;
  return r2(m + B.presentation_fixe);
}
function notaire(v) {
  const B = FA.national.notaire;
  return r2(bareme(v, B) * (1 - B.rebaja_pct / 100));
}
function fraisAchat(prix, region, o = {}) {
  const S = FA.regions[region];
  if (!S) throw new Error(`r\xE9gion inconnue : ${region}`);
  const type = o.type ?? "resale";
  const foral = S.regime === "foral";
  const base = foral ? prix : Math.max(prix, o.valeurRef ?? 0);
  const lignes = [];
  let minimum = false;
  if (type === "resale") {
    const x = impot(base, S.itp);
    lignes.push({ code: "itp", taux: r2(x.taux), montant: r2(x.montant) });
  } else {
    const iv = S.iva_neuf, code = (iv?.impot ?? "IVA").toLowerCase();
    if (iv?.taux != null) lignes.push({ code, taux: iv.taux, montant: r2(prix * iv.taux / 100) });
    else {
      lignes.push({ code, taux: null, montant: null });
      minimum = true;
    }
    const a = impot(base, S.ajd_neuf);
    lignes.push({ code: "ajd", taux: r2(a.taux), montant: r2(a.montant) });
  }
  const reg = registre(base);
  lignes.push({ code: "registre", taux: null, montant: reg });
  const taxe = r2(lignes.filter((l) => l.code !== "registre").reduce((t, l) => t + (l.montant ?? 0), 0));
  const total = r2(taxe + reg);
  return {
    region,
    type,
    base,
    lignes,
    taxe,
    registre: reg,
    notaire: notaire(base),
    total,
    minimum,
    foral,
    tauxEffectif: r2(taxe / prix * 100)
  };
}

// src/lib/es/pret.ts
function mensualite(capital, tauxAnnuel, annees) {
  const n = Math.round(annees * 12), r = tauxAnnuel / 12 / 100;
  if (!(capital > 0) || !(n > 0)) return NaN;
  return r === 0 ? capital / n : capital * r * (1 + r) ** n / ((1 + r) ** n - 1);
}

// src/data/es/irnr.json
var irnr_default = {
  _note: "Param\xE8tres du calculateur /spain/non-resident-tax-calculator (revenu imput\xE9 d'un logement non lou\xE9 d'un non-r\xE9sident, exercice 2026). Lu au BOE consolid\xE9 le 15 oct. 2026 (rapport ~/Payotte/espagne/rapports/phase-0/national-etrangers.md, \xA74).",
  releve: "2026-10-15",
  exercice: 2026,
  imputation: { general: 2, revise: 1.1, source: { titre: "Ley 35/2006 (IRPF), art. 85.1, applied to non-residents by art. 24.5 TRLIRNR", url: "https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764" } },
  taux: { ueEee: 19, autres: 24, source: { titre: "Real Decreto Legislativo 5/2004 (TRLIRNR), art. 25.1.a", url: "https://www.boe.es/buscar/act.php?id=BOE-A-2004-4527" } },
  aVenir: "From 1 January 2027, Real Decreto-ley 29/2026 (art. 6) replaces the 2%/1.1% rule with a scale of 1.1% to 3% on the sum of cadastral values, subject to validation by the Cortes; its application to non-residents is not settled by the texts read.",
  da55: "For 2026, Real Decreto-ley 29/2026 extends the 1.1% rate to municipalities whose values were revised from 1 January 2012 (additional provision 55 of Ley 35/2006), subject to validation by the Cortes."
};

// src/lib/es/format.ts
var LOC = { en: "en-GB", es: "es-ES" };
var eur = (n, l = "en") => new Intl.NumberFormat(LOC[l], { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Math.round(n));
var pct = (n, l = "en", d = 2) => `${n.toLocaleString(LOC[l], { maximumFractionDigits: d })}%`;

// src/lib/es/textes/en.ts
var R = "/spain";
function regle(b) {
  if (b.type === "flat") return pct(b.taux);
  const tr = b.tranches;
  const bandes = tr.map((t, i) => t.jusqu_a == null ? `${pct(t.taux)} above ${eur(tr[i - 1].jusqu_a)}` : i === 0 ? `${pct(t.taux)} up to ${eur(t.jusqu_a)}` : `${pct(t.taux)} up to ${eur(t.jusqu_a)}`).join(", ");
  return b.mode === "marginal" ? `${bandes}, each band at its own rate` : b.mode === "marginal_average_rate" ? `${bandes}: the scale gives an average rate applied to the whole value` : b.mode === "single_rate_by_value_with_smoothing" ? `${bandes}, one rate on the whole value, smoothed at each threshold` : `${bandes}, one rate on the whole value`;
}
var EN = {
  lang: "en",
  locale: "en-ES",
  pays: "Spain",
  routes: {
    accueil: R,
    calcFrais: `${R}/purchase-costs-calculator`,
    calcPret: `${R}/mortgage-calculator`,
    calcNonResident: `${R}/non-resident-tax-calculator`,
    villes: `${R}/cities`,
    region: (slug) => `${R}/regions/${slug}`,
    ville: (slug) => `${R}/cities/${slug}`,
    tableaux: `${R}/by-region`,
    tableau: (slug) => `${R}/by-region/${slug}`,
    guides: `${R}/guides`,
    guide: (slug) => `${R}/guides/${slug}`,
    metier: (slug) => `${R}/professions/${slug}`,
    inscription: `${R}/get-listed`,
    methode: `${R}/selection-method`,
    mentions: `${R}/legal-notice`,
    confidentialite: `${R}/privacy`
  },
  commun: {
    enBref: "In short",
    sources: "Sources",
    consulte: "consulted",
    verifieLe: "Checked on",
    contreSources: "against the official sources at the bottom of the page.",
    tableauDefile: "Table, scrolls horizontally",
    tousGuides: "All guides",
    accueil: "Payotte Spain",
    nonCalcule: "not computed",
    auMoins: "at least",
    calculateur: "Calculator",
    invalide: "Incomplete or invalid input."
  },
  cta: {
    aria: "For professionals",
    tag: "For professionals \xB7 free",
    titre: (trade, area) => `Be the firm Payotte selects${trade ? ` as ${trade.toLowerCase()}` : ""}${area ? ` in ${area}` : ""}`,
    places: (spots) => spots ? `${spots} spots, one per trade, all open today.` : "One spot per trade and per area, all open today.",
    placesSuite: "Once a profile is published, the spot is taken.",
    ia: "Built to be quoted by AI assistants.",
    iaSuite: "Payotte pages were cited 7,100 times by Microsoft Copilot in three months (Bing Webmaster Tools, September 2026).",
    gratuit: "Free, for good.",
    gratuitSuite: "No ads, no commission, never a paid ranking: your registration and your local track record decide.",
    bouton: "Ask for your firm's spot \u2192"
  },
  guides: {
    label: "Guide",
    titreIndex: "Guides to buying, renting and owning a home in Spain",
    descIndex: "Transfer tax, VAT, notary and registry fees, NIE, non-resident tax, mortgages, tenancies, tourist rentals and inheritance in Spain, from official sources, dated and cited.",
    subIndex: "Each guide is checked against the official sources it cites, with the date of the check.",
    plusSurTheme: (t) => `More guides on ${t.toLowerCase()}`,
    autres: "Other guides",
    brouillon: (n) => `Draft: ${n} point(s) still to source before publication.`,
    tousTheme: (n, t) => `The ${n} guides \xAB ${t} \xBB`
  },
  themes: {
    "foreign-buyers": "Foreign buyers",
    "purchase-taxes": "Purchase taxes by region",
    buying: "Buying",
    financing: "Financing",
    selling: "Selling",
    renting: "Renting",
    owning: "Owning"
  },
  metiers: {
    label: "Profession",
    nom: {
      "real-estate-agent": "Real estate agent",
      "property-valuer": "Property valuer",
      architect: "Architect",
      "mortgage-lender": "Mortgage lender",
      "property-lawyer": "Property lawyer"
    },
    titre: {
      "real-estate-agent": "Regional register where compulsory",
      "property-valuer": "Banco de Espa\xF1a register",
      architect: "Colegio membership, public register",
      "mortgage-lender": "Banco de Espa\xF1a register",
      "property-lawyer": "Bar membership (not listed)"
    }
  },
  regle,
  calc: {
    frais: {
      titre: "Purchase costs calculator for Spain",
      h2: "Calculate the taxes and fees on your purchase",
      aide: "Change any field: the amounts are recalculated instantly.",
      prix: "Purchase price",
      prixHint: "in \u20AC",
      ref: "Catastro reference value",
      refHint: "in \u20AC, optional",
      refPlaceholder: "on the Sede Electr\xF3nica del Catastro",
      region: "Region",
      type: "Type of home",
      types: { resale: "Resale home (ITP)", new: "New home from the developer (VAT + AJD)" },
      base: "Value taxed",
      itp: "Transfer tax (ITP)",
      iva: "VAT (IVA)",
      igic: "Canary Islands IGIC",
      ipsi: "IPSI (Ceuta, Melilla)",
      ajd: "Stamp duty on the deed (AJD)",
      registre: "Land registry (registration + presentation)",
      taxePct: "Taxes as a share of the price",
      total: "Buyer total (taxes + land registry)",
      notaire: "Notary's deed fee (the seller's by default)",
      nonCalcule: "not computed",
      msgIpsi: "IPSI rate on new homes in Ceuta not read at an official source: not included, the total is a lower limit.",
      msgForal: "Foral region: the tax is charged on the real value, not on the Catastro reference value.",
      msgBasque: "Basque Country: 4% applies if the buyer does not hold more than five homes (6% otherwise).",
      note: "General rates for an individual buyer. Not applied: reduced rates (young buyers, large families, disability, main home under a price cap\u2026), the 20% Catalan rate for large holders, the optional notary discount of up to 10%. Not included: notary copies and folios (they depend on the length of the deed), gestor\xEDa, valuation, mortgage costs (the AJD on the mortgage deed is paid by the lender). The notary's deed fee is shown apart: by default the seller pays the deed and the buyer the first copy (Civil Code, art. 1455), unless the contract says otherwise. The land registry fee is paid by the person in whose favour the right is registered, the buyer (Real Decreto 1427/1989, annex II, rule 8)."
    },
    pret: {
      titre: "Mortgage payment calculator for Spain",
      h2: "Calculate your monthly payment",
      aide: "Change any field: the payment is recalculated instantly.",
      capital: "Loan amount",
      capitalHint: "in \u20AC",
      taux: "Interest rate",
      tauxHint: "% a year",
      annees: "Term",
      anneesHint: "years",
      mensualite: "Monthly payment",
      interets: "Total interest",
      total: "Total repaid",
      plus1: "Payment with one more point of interest",
      pret: "Loan",
      formule: "Formula: payment = P \xD7 r \xD7 (1 + r)\u207F \xF7 ((1 + r)\u207F \u2212 1), where P is the loan, r the annual rate \xF7 12 \xF7 100 and n the number of months (repayment loan, French system). The default rate is an average across lenders published by the Banco de Espa\xF1a, not an offer: your lender sets your rate. Not included: the valuation, insurance, the costs the borrower pays (Ley 5/2019, art. 14.1.e) and changes of a variable rate during the loan."
    },
    irnr: {
      titre: "Non-resident tax calculator for a home in Spain",
      h2: "Calculate the non-resident tax on a home you do not let",
      aide: "For a home kept for your own use or empty, owned by an individual who is not resident in Spain for tax purposes.",
      valeur: "Cadastral value (valor catastral)",
      valeurHint: "in \u20AC, on your IBI bill",
      revise: "Cadastral values of the municipality revised in the last ten years (1.1% instead of 2%)",
      jours: "Days owned in 2026",
      joursHint: "1 to 365",
      part: "Your share of the home",
      partHint: "%",
      residence: "Your residence",
      residences: { other: "Outside the EU/EEA (UK, Canada, USA\u2026): 24%", eu: "EU or EEA with tax information exchange: 19%" },
      revenu: "Imputed income",
      taux: "Tax rate",
      impot: "Non-resident income tax (IRNR)",
      parJour: "Per day owned",
      note: "Imputed income = cadastral value \xD7 2% (or 1.1% where the municipality's values were revised under a general collective procedure in force in the year or the ten previous years) \xD7 days owned \xF7 365 \xD7 your share. Tax = imputed income \xD7 24% (19% for EU/EEA residents). Declared on form 210. Not covered: a let home (the rent is taxed instead), homes without a cadastral value, the 2027 scale announced by Real Decreto-ley 29/2026."
    }
  },
  zone: {
    labelVille: (region) => `City \xB7 ${region}`,
    labelRegion: "Region",
    labelVilleAutonome: "Autonomous city",
    titreVille: (n) => `Buying a home in ${n}: taxes, fees and prices`,
    titreRegion: (n) => `Buying a home in ${n}: transfer tax and prices`,
    descVille: (n, r) => `What buying a home in ${n} (${r}) costs: transfer tax or VAT at the region's official rates, land registry and notary fees, and the appraised value per m\xB2, from official sources.`,
    descRegion: (n) => `Transfer tax, VAT and stamp duty on a home in ${n} at the official rates, land registry fees, appraised values per m\xB2 and the INE house price index.`,
    sousTitre: "Taxes at the region's official rates \xB7 appraised values of the ministry \xB7 INE house price index.",
    questions: "The questions, answered",
    chiffres: "The figures",
    mesure: "Measure",
    valeur: "Value",
    source: "Source",
    villesDe: (n) => `Cities of ${n} on Payotte`,
    ailleurs: (n) => `Elsewhere in ${n}`,
    etrangers: "Buying from abroad",
    etrangersTexte: "A foreign buyer pays the same purchase taxes as a resident; what differs is the NIE, the non-resident tax every year and the 3% withholding on a later sale.",
    noteValeur: "Appraised value: the average value per m\xB2 of open-market homes valued by approved valuation companies, not a sale price. Q2 2025 to Q2 2026 change computed by Payotte from the two quarters published by the ministry."
  },
  carte: {
    titre: (n, v) => `Map of Spain: the ${n} regions by average appraised value per m\xB2, and the ${v} cities covered by Payotte`,
    legende: "Average appraised value per m\xB2, Q2 2026",
    ville: "city",
    encart: "Canary Islands (moved)",
    note: "Boundaries: Instituto Geogr\xE1fico Nacional (IGN), Unidades administrativas, CC BY 4.0 ign.es, simplified for display (about 1 km); the Canary Islands are shown in an inset. City points: GeoNames (CC BY 4.0). Not an authoritative map."
  },
  tableaux: {
    titreIndex: "Spanish property rules by region: the tables",
    descIndex: "Transfer tax, new-home taxes, reduced rates, appraised values, house price index, agent registers and stressed market areas compared across Spain's 19 regions, with data under CC BY 4.0.",
    subIndex: "Purchase taxes, many reliefs, agent registers and tenancy controls are set by each autonomous community: each table compares one rule across the 19 regions.",
    parRegion: "Region by region",
    leTableau: "The table",
    autres: "Other tables by region",
    tous: "All tables",
    region: "Region",
    tiret: "\u201C\u2014\u201D means the source read does not state it.",
    telecharger: "Download the data:",
    licence: "(CC BY 4.0, cite Payotte with a link)",
    compile: "Compiled on",
    compileSuite: "from the official texts and statistics read by Payotte, each with its source.",
    label: (n) => `By region \xB7 ${n} regions`,
    question: (h1, r) => `${h1.replace(/, by region$/, "")}: what applies in ${r}?`,
    decompte: (titre, n, total, liste) => `${titre}: ${n} of the ${total} regions${liste ? ` (${liste})` : ""}.`,
    defs: {
      "purchase-tax": {
        titre: "Property transfer tax (ITP) by region in Spain (2026)",
        h1: "Transfer tax on a resale home, by region",
        description: "The general ITP rate or scale of each Spanish region, the tax base, and the tax and land registry fees on \u20AC300,000 and \u20AC500,000.",
        colonnes: { general_rate: "General rate", regime: "Tax system", reference_value: "Catastro reference value used", tax_300k: "ITP on \u20AC300,000", total_300k: "With registry", tax_500k: "ITP on \u20AC500,000" },
        valeurs: { regime: { common: "Common", foral: "Foral" }, reference_value: { yes: "Yes", no: "No" } }
      },
      "new-home-taxes": {
        titre: "VAT, IGIC and stamp duty on new homes by region (2026)",
        h1: "Taxes on a new home, by region",
        description: "VAT (IGIC in the Canary Islands, IPSI in Ceuta and Melilla) and the stamp duty on the deed (AJD) of each region, with the total on a \u20AC300,000 new home.",
        colonnes: { indirect_tax: "Tax", indirect_rate: "Rate", ajd_rate: "AJD on the deed", total_300k: "Total on \u20AC300,000 with registry" },
        valeurs: {}
      },
      "young-buyer-rates": {
        titre: "Reduced transfer tax for young buyers by region (2026)",
        h1: "Reduced transfer tax for young buyers, by region",
        description: "Whether a young buyer of a main home pays a reduced ITP rate, the age limit, the rate and the price and income caps, region by region.",
        colonnes: { reduced_rate: "Reduced rate", age_limit: "Age", itp_rate: "Rate", price_cap: "Price cap", income_cap: "Income cap", conditions: "Conditions" },
        valeurs: { reduced_rate: { yes: "Yes", no: "No", not_read: "Not read" } }
      },
      "large-family-rates": {
        titre: "Reduced transfer tax for large families by region (2026)",
        h1: "Reduced transfer tax for large families, by region",
        description: "Whether a large family (familia numerosa) buying its main home pays a reduced ITP rate, the rate and its conditions, region by region.",
        colonnes: { reduced_rate: "Reduced rate", itp_rate: "Rate", price_cap: "Price cap", conditions: "Conditions" },
        valeurs: { reduced_rate: { yes: "Yes", no: "No", not_read: "Not read" } }
      },
      "appraised-values": {
        titre: "Home appraised values per m\xB2 by region in Spain (2026)",
        h1: "Appraised home values per m\xB2, by region",
        description: "The ministry's average appraised value of open-market homes per m\xB2 in each region, its change over a year and the dearest city covered by Payotte.",
        colonnes: { value_m2: "Value per m\xB2", change_12m: "Change over a year", dearest_city: "Dearest city on Payotte" },
        valeurs: {}
      },
      "house-price-index": {
        titre: "INE house price index by region in Spain (2026)",
        h1: "House price index, by region",
        description: "The INE house price index (IPV, base 2025) of each region and its change over a year, compared with Spain.",
        colonnes: { change_12m: "Change over a year", index: "Index (2025 = 100)", faster_than_spain: "Faster than Spain" },
        valeurs: { faster_than_spain: { yes: "Yes", no: "No" } }
      },
      "agent-registers": {
        titre: "Estate agent registers by region in Spain (2026)",
        h1: "Estate agent registers, by region",
        description: "Whether an estate agent must be entered in a regional register, the law that says so and where the reader checks, region by region.",
        colonnes: { register: "Register", law: "Law" },
        valeurs: { register: { compulsory: "Compulsory", compulsory_not_yet_set_up: "Compulsory, not yet set up", voluntary: "Voluntary", not_established: "Not established" } }
      },
      "stressed-market-areas": {
        titre: "Stressed housing market areas by region in Spain (2026)",
        h1: "Stressed housing market areas, by region",
        description: "Whether a region has declared stressed residential market areas under Ley 12/2023, how many municipalities and by which resolution, as read in the BOE.",
        colonnes: { declared: "Declared", municipalities: "Municipalities", resolution: "Resolution" },
        valeurs: { declared: { yes: "Yes", not_found: "Not found in the resolutions read" } }
      }
    }
  }
};

// src/lib/es/langue.ts
var TEXTES = { en: EN };
var LANGUES_PUBLIEES = Object.keys(TEXTES);

// src/lib/es/calculateurs.ts
function irnr(valeur, revise, jours, part, ue) {
  const taux = revise ? irnr_default.imputation.revise : irnr_default.imputation.general;
  const revenu = valeur * taux / 100 * Math.min(jours, 365) / 365 * part / 100;
  const t = ue ? irnr_default.taux.ueEee : irnr_default.taux.autres;
  return { revenu: Math.round(revenu * 100) / 100, taux: t, impot: Math.round(revenu * t) / 100 };
}
export {
  FA,
  REGIONS,
  fraisAchat,
  irnr,
  mensualite
};
