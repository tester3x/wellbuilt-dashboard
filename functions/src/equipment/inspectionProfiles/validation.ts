import * as httpsV2 from 'firebase-functions/v2/https';

const fail = (message: string): never => { throw new httpsV2.HttpsError('invalid-argument', message); };
const id = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return fail(`Invalid ${label}`);
  return value;
};
const label = (value: unknown, name: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) return fail(`Invalid ${name}`);
  return value.trim();
};
const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`Invalid ${name}`);
  return value as Record<string, unknown>;
};
const array = (value: unknown, name: string, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) return fail(`Invalid ${name}`);
  return value;
};
const onlyKeys = (value: Record<string, unknown>, allowed: string[], name: string) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`Unsupported ${name} field`);
};

export type ImageRef = { imageId: string; storagePath: string; sha256: string; byteLength: number; contentType: 'image/jpeg' | 'image/png' };
export type ProfileManifest = {
  schemaVersion: 1; profileId: string; revision: string; title: string; equipmentType: string;
  source: 'wellbuilt' | 'company'; supportedModes: ('truck_only' | 'tractor_tanker')[];
  catalog: { catalogId: string; version: string; label?: string; areas: Array<{
    areaId: string; label: string; assetRole: 'truck' | 'trailer'; sortOrder: number;
    items: Array<{ itemId: string; componentLabel: string; description?: string; legacyCategoryId?: string; federalCategoryIds?: string[] }>;
  }> };
  areaImages: Record<string, string>; images: ImageRef[];
};

export function safeId(value: unknown, name: string): string { return id(value, name); }
export function safeText(value: unknown, name: string, max?: number): string { return label(value, name, max); }
export function validateImageBytes(bytes: Buffer, contentType: string): void {
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if ((contentType === 'image/jpeg' && !jpeg) || (contentType === 'image/png' && !png) || (contentType !== 'image/jpeg' && contentType !== 'image/png')) fail('Invalid image bytes');
}

export function validateManifest(input: unknown, options: { ownerCompanyId?: string; published?: boolean } = {}): ProfileManifest {
  const m = object(input, 'manifest');
  onlyKeys(m, ['schemaVersion', 'profileId', 'revision', 'title', 'equipmentType', 'source', 'supportedModes', 'catalog', 'areaImages', 'images'], 'manifest');
  if (m.schemaVersion !== 1) fail('Unsupported schemaVersion');
  const profileId = id(m.profileId, 'profileId');
  const revision = id(m.revision, 'revision');
  label(m.title, 'title');
  id(m.equipmentType, 'equipmentType');
  if (m.source !== 'wellbuilt' && m.source !== 'company') fail('Invalid source');
  if (options.ownerCompanyId && m.source !== 'company') fail('Company draft must have company source');
  const modes = array(m.supportedModes, 'supportedModes', 2);
  if (!modes.length || new Set(modes).size !== modes.length || modes.some(mode => mode !== 'truck_only' && mode !== 'tractor_tanker')) fail('Invalid supportedModes');
  const catalog = object(m.catalog, 'catalog');
  onlyKeys(catalog, ['catalogId', 'version', 'label', 'areas'], 'catalog');
  if (catalog.catalogId !== profileId || catalog.version !== revision) fail('Catalog identity mismatch');
  if (catalog.label !== undefined) label(catalog.label, 'catalog.label');
  const areas = array(catalog.areas, 'areas', 100);
  if (!areas.length) fail('At least one area required');
  const areaIds = new Set<string>();
  const orders = new Set<number>();
  let totalItems = 0;
  for (const entry of areas) {
    const area = object(entry, 'area');
    onlyKeys(area, ['areaId', 'label', 'assetRole', 'sortOrder', 'items'], 'area');
    const areaId = id(area.areaId, 'areaId');
    label(area.label, 'area.label');
    if (areaIds.has(areaId)) fail('Duplicate areaId');
    areaIds.add(areaId);
    if (area.assetRole !== 'truck' && area.assetRole !== 'trailer') fail('Invalid assetRole');
    if (area.assetRole === 'trailer' && !modes.includes('tractor_tanker')) fail('Trailer area requires tractor_tanker mode');
    if (typeof area.sortOrder !== 'number' || !Number.isFinite(area.sortOrder) || orders.has(area.sortOrder as number)) fail('Invalid sortOrder');
    orders.add(area.sortOrder as number);
    const items = array(area.items, 'items', 100);
    if (!items.length) fail('Area requires items');
    totalItems += items.length;
    const itemIds = new Set<string>();
    for (const raw of items) {
      const item = object(raw, 'item');
      onlyKeys(item, ['itemId', 'componentLabel', 'description', 'legacyCategoryId', 'federalCategoryIds'], 'item');
      const itemId = id(item.itemId, 'itemId');
      if (itemIds.has(itemId)) fail('Duplicate itemId');
      itemIds.add(itemId);
      label(item.componentLabel, 'componentLabel');
      if (item.description !== undefined) label(item.description, 'description', 1000);
      if (item.legacyCategoryId !== undefined) id(item.legacyCategoryId, 'legacyCategoryId');
      if (item.federalCategoryIds !== undefined) {
        for (const category of array(item.federalCategoryIds, 'federalCategoryIds', 30)) id(category, 'federalCategoryId');
      }
    }
  }
  if (totalItems > 2000) fail('Too many items');
  const images = array(m.images, 'images', 100);
  const imageIds = new Set<string>();
  let bytes = 0;
  for (const entry of images) {
    const image = object(entry, 'image');
    onlyKeys(image, ['imageId', 'storagePath', 'sha256', 'byteLength', 'contentType'], 'image');
    const imageId = id(image.imageId, 'imageId');
    if (imageIds.has(imageId)) fail('Duplicate imageId');
    imageIds.add(imageId);
    if (image.contentType !== 'image/jpeg' && image.contentType !== 'image/png') fail('Invalid image contentType');
    if (typeof image.byteLength !== 'number' || !Number.isSafeInteger(image.byteLength) || image.byteLength < 1 || image.byteLength > 8 * 1024 * 1024) fail('Invalid image size');
    bytes += image.byteLength as number;
    if (typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) fail('Invalid image hash');
    const ext = image.contentType === 'image/jpeg' ? 'jpg' : 'png';
    const companyPath = options.ownerCompanyId
      ? `companies/${options.ownerCompanyId}/equipment-inspection-media/${imageId}.${ext}` : null;
    const defaultPath = `equipment-inspection-defaults/${profileId}/${revision}/${imageId}.${ext}`;
    const inheritedDefaultPath = new RegExp(`^equipment-inspection-defaults/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/${imageId}\\.${ext}$`);
    if (options.ownerCompanyId
      ? image.storagePath !== companyPath && !inheritedDefaultPath.test(String(image.storagePath))
      : image.storagePath !== defaultPath) fail('Invalid image storagePath');
  }
  if (bytes > 200 * 1024 * 1024) fail('Too much media');
  const areaImages = object(m.areaImages, 'areaImages');
  for (const key of Object.keys(areaImages)) {
    if (!areaIds.has(key) || typeof areaImages[key] !== 'string' || !imageIds.has(areaImages[key] as string)) fail('Invalid area image reference');
  }
  if (options.published && [...areaIds].some(areaId => !areaImages[areaId])) fail('Every area needs an image');
  return m as ProfileManifest;
}
