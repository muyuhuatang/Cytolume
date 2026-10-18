/*
 * Cytolume body-map (reflection-8) - SYNTHETIC cell-type -> HRA body-node mapping.
 *
 * ============================ SYNTHETIC DATA ==============================
 * The 48 CL_label cell types in the current spine are PLACEHOLDERS
 * ("CL:0000000_type00" .. "type47"); they carry no real anatomy. So this file
 * INVENTS a plausible cell-type -> organ assignment purely to demo the body
 * panel: clicking a cell flies the HRA 3D body to "where that type lives".
 *
 * The rui_location objects below, however, are REAL, valid CCF SpatialEntity
 * registrations pulled from the public HRA GTEx tissue-block dataset
 * (apps.humanatlas.io/api/v1/gtex/rui_locations.jsonld) - one representative
 * block per organ, each targeting a Visible-Human reference organ
 * (ccf.owl#VHF...). They are what <ccf-body-ui-wc> consumes as `data`, and
 * highlightID/zoomToID reference each block by its `id`.
 *
 * TODO(real-data): replace the assignment with a real per-cell organ + CCF
 * rui_location join from the HRA .h5ad (obs: organ / anatomical_structure /
 * rui_location). See ../../../doc/data-request.md and ../../../doc/reflection-8-body-panel.md.
 * The predecessor dataset is LUNG, so lung is intentionally the dominant organ.
 * ==========================================================================
 */

/** A CCF SpatialEntity registration (JSON-LD). Shape per HRA EMBEDDING guide. */
export interface RuiLocation {
  "@context": string;
  "@id": string;
  "@type": "SpatialEntity";
  ccf_annotations: string[];
  dimension_units: string;
  x_dimension: number;
  y_dimension: number;
  z_dimension: number;
  placement: {
    "@context": string;
    "@id": string;
    "@type": "SpatialPlacement";
    source: string;
    target: string;
    rotation_order: string;
    rotation_units: string;
    scaling_units: string;
    translation_units: string;
    x_rotation: number; y_rotation: number; z_rotation: number;
    x_scaling: number; y_scaling: number; z_scaling: number;
    x_translation: number; y_translation: number; z_translation: number;
  };
}

/** One body node = a data item fed to <ccf-body-ui-wc> (id + its registration). */
export interface BodyNode {
  /** Stable id; doubles as the <ccf-body-ui-wc> data-item id + highlight/zoom id. */
  id: string;
  /** Human-readable organ name (shown in the panel caption). */
  label: string;
  rui_location: RuiLocation;
}

