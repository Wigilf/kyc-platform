// Metro has to be told about the monorepo: the chip protocol lives in
// packages/mrtd and dependencies are hoisted to the repository root, neither
// of which Metro looks for on its own.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Without this, a package resolved from the root and one resolved from the app
// can be two copies of the same library, which for React is fatal.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
