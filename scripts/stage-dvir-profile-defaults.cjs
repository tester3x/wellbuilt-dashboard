/**
 * Read-only source inspection of the registered WB eQuipment home. Generates
 * review manifests and hashes in this Dashboard repo; never uploads media.
 * Usage: node scripts/stage-dvir-profile-defaults.cjs D:/dev/wellbuilt-equipment
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');

const equipmentRoot = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(equipmentRoot, 'packages/dvir-domain/src/packs/hot-oiler-v1/catalog.ts')))
  throw new Error('Registered WB eQuipment source path required');
const loaded = new Map();
function loadTs(filename) {
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.set(filename, instance);
  const originalRequire = instance.require.bind(instance);
  instance.require = specifier => {
    if (!specifier.startsWith('.')) return originalRequire(specifier);
    const base = path.resolve(path.dirname(filename), specifier.replace(/\.js$/, ''));
    const resolved = [base, `${base}.ts`, path.join(base, 'index.ts')].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!resolved) throw new Error(`Cannot resolve ${specifier} from ${filename}`);
    return resolved.endsWith('.ts') ? loadTs(resolved) : originalRequire(resolved);
  };
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  instance._compile(compiled, filename);
  return instance.exports;
}
const hotPath = path.join(equipmentRoot, 'packages/dvir-domain/src/packs/hot-oiler-v1/catalog.ts');
const waterPath = path.join(equipmentRoot, 'packages/dvir-domain/src/packs/tractor-tanker-v1/catalog.ts');
const catalogs = {
  hot: loadTs(hotPath).HOT_OILER_CATALOG_PROPOSAL,
  water: loadTs(waterPath).TRACTOR_TANKER_DOMAIN_CATALOG,
};

const maps = [
  { profileId: 'hot-oiler-v1', title: 'Hot Oiler Truck', equipmentType: 'hot_oiler',
    dir: 'hot-oiler-consistent-v1', catalog: catalogs.hot, modes: ['truck_only'], files: {
      ho_cab: 'ho_cab.jpg', ho_vehicle_front: 'ho_vehicle_front-v2.png',
      ho_vehicle_sides_rear: 'ho_vehicle_sides_rear.jpg', ho_control_station: 'ho_control_station-v2.png',
      ho_piping: 'ho_piping-v3-more-valves.png', ho_heater: 'ho_heater-v2.png',
      ho_pump: 'ho_pump-v2.png', ho_hoses: 'ho_hoses.jpg', ho_tank_fire: 'ho_tank_fire.jpg',
    } },
  { profileId: 'tractor-tanker-v1', title: 'Water Hauler Tractor and Tanker', equipmentType: 'tractor_tanker',
    dir: 'tractor-tanker-consistent-v2', catalog: catalogs.water, modes: ['tractor_tanker'], files: {
      tractor_cab_controls: 'tractor_cab_controls.jpg', tractor_engine_steering: 'tractor_engine_steering.jpg',
      tractor_front: 'tractor_front.jpg', tractor_driver_side: 'tractor_driver_side.jpg',
      tractor_coupling: 'tractor_coupling-v4-cylindrical-pump.png', tanker_front: 'tanker_front.jpg',
      tanker_driver_side: 'tanker_driver_side.jpg', tanker_rear: 'tanker_rear.jpg',
      tanker_passenger_side: 'tanker_passenger_side.jpg', tanker_top_fittings: 'tanker_top_fittings.jpg',
      tanker_vacuum_pump: 'tanker_vacuum_pump.jpg', tractor_passenger_side: 'tractor_passenger_side.jpg',
    } },
];

const revision = '20261029_candidate1';
const outDir = path.join(__dirname, '../docs/dvir-profile-defaults');
fs.mkdirSync(outDir, { recursive: true });
for (const entry of maps) {
  const areas = entry.catalog.areas.map(area => ({
    areaId: area.areaId, label: area.label, assetRole: area.assetRole,
    sortOrder: area.sortOrder,
    items: area.items.map(item => ({ itemId: item.itemId, componentLabel: item.componentLabel,
      ...(item.description ? { description: item.description } : {}),
      ...(item.legacyCategoryId ? { legacyCategoryId: item.legacyCategoryId } : {}),
      ...(item.federalCategoryIds ? { federalCategoryIds: item.federalCategoryIds } : {}),
    })),
  }));
  const images = [];
  const areaImages = {};
  const sourceFiles = {};
  for (const area of areas) {
    const filename = entry.files[area.areaId];
    if (!filename) throw new Error(`Missing ${entry.profileId}/${area.areaId} image mapping`);
    const full = path.join(equipmentRoot, 'assets/dvir', entry.dir, filename);
    const bytes = fs.readFileSync(full);
    const ext = path.extname(filename).toLowerCase();
    const validMagic = ext === '.png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!validMagic) throw new Error(`Invalid image bytes: ${filename}`);
    const imageId = area.areaId.replace(/[^A-Za-z0-9_-]/g, '_');
    if (bytes.length > 8 * 1024 * 1024) throw new Error(`Oversize ${filename}`);
    images.push({ imageId, storagePath: `equipment-inspection-defaults/${entry.profileId}/${revision}/${imageId}.${ext === '.png' ? 'png' : 'jpg'}`,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
      contentType: ext === '.png' ? 'image/png' : 'image/jpeg' });
    areaImages[area.areaId] = imageId;
    sourceFiles[imageId] = `assets/dvir/${entry.dir}/${filename}`;
  }
  const manifest = { schemaVersion: 1, profileId: entry.profileId, revision, title: entry.title,
    equipmentType: entry.equipmentType, source: 'wellbuilt', supportedModes: entry.modes,
    catalog: { catalogId: entry.profileId, version: revision, label: entry.title, areas },
    areaImages, images };
  fs.writeFileSync(path.join(outDir, `${entry.profileId}.${revision}.review.json`), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, `${entry.profileId}.${revision}.source-files.json`), JSON.stringify(sourceFiles, null, 2) + '\n');
  process.stdout.write(`${entry.profileId}: ${areas.length} areas, ${images.length} images staged for review\n`);
}
