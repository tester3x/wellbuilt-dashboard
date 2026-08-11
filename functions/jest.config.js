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
  // Source in src/sso uses NodeNext-style specifiers ('./protocol.generated.js')
  // because that is what the Functions build emits. Jest resolves from the
  // TypeScript sources, where no such .js file exists, so the extension is
  // stripped for RELATIVE paths only. Every source file under src is .ts, so
  // this cannot shadow a real .js module; package specifiers are untouched.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