/** The synthetic body nodes - one representative HRA block per organ. */
export const BODY_NODES: BodyNode[] = [
  {
    id: "lung",
    label: "Lung",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-lung",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0002048",
            "http://purl.obolibrary.org/obo/UBERON_0002185",
            "http://purl.obolibrary.org/obo/UBERON_0003406"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 10,
        "y_dimension": 10,
        "z_dimension": 10,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-lung_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-lung",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFLung",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": 0,
            "y_rotation": 0,
            "z_rotation": 0,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 183.956,
            "y_translation": 197.605,
            "z_translation": 71.67
        }
    },
  },
  {
    id: "heart",
    label: "Heart",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-heart",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0000948",
            "http://purl.obolibrary.org/obo/UBERON_0002084",
            "http://purl.obolibrary.org/obo/UBERON_0013702"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 10,
        "y_dimension": 10,
        "z_dimension": 8,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-heart_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-heart",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFHeart",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": -32,
            "y_rotation": 55,
            "z_rotation": 38,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 149.806,
            "y_translation": 40.112,
            "z_translation": 80.223
        }
    },
  },
  {
    id: "liver",
    label: "Liver",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-liver",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0001114",
            "http://purl.org/sig/ont/fma/fma15729"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 10,
        "y_dimension": 10,
        "z_dimension": 7,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-liver_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-liver",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFLiver",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": 0,
            "y_rotation": 0,
            "z_rotation": 0,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 59.038,
            "y_translation": 134.762,
            "z_translation": 101.244
        }
    },
  },
  {
    id: "kidney",
    label: "Kidney",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-kidney",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0000362",
            "http://purl.obolibrary.org/obo/UBERON_0001225",
            "http://purl.obolibrary.org/obo/UBERON_0001284",
            "http://purl.obolibrary.org/obo/UBERON_0002015",
            "http://purl.obolibrary.org/obo/UBERON_0002189",
            "http://purl.obolibrary.org/obo/UBERON_0004200"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 20,
        "y_dimension": 10,
        "z_dimension": 4,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-kidney_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-kidney",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFLeftKidney",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": -50,
            "y_rotation": 6,
            "z_rotation": 82,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 20.254,
            "y_translation": 102.631,
            "z_translation": 40.782
        }
    },
  },
  {
    id: "spleen",
    label: "Spleen",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-spleen",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0001248",
            "http://purl.org/sig/ont/fma/fma15828",
            "http://purl.org/sig/ont/fma/fma15837"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 10,
        "y_dimension": 10,
        "z_dimension": 8,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-spleen_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-spleen",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFSpleen",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": 0,
            "y_rotation": 0,
            "z_rotation": 48,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 57.678,
            "y_translation": 51.661,
            "z_translation": 37.735
        }
    },
  },
  {
    id: "pancreas",
    label: "Pancreas",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-pancreas",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0001069",
            "http://purl.obolibrary.org/obo/UBERON_0001150",
            "http://purl.org/sig/ont/fma/fma14517"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 10,
        "y_dimension": 10,
        "z_dimension": 7,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-pancreas_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-pancreas",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFPancreas",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": 0,
            "y_rotation": 0,
            "z_rotation": -13,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 68.55,
            "y_translation": 40.634,
            "z_translation": 62.717
        }
    },
  },
  {
    id: "colon",
    label: "Colon",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-colon",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0001157"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 10,
        "y_dimension": 10,
        "z_dimension": 4,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-colon_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-colon",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFColon",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": -32,
            "y_rotation": 9,
            "z_rotation": -1,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 121.557,
            "y_translation": 201.87,
            "z_translation": 180.201
        }
    },
  },
  {
    id: "small-intestine",
    label: "Small intestine",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-small-intestine",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0002116",
            "http://purl.org/sig/ont/fma/fma14966"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 6,
        "y_dimension": 6,
        "z_dimension": 2,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-small-intestine_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-small-intestine",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFSmallIntestine",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": 0,
            "y_rotation": 0,
            "z_rotation": 0,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 16.348,
            "y_translation": 67.85,
            "z_translation": 42.23
        }
    },
  },
  {
    id: "skin",
    label: "Skin",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-skin",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0002097"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 20,
        "y_dimension": 10,
        "z_dimension": 5,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-skin_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-skin",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFSkinV1.1",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": 0,
            "y_rotation": -44,
            "z_rotation": 0,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 530.092,
            "y_translation": 721.462,
            "z_translation": 221.009
        }
    },
  },
  {
    id: "blood-vasculature",
    label: "Blood vasculature",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-blood-vasculature",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0001626"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 2,
        "y_dimension": 2,
        "z_dimension": 2,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-blood-vasculature_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-blood-vasculature",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFBloodVasculature",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": 0,
            "y_rotation": 4,
            "z_rotation": 34,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 113.174,
            "y_translation": 494.659,
            "z_translation": 91.963
        }
    },
  },
  {
    id: "uterus",
    label: "Uterus",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-uterus",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.org/sig/ont/fma/fma17561",
            "http://purl.org/sig/ont/fma/fma224876",
            "http://purl.org/sig/ont/fma/fma224878"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 20,
        "y_dimension": 10,
        "z_dimension": 3,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-uterus_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-uterus",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFUterus",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": -38,
            "y_rotation": 0,
            "z_rotation": 0,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 26.774,
            "y_translation": 39.166,
            "z_translation": 50.848
        }
    },
  },
  {
    id: "mammary-gland",
    label: "Mammary gland",
    rui_location: {
        "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
        "@id": "http://purl.org/ccf/1.5/cytolume-mammary-gland",
        "@type": "SpatialEntity",
        "ccf_annotations": [
            "http://purl.obolibrary.org/obo/UBERON_0018140",
            "http://purl.org/sig/ont/fma/fma58088",
            "http://purl.org/sig/ont/fma/fma73118",
            "http://purl.org/sig/ont/fma/fma73165",
            "http://purl.org/sig/ont/fma/fma62102"
        ],
        "dimension_units": "millimeter",
        "x_dimension": 10,
        "y_dimension": 10,
        "z_dimension": 4,
        "placement": {
            "@context": "https://hubmapconsortium.github.io/ccf-ontology/ccf-context.jsonld",
            "@id": "http://purl.org/ccf/1.5/cytolume-mammary-gland_placement",
            "@type": "SpatialPlacement",
            "source": "http://purl.org/ccf/1.5/cytolume-mammary-gland",
            "target": "http://purl.org/ccf/latest/ccf.owl#VHFRightMammaryGland",
            "rotation_order": "XYZ",
            "rotation_units": "degree",
            "scaling_units": "ratio",
            "translation_units": "millimeter",
            "x_rotation": 0,
            "y_rotation": 0,
            "z_rotation": 0,
            "x_scaling": 1,
            "y_scaling": 1,
            "z_scaling": 1,
            "x_translation": 39.809,
            "y_translation": 46.002,
            "z_translation": 93.095
        }
    },
  },
];

