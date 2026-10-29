/**
 * Explicit WellBuilt default publisher. Dry run by default. Never run with
 * --publish until private media Storage rules and the catalogue are approved.
 * Usage: node scripts/publish-dvir-profile-defaults.cjs <WBE_HOME> [--publish]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function main() {
  const equipmentRoot = path.resolve(process.argv[2] || '');
  const publish = process.argv.includes('--publish');
  if (!fs.existsSync(path.join(equipmentRoot, 'packages/dvir-domain/src/packs/hot-oiler-v1/catalog.ts')))
    throw new Error('Registered WB eQuipment home required');
  if (publish && (process.env.WB_DVIR_PROFILE_PUBLISH !== '1' || process.env.GOOGLE_CLOUD_PROJECT !== 'wellbuilt-sync'))
    throw new Error('Publishing requires WB_DVIR_PROFILE_PUBLISH=1 and GOOGLE_CLOUD_PROJECT=wellbuilt-sync');
  const admin = publish ? require('../functions/node_modules/firebase-admin') : null;
  if (admin) admin.initializeApp({ projectId: 'wellbuilt-sync', storageBucket: 'wellbuilt-sync.firebasestorage.app' });
  for (const profileId of ['hot-oiler-v1', 'tractor-tanker-v1']) {
    const root = path.join(__dirname, '../docs/dvir-profile-defaults');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, `${profileId}.20261029_candidate1.review.json`), 'utf8'));
    const sources = JSON.parse(fs.readFileSync(path.join(root, `${profileId}.20261029_candidate1.source-files.json`), 'utf8'));
    const assembled = [];
    for (const image of manifest.images) {
      const bytes = fs.readFileSync(path.join(equipmentRoot, sources[image.imageId]));
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (hash !== image.sha256 || bytes.length !== image.byteLength) throw new Error(`Source image changed: ${image.imageId}`);
      const validMagic = image.contentType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!validMagic) throw new Error(`Invalid image content: ${image.imageId}`);
      assembled.push({ image, bytes });
    }
    if (!publish) { console.log(`DRY RUN ${profileId}: ${manifest.catalog.areas.length} areas, ${assembled.length} matching media hashes`); continue; }
    const bucket = admin.storage().bucket();
    for (const { image, bytes } of assembled) {
      const file = bucket.file(image.storagePath);
      const [exists] = await file.exists();
      if (!exists) await file.save(bytes, { resumable: false, contentType: image.contentType,
        preconditionOpts: { ifGenerationMatch: 0 } });
      const [stored] = await file.download();
      if (stored.length !== image.byteLength || crypto.createHash('sha256').update(stored).digest('hex') !== image.sha256)
        throw new Error(`Remote image mismatch: ${image.storagePath}`);
    }
    const pointer = admin.firestore().collection('equipment_inspection_defaults').doc(profileId);
    const version = pointer.collection('revisions').doc(manifest.revision);
    await admin.firestore().runTransaction(async tx => {
      const [current, immutable] = await Promise.all([tx.get(pointer), tx.get(version)]);
      if (immutable.exists || current.data()?.revision === manifest.revision) throw new Error(`Revision already consumed: ${profileId}`);
      tx.create(version, { manifest, publishedAt: admin.firestore.FieldValue.serverTimestamp(), publisher: 'reviewed-script' });
      tx.set(pointer, { revision: manifest.revision, title: manifest.title, equipmentType: manifest.equipmentType,
        supportedModes: manifest.supportedModes, source: 'wellbuilt', publishedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    console.log(`PUBLISHED ${profileId} revision ${manifest.revision}`);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
