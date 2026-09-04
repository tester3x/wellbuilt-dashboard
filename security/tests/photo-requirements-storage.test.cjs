const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
const { deleteObject, getBytes, ref, uploadBytes } = require('firebase/storage');

const root = resolve(__dirname, '../..');
const projectId = 'demo-wb-photo-requirements';
const target = 'photo_requirements/slawsonexplorationcompanyinc/sample.jpg';
const image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

async function main() {
  const env = await initializeTestEnvironment({
    projectId,
    storage: {
      host: '127.0.0.1',
      port: 9199,
      rules: readFileSync(resolve(root, 'storage.rules'), 'utf8'),
    },
  });

  try {
    const upload = (context, path = target, bytes = image, contentType = 'image/jpeg') => uploadBytes(ref(context.storage(), path), bytes, {
      contentType,
    });

    const owner = env.authenticatedContext('owner', { wellbuiltAdmin: true });
    const ownerRef = ref(owner.storage(), target);
    await assertSucceeds(uploadBytes(ownerRef, image, { contentType: 'image/jpeg' }));
    await assertSucceeds(getBytes(ownerRef));
    await assertSucceeds(uploadBytes(ownerRef, new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]), {
      contentType: 'image/jpeg',
    }));
    await assertFails(deleteObject(ownerRef));
    await assertFails(upload(owner, target, new Uint8Array(12 * 1024 * 1024), 'image/jpeg'));
    await assertFails(upload(owner, target, new TextEncoder().encode('not an image'), 'text/plain'));
    await assertFails(upload(owner, 'photo_requirements/slawsonexplorationcompanyinc/nested/sample.jpg'));

    // Dashboard company staff currently have RTDB roles, not trusted custom
    // claims that bind them to an operator/customer path. Authentication alone
    // must therefore remain insufficient at this Storage boundary.
    await assertFails(upload(env.authenticatedContext('company-admin', {
      role: 'admin',
      companyId: 'liquid-gold',
    })));

    await assertFails(upload(env.authenticatedContext('driver', {
      kind: 'driver', driverId: 'driver-1', companyId: 'liquid-gold',
    })));

    await assertFails(upload(env.authenticatedContext('other-tenant', {
      role: 'admin', companyId: 'other-company',
    })));

    await assertFails(upload(env.unauthenticatedContext()));

    console.log('PASS photo_requirements Storage authorization matrix');
  } finally {
    await env.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
