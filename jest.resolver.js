const enhancedResolve = require('enhanced-resolve');
const path = require('path');
const fs = require('fs');

const resolver = enhancedResolve.create.sync({
  conditionNames: ['require', 'node', 'default'],
  extensions: ['.js', '.json', '.node', '.ts', '.tsx']
});

module.exports = function (request, options) {
  if (request.startsWith('jose/')) {
    // Try different possible paths
    const possiblePaths = [
      path.resolve(options.rootDir, 'node_modules', request.replace('jose/', 'jose/dist/node/cjs/') + '.js'),
      path.resolve(options.rootDir, 'node_modules', request.replace('jose/', 'jose/dist/') + '.js'),
      path.resolve(options.rootDir, 'node_modules', request + '.js'),
      path.resolve(options.rootDir, 'node_modules', request.replace('jose/', 'jose/dist/browser/') + '.js')
    ];

    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        return possiblePath;
      }
    }
  }
  return resolver(options.basedir, request);
};
