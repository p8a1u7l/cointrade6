import '../utils/polyfills.js';
import fs from 'fs';
import path from 'path';
import Module from 'node:module';
import * as childProcess from 'node:child_process';
import { Buffer } from 'node:buffer';
import { fileURLToPath, pathToFileURL } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '../../..');
const distRoot = path.resolve(repoRoot, 'dist');
const distPath = path.resolve(distRoot, 'packages/signals/src/index.js');
const tsconfigPath = path.resolve(repoRoot, 'tsconfig.json');
const srcPath = path.resolve(repoRoot, 'packages/signals/src/index.ts');

let cachedModulePromise = null;
let aliasesRegistered = false;
let esbuildPromise = null;
let bundledModuleCache = null;
let tscBuildPromise = null;
const testOverrides = {
  runTscBuild: null,
};

const aliasPrefixMap = [
  {
    prefix: '@repo/core/',
    roots: [
      path.join(distRoot, 'packages/core/'),
      path.join(repoRoot, 'packages/core/'),
    ],
  },
  {
    prefix: '@repo/executor/',
    roots: [
      path.join(distRoot, 'packages/executor/src/'),
      path.join(repoRoot, 'packages/executor/src/'),
    ],
  },
  {
    prefix: '@repo/risk/',
    roots: [
      path.join(distRoot, 'packages/risk/src/'),
      path.join(repoRoot, 'packages/risk/src/'),
    ],
  },
  {
    prefix: '@repo/signals/',
    roots: [
      path.join(distRoot, 'packages/signals/src/'),
      path.join(repoRoot, 'packages/signals/src/'),
    ],
  },
  {
    prefix: '@repo/packages/',
    roots: [
      path.join(distRoot, 'packages/'),
      path.join(repoRoot, 'packages/'),
    ],
  },
  {
    prefix: '@repo/models-dl/',
    roots: [
      path.join(distRoot, 'packages/models-dl/src/'),
      path.join(repoRoot, 'packages/models-dl/src/'),
    ],
  },
  {
    prefix: '@repo/models-llm/',
    roots: [
      path.join(distRoot, 'packages/models-llm/src/'),
      path.join(repoRoot, 'packages/models-llm/src/'),
    ],
  },
];

const aliasExactMap = [
  {
    spec: '@repo/exchange-binance',
    candidates: [
      path.join(distRoot, 'packages/exchange-binance/index.js'),
      path.join(repoRoot, 'packages/exchange-binance/index.ts'),
    ],
  },
];

function resolveWithExtensions(basePath) {
  const candidates = [basePath];
  if (!/\.[a-z0-9]+$/i.test(basePath)) {
    candidates.push(
      `${basePath}.js`,
      `${basePath}.cjs`,
      `${basePath}.mjs`,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      path.join(basePath, 'index.js'),
      path.join(basePath, 'index.cjs'),
      path.join(basePath, 'index.mjs'),
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
    );
  }

  for (const candidate of candidates) {
    try {
      const stats = fs.existsSync(candidate) ? fs.statSync(candidate) : null;
      if (stats?.isFile()) {
        return candidate;
      }
    } catch (error) {
      // Ignore filesystem race conditions and continue to the next candidate.
    }
  }
  return null;
}

