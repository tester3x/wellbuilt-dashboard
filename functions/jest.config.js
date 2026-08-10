// Unit tests for pure guard/quarantine modules (node env, no emulator).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // The contracts mirror is published as pure ESM ("type": "module") and is
  // resolved outside node_modules, so nothing transforms it by default and any
  // suite that transitively imports it dies on `export`. Transforming it to
  // CommonJS lets tests load the REAL contract constants — a hand-written stub
  // would let the mirror drift out from under the tests that depend on it.
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
  },
};
