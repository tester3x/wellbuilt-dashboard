const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
const { ref, uploadBytes } = require('firebase/storage');

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
    const upload = (context) => uploadBytes(ref(context.storage(), target), image, {
      contentType: 'image/jpeg',
    });

    await assertSucceeds(upload(env.authenticatedContext('owner', {
      wellbuiltAdmin: true,
    })));

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

    await assertFails(uploadBytes(
      ref(env.authenticatedContext('owner-text', { wellbuiltAdmin: true }).storage(), target),
      new TextEncoder().encode('not an image'),
      { contentType: 'text/plain' },
    ));

    console.log('PASS photo_requirements Storage authorization matrix');
  } finally {
    await env.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
