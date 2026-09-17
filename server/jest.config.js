/** Jest config for the Reports module unit tests (ts-jest, isolatedModules to skip full type-check). */
module.exports = {
  testEnvironment: 'node',
  /*
   * Runs BEFORE each test module is loaded, which is the only point that works: every spec builds
   * `new PrismaClient()` at module scope and reads DATABASE_URL as it does. The guard re-points that
   * variable at TEST_DATABASE_URL and refuses the run outright if the database does not name itself
   * a test database — see the file for what this is preventing.
   */
  setupFiles: ['<rootDir>/test/jest-db-guard.cjs'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