/** The `data` array assigned to <ccf-body-ui-wc>.data (id + rui_location). */
export const BODY_DATA: Array<{ id: string; rui_location: RuiLocation }> =
  BODY_NODES.map((n) => ({ id: n.id, rui_location: n.rui_location }));

/*
 * ===================== MODERN HRA REFERENCE-ORGAN IRIs =====================
 * The legacy `ccf.owl#VHF*` placement targets above no longer resolve against
 * the live HRA API (apps.humanatlas.io/api/v1/reference-organs) — its reference
 * organs are now `purl.humanatlas.io/ref-organ/<organ>-<sex>/<ver>#primary`.
 * Feeding a SINGLE such target makes <ccf-body-ui-wc> render exactly that
 * organ's GLB via /v1/reference-organ-scene — a CLEAN scene with NO registered
 * tissue-block clutter (the multi-target /v1/scene path injects ~2600 blocks).
 *
 * The whole-body silhouette is the SKIN reference organ (a translucent
 * full-body envelope GLB). Each body node maps to its own reference organ so a
 * selection can fly to / show that organ. All female variants, to match the
 * female skin envelope used for the resting body. (Proven in reflection-8 spike.)
 * ==========================================================================
 */

/**
 * Body sex — selects which HRA reference organs + skin envelope the panel shows.
 * Today it is a manual toggle in the body panel (default female, to match the
 * synthetic stand-in's resting body).
 * TODO(real-data): drive this from the real per-cell / per-donor sex once the
 * `.h5ad` lands (an `obs` sex/gender column) — see ../../../doc/data-request.md — so
 * each cell's body shows its donor's actual sex instead of a manual pick.
 */
export type BodySex = "female" | "male";

/** The whole-body silhouette per sex: the SKIN reference organ (translucent envelope).
 *  Verified live 2026-06-28 (note skin is female v1.5 BUT male v1.4 — versions differ
 *  per organ across sexes, straight from apps.humanatlas.io/api/v1/reference-organs). */
