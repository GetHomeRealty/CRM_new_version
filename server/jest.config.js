/** Jest config for the Reports module unit tests (ts-jest, isolatedModules to skip full type-check). */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
