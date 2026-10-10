/** Frozen, accepted M1V2 examples, bound only to their own historical SKU catalog.
 * They never represent the current recommendation or current sellable inventory.
 * Source/version/hash metadata is retained below for independent provenance checks.
 */
export type LookExampleItem = Readonly<{
  slot: "top" | "bottom" | "shoes";
  skuId: string;
  productId: string;
  name: string;
  size: Readonly<{ system: "clothing_alpha" | "cn_shoe"; value: string }>;
  historicalPriceFen: number;
}>;

export type LookExample = Readonly<{
  lookId: string;
  title: string;
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  imageSha256: string;
  items: readonly LookExampleItem[];
}>;

export const LOOK_EXAMPLE_SOURCE = {
  "catalogVersion": "catalog_m1_v2_001",
  "lookAssetVersion": "look_assets_m1_v2_002",
  "catalogAsOf": "2026-09-05T12:00:00+08:00",
  "approvalId": "user_visual_acceptance_20260905",
  "authorizationId": "user_auth_model_reference_20260905",
  "inventorySnapshotId": "inv_m1_v2_001_20260905",
  "inventoryCapturedAt": "2026-09-05T00:00:00+08:00",
  "inventoryValidUntil": "2026-09-06T00:00:00+08:00",
  "dataClassification": "synthetic",
  "inventoryIsHistorical": true,
  "sourceHashes": {
    "look_assets.json": "5def46729835615e972d15562cdf8d821706039eebd700adbe370092fb35858c",
    "catalog.json": "1c6a3ca00e60c53112ef4d7460a92a922f6e27abedc3e942bcb46ffe987b9273",
    "inventory.json": "ebc9ca3defd095e6a8ef18bd01cd068f519ed026e02acf27fb418891e54d3cfc",
    "manifest.json": "0ab0aa95e2164819ebe5c86447f6fd9f24dd1c23a02212f7984ebd165ad0a4b3",
    "provenance/user_visual_acceptance.json": "28e26be9f098d3bd5230fd2fb9a75309e259e8091d0c678bf95e4d2c847e42bb"
  }
} as const;

export const LOOK_EXAMPLES: readonly LookExample[] = [
  {
    "lookId": "M1V2-LOOK-101",
    "title": "通勤示例 01",
    "imagePath": "/look-examples/look_101.png",
    "imageWidth": 1024,
    "imageHeight": 1536,
    "imageSha256": "5ee139730b19ebfe9d520db0dd5ad390fd6cb12a7630f8e338abe7959d18119e",
    "items": [
      {
        "slot": "top",
        "skuId": "M1V2-T101-M",
        "productId": "M1V2-P-T101",
        "name": "模拟·奶油白不对称无袖剪裁上衣",
        "size": {
          "system": "clothing_alpha",
          "value": "M"
        },
        "historicalPriceFen": 24900
      },
      {
        "slot": "bottom",
        "skuId": "M1V2-B101-M",
        "productId": "M1V2-P-B101",
        "name": "模拟·巧克力色垂坠双褶阔腿长裤",
        "size": {
          "system": "clothing_alpha",
          "value": "M"
        },
        "historicalPriceFen": 27900
      },
      {
        "slot": "shoes",
        "skuId": "M1V2-S101-38",
        "productId": "M1V2-P-S101",
        "name": "模拟·酒红细带方头低跟鞋",
        "size": {
          "system": "cn_shoe",
          "value": "38"
        },
        "historicalPriceFen": 26900
      }
    ]
  },
  {
    "lookId": "M1V2-LOOK-112",
    "title": "通勤示例 02",
    "imagePath": "/look-examples/look_112.png",
    "imageWidth": 1024,
    "imageHeight": 1536,
    "imageSha256": "5c45d7fac17197ae521f9311b4c4f0bc695e88a32df11d8184783c5ff1ea361b",
    "items": [
      {
        "slot": "top",
        "skuId": "M1V2-T102-M",
        "productId": "M1V2-P-T102",
        "name": "模拟·蓝白细条纹廓形短袖衬衫",
        "size": {
          "system": "clothing_alpha",
          "value": "M"
        },
        "historicalPriceFen": 22900
      },
      {
        "slot": "bottom",
        "skuId": "M1V2-B102-M",
        "productId": "M1V2-P-B102",
        "name": "模拟·本白弧线廓形长牛仔裤",
        "size": {
          "system": "clothing_alpha",
          "value": "M"
        },
        "historicalPriceFen": 25900
      },
      {
        "slot": "shoes",
        "skuId": "M1V2-S101-38",
        "productId": "M1V2-P-S101",
        "name": "模拟·酒红细带方头低跟鞋",
        "size": {
          "system": "cn_shoe",
          "value": "38"
        },
        "historicalPriceFen": 26900
      }
    ]
  },
  {
    "lookId": "M1V2-LOOK-113",
    "title": "通勤示例 03",
    "imagePath": "/look-examples/look_113.png",
    "imageWidth": 1024,
    "imageHeight": 1536,
    "imageSha256": "b234da92a52b85035022f6c0c8de29d944124d3e9ac8b0ccb98b69f7ffd2cb10",
    "items": [
      {
        "slot": "top",
        "skuId": "M1V2-T102-M",
        "productId": "M1V2-P-T102",
        "name": "模拟·蓝白细条纹廓形短袖衬衫",
        "size": {
          "system": "clothing_alpha",
          "value": "M"
        },
        "historicalPriceFen": 22900
      },
      {
        "slot": "bottom",
        "skuId": "M1V2-B102-M",
        "productId": "M1V2-P-B102",
        "name": "模拟·本白弧线廓形长牛仔裤",
        "size": {
          "system": "clothing_alpha",
          "value": "M"
        },
        "historicalPriceFen": 25900
      },
      {
        "slot": "shoes",
        "skuId": "M1V2-S102-38",
        "productId": "M1V2-P-S102",
        "name": "模拟·象牙白薄底系带休闲鞋",
        "size": {
          "system": "cn_shoe",
          "value": "38"
        },
        "historicalPriceFen": 24900
      }
    ]
  },
  {
    "lookId": "M1V2-LOOK-116",
    "title": "通勤示例 04",
    "imagePath": "/look-examples/look_116.png",
    "imageWidth": 1024,
    "imageHeight": 1536,
    "imageSha256": "bcdf516c2078ada1c04780c922bcc26a77f64fd57f1b987ea39fcc08d3c63772",
    "items": [
      {
        "slot": "top",
        "skuId": "M1V2-T102-M",
        "productId": "M1V2-P-T102",
        "name": "模拟·蓝白细条纹廓形短袖衬衫",
        "size": {
          "system": "clothing_alpha",
          "value": "M"
        },
        "historicalPriceFen": 22900
      },
      {
        "slot": "bottom",
        "skuId": "M1V2-B101-M",
        "productId": "M1V2-P-B101",
        "name": "模拟·巧克力色垂坠双褶阔腿长裤",
        "size": {
          "system": "clothing_alpha",
          "value": "M"
        },
        "historicalPriceFen": 27900
      },
      {
        "slot": "shoes",
        "skuId": "M1V2-S101-38",
        "productId": "M1V2-P-S101",
        "name": "模拟·酒红细带方头低跟鞋",
        "size": {
          "system": "cn_shoe",
          "value": "38"
        },
        "historicalPriceFen": 26900
      }
    ]
  }
];
