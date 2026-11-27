import { NxAppWebpackPlugin } from '@nx/webpack/app-plugin';
import nodeExternals from 'webpack-node-externals';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  // Emit a native ES module (dist/apps/api/main.js, loaded via "type": "module").
  experiments: { outputModule: true },
  output: {
    path: join(__dirname, '../../dist/apps/api'),
    clean: true,
    module: true,
    chunkFormat: 'module',
    library: { type: 'module' },
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  // Keep node_modules external, loaded with `import` rather than `require`.
  externalsType: 'module',
  externals: [
    nodeExternals({
      modulesDir: join(__dirname, '../../node_modules'),
      importType: 'module',
    }),
  ],
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true,
      sourceMap: true,
      // Externals are configured above (ESM imports instead of Nx's commonjs default).
      externalDependencies: 'none',
      mergeExternals: true,
    }),
  ],
};