export const REFERENCE_BODY_IRI_BY_SEX: Record<BodySex, string> = {
  female: "https://purl.humanatlas.io/ref-organ/skin-female/v1.5#primary",
  male: "https://purl.humanatlas.io/ref-organ/skin-male/v1.4#primary",
};
/** The female skin envelope — kept as the default body (back-compat). */
export const REFERENCE_BODY_IRI = REFERENCE_BODY_IRI_BY_SEX.female;
/** The whole-body silhouette IRI for `sex` (falls back to female). */
export function referenceBodyIri(sex: BodySex): string {
  return REFERENCE_BODY_IRI_BY_SEX[sex] ?? REFERENCE_BODY_IRI_BY_SEX.female;
}

/** node id → FEMALE HRA reference-organ IRI, resolved live from the API. */
export const REFERENCE_ORGAN_IRI: Record<string, string> = {
  skin: "https://purl.humanatlas.io/ref-organ/skin-female/v1.5#primary",
  heart: "https://purl.humanatlas.io/ref-organ/heart-female/v1.3#primary",
  lung: "https://purl.humanatlas.io/ref-organ/lung-female/v1.4#primary",
  liver: "https://purl.humanatlas.io/ref-organ/liver-female/v1.2#primary",
  kidney: "https://purl.humanatlas.io/ref-organ/kidney-female-left/v1.3#primary",
  spleen: "https://purl.humanatlas.io/ref-organ/spleen-female/v1.3#primary",
  pancreas: "https://purl.humanatlas.io/ref-organ/pancreas-female/v1.3#primary",
  colon: "https://purl.humanatlas.io/ref-organ/large-intestine-female/v1.3#primary",
  "small-intestine": "https://purl.humanatlas.io/ref-organ/small-intestine-female/v1.2#primary",
  "blood-vasculature": "https://purl.humanatlas.io/ref-organ/blood-vasculature-female/v1.3#primary",
  uterus: "https://purl.humanatlas.io/ref-organ/uterus-female/v1.2#primary",
  "mammary-gland": "https://purl.humanatlas.io/ref-organ/mammary-gland-female-left/v1.1#primary",
};

/** node id → MALE HRA reference-organ IRI. `uterus` and `mammary-gland` are
 *  FEMALE-SPECIFIC (no male reference organ exists in HRA), so they are absent
 *  here → referenceOrganIri(node,"male") returns null and the panel falls back to
 *  the male silhouette for those cells. Every IRI below was verified live (its GLB
 *  asset returned HTTP 200) on 2026-06-28. */
export const REFERENCE_ORGAN_IRI_MALE: Record<string, string> = {
  skin: "https://purl.humanatlas.io/ref-organ/skin-male/v1.4#primary",
  heart: "https://purl.humanatlas.io/ref-organ/heart-male/v1.3#primary",
  lung: "https://purl.humanatlas.io/ref-organ/lung-male/v1.4#primary",
  liver: "https://purl.humanatlas.io/ref-organ/liver-male/v1.2#primary",
  kidney: "https://purl.humanatlas.io/ref-organ/kidney-male-left/v1.3#primary",
  spleen: "https://purl.humanatlas.io/ref-organ/spleen-male/v1.3#primary",
  pancreas: "https://purl.humanatlas.io/ref-organ/pancreas-male/v1.3#primary",
  colon: "https://purl.humanatlas.io/ref-organ/large-intestine-male/v1.3#primary",
  "small-intestine": "https://purl.humanatlas.io/ref-organ/small-intestine-male/v1.2#primary",
  "blood-vasculature": "https://purl.humanatlas.io/ref-organ/blood-vasculature-male/v1.3#primary",
};

/** The reference-organ IRI a body node resolves to for `sex` (null = none for that
 *  sex — e.g. uterus / mammary-gland have no male variant; the caller then shows
 *  the whole-body silhouette instead of an organ). */
export function referenceOrganIri(nodeId: string, sex: BodySex = "female"): string | null {
  const map = sex === "male" ? REFERENCE_ORGAN_IRI_MALE : REFERENCE_ORGAN_IRI;
  return map[nodeId] ?? null;
}