function resolveRepoAlias(specifier) {
  for (const entry of aliasExactMap) {
    if (specifier === entry.spec) {
      for (const candidate of entry.candidates) {
        const resolved = resolveWithExtensions(candidate);
        if (resolved) {
          return resolved;
        }
      }
      return null;
    }
  }

  for (const entry of aliasPrefixMap) {
    if (!specifier.startsWith(entry.prefix)) {
      continue;
    }
    const fragment = specifier.slice(entry.prefix.length);
    for (const root of entry.roots) {
      const resolved = resolveWithExtensions(path.join(root, fragment));
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function registerRepoAliases() {
  if (aliasesRegistered) {
    return;
  }

  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
    if (typeof request === 'string' && request.startsWith('@repo/')) {
      const mapped = resolveRepoAlias(request);
      if (mapped) {
        return originalResolve.call(this, mapped, parent, isMain, options);
      }
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
  aliasesRegistered = true;
}

function loadEsbuild() {
  if (!esbuildPromise) {
    esbuildPromise = import('esbuild')
      .then((mod) => (mod?.build ? mod : mod?.default))
      .catch((error) => {
        esbuildPromise = null;
        throw error;
      });
  }
  return esbuildPromise;
}

const esbuildAliasPlugin = {
  name: 'scalp-signals-alias',
  setup(build) {
    build.onResolve({ filter: /^@repo\// }, (args) => {
      const mapped = resolveRepoAlias(args.path);
      if (mapped) {
        return { path: mapped };
      }
      return null;
    });

    build.onResolve({ filter: /^\.\.?(?:\/|$)/ }, (args) => {
      const absoluteTarget = path.resolve(args.resolveDir, args.path);
      const resolved = resolveWithExtensions(absoluteTarget);
      if (resolved) {
        return { path: resolved };
      }
      return { path: absoluteTarget };
    });
  },
};

async function loadBundledSignalsModule() {
  if (bundledModuleCache) {
    return bundledModuleCache;
  }

  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    entryPoints: [srcPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    sourcemap: 'inline',
    write: false,
    absWorkingDir: repoRoot,
    logLevel: 'silent',
    plugins: [esbuildAliasPlugin],
    loader: {
      '.ts': 'ts',
      '.tsx': 'tsx',
      '.js': 'js',
      '.json': 'json',
    },
    resolveExtensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
  });

  const output = result?.outputFiles?.[0]?.text;
  if (!output) {
    throw new Error('esbuild failed to bundle the scalping signals module');
  }

  const dataUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;

  try {
    bundledModuleCache = await import(dataUrl);
    return bundledModuleCache;
  } catch (error) {
    bundledModuleCache = null;
    throw error;
  }
}

function runTscBuild() {
  if (typeof testOverrides.runTscBuild === 'function') {
    return Promise.resolve().then(() => testOverrides.runTscBuild());
  }

  if (tscBuildPromise) {
    return tscBuildPromise;
  }

  tscBuildPromise = new Promise((resolve, reject) => {
    const compilerPath = path.resolve(repoRoot, 'node_modules/typescript/bin/tsc');
    if (!fs.existsSync(compilerPath)) {
      tscBuildPromise = null;
      return reject(new Error(`TypeScript compiler not found at ${compilerPath}. Install dependencies with "npm install --prefix zenith".`));
    }

    const child = childProcess.spawn(process.execPath, [compilerPath, '-p', tsconfigPath], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      tscBuildPromise = null;
      reject(error);
    });

    child.once('exit', (code) => {
      tscBuildPromise = null;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`TypeScript compilation exited with code ${code}`));
      }
    });
  });

  return tscBuildPromise;
}

async function tryImportDistModule() {
  if (!fs.existsSync(distPath)) {
    return null;
  }

  try {
    return await import(pathToFileURL(distPath).href);
  } catch (error) {
    throw error;
  }
}

async function loadSignalsModule() {
  if (!cachedModulePromise) {
    cachedModulePromise = (async () => {
      registerRepoAliases();
      let lastError = null;

      try {
        const distModule = await tryImportDistModule();
        if (distModule) {
          return distModule;
        }
      } catch (error) {
        lastError = error;
      }

      const bundlerDisabled = process.env.SCALP_SIGNALS_DISABLE_ESBUILD === '1';
      if (!bundlerDisabled && fs.existsSync(srcPath)) {
        try {
          return await loadBundledSignalsModule();
        } catch (error) {
          lastError = error;
        }
      }

      if (fs.existsSync(srcPath)) {
        try {
          await runTscBuild();
          const distModule = await tryImportDistModule();
          if (distModule) {
            return distModule;
          }
        } catch (error) {
          lastError = error;
        }
      }

      const hints = [];
      if (fs.existsSync(srcPath)) {
        hints.push(
          `Signals build not found at ${distPath}. Attempted to compile TypeScript sources but the process failed.`
        );
        hints.push('Ensure dependencies are installed with "npm install --prefix zenith".');
      } else {
        hints.push(`Signals sources not found at ${srcPath}.`);
      }
      const error = new Error(hints.join(' '));
      error.cause = lastError;
      throw error;
    })();
  }

  try {
    return await cachedModulePromise;
  } catch (error) {
    cachedModulePromise = null;
    throw error;
  }
}

export async function runScalpLoop(exchange, symbol) {
  const mod = await loadSignalsModule();
  return mod.loop(exchange, symbol);
}

export async function getScalpRealized(symbol) {
  const mod = await loadSignalsModule();
  return mod.getRealizedPnl(symbol);
}

export async function updateScalpInterest(entries) {
  const mod = await loadSignalsModule();
  if (typeof mod.updateInterestHotlist === 'function') {
    mod.updateInterestHotlist(entries ?? []);
  }
}

export function __resetScalpSignalsLoaderForTests() {
  cachedModulePromise = null;
  bundledModuleCache = null;
  esbuildPromise = null;
  tscBuildPromise = null;
  testOverrides.runTscBuild = null;
}

export function __setScalpSignalsTestOverrides(overrides = {}) {
  if (overrides && typeof overrides.runTscBuild === 'function') {
    testOverrides.runTscBuild = overrides.runTscBuild;
  } else {
    testOverrides.runTscBuild = null;
  }
}