/*
 * Per-organ FRAME SIZE (mm) for the body panel's "Organ" view. The panel feeds
 * <ccf-body-ui-wc> a single data item placed at the origin and points zoomToID at
 * it; the component frames that item's bounding cube. A 10 mm cube (the default)
 * zooms so tight it lands INSIDE a large organ (e.g. the lung renders blank), so
 * organ mode sizes the cube to roughly the organ's real extent — big organs get a
 * big cube (camera pulls back to fit), small organs a small cube (camera moves in)
 * — so every organ lands at a similar, readable size. Tuned by eye against the
 * female reference-organ GLBs (reflection-8). Unknown → ORGAN_FRAME_DEFAULT.
 */
export const ORGAN_FRAME_DEFAULT = 200;
export const ORGAN_FRAME_MM: Record<string, number> = {
  lung: 250,
  heart: 150,
  liver: 230,
  kidney: 130,
  spleen: 140,
  pancreas: 190,
  colon: 260,
  "small-intestine": 240,
  skin: 700, // the whole-body skin envelope
  "blood-vasculature": 500, // the whole-body vascular tree
  uterus: 120,
  "mammary-gland": 160,
};

/** The frame-cube size (mm) to use when showing `nodeId` on its own in organ mode. */
export function organFrameMm(nodeId: string): number {
  return ORGAN_FRAME_MM[nodeId] ?? ORGAN_FRAME_DEFAULT;
}

/** Fast lookup: node id -> label. */
const NODE_LABEL = new Map(BODY_NODES.map((n) => [n.id, n.label] as const));
export function bodyNodeLabel(id: string): string | undefined {
  return NODE_LABEL.get(id);
}

/*
 * SYNTHETIC assignment: cell-type index (0..47) -> body-node id. Lung-dominant
 * because the predecessor dataset is lung; the rest spread across organs so the
 * demo body lights up in varied places. Indexed by the trailing number in a
 * CL_label name ("CL:0000007_type07" -> 7) or the raw category index.
 */
const CELL_TYPE_NODE: string[] = [
  "lung", // type00
  "lung", // type01
  "lung", // type02
  "lung", // type03
  "lung", // type04
  "lung", // type05
  "lung", // type06
  "lung", // type07
  "lung", // type08
  "lung", // type09
  "lung", // type10
  "lung", // type11
  "lung", // type12
  "lung", // type13
  "lung", // type14
  "lung", // type15
  "heart", // type16
  "heart", // type17
  "heart", // type18
  "heart", // type19
  "liver", // type20
  "liver", // type21
  "liver", // type22
  "liver", // type23
  "kidney", // type24
  "kidney", // type25
  "kidney", // type26
  "kidney", // type27
  "spleen", // type28
  "spleen", // type29
  "spleen", // type30
  "pancreas", // type31
  "pancreas", // type32
  "pancreas", // type33
  "colon", // type34
  "colon", // type35
  "colon", // type36
  "small-intestine", // type37
  "small-intestine", // type38
  "small-intestine", // type39
  "skin", // type40
  "skin", // type41
  "skin", // type42
  "blood-vasculature", // type43
  "blood-vasculature", // type44
  "uterus", // type45
  "uterus", // type46
  "mammary-gland", // type47
];

/** Parse the cell-type index from a CL_label name or a raw numeric category. */
function cellTypeIndex(cellType: string | undefined): number {
  if (!cellType) return -1;
  // "CL:0000007_type07" -> 7 ; "type07" -> 7 ; "7" -> 7.
  const m = cellType.match(/type(\d+)/i) ?? cellType.match(/(\d+)\s*$/);
  if (!m) return -1;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Map a cell type (the CL_label name from source.getCell, or a raw category
 * index) to its synthetic body-node id. Returns null when it can't be mapped
 * (caller should then leave the body unchanged). SYNTHETIC - see file header.
 */
export function bodyNodeForCellType(cellType: string | undefined): string | null {
  const idx = cellTypeIndex(cellType);
  if (idx < 0) return null;
  return CELL_TYPE_NODE[idx % CELL_TYPE_NODE.length] ?? null;
}
