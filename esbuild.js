const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** The extension host bundle (Node/CJS). Only `vscode` is external; mysql2
 * is bundled so the .vsix is self-contained. */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/extension.js",
  external: ["vscode"],
  logLevel: "silent",
  plugins: [problemMatcher("extension")],
};

/** The webview UI bundle (browser/ESM). Monaco + our console logic. */
const webviewConfig = {
  entryPoints: ["webview/console.ts"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outfile: "media/console.bundle.js",
  loader: { ".ttf": "file" },
  logLevel: "silent",
  plugins: [problemMatcher("webview")],
};

/** Monaco's editor worker as its own browser bundle. */
const workerConfig = {
  entryPoints: ["node_modules/monaco-editor/esm/vs/editor/editor.worker.js"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outfile: "media/editor.worker.js",
  logLevel: "silent",
  plugins: [problemMatcher("worker")],
};

async function main() {
  const configs = [extensionConfig, webviewConfig, workerConfig];
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    for (const ctx of contexts) {
      await ctx.rebuild();
      await ctx.dispose();
    }
  }
}

/** @param {string} label */
function problemMatcher(label) {
  return {
    name: `esbuild-problem-matcher-${label}`,
    setup(build) {
      build.onStart(() => {
        console.log(`[watch] build started (${label})`);
      });
      build.onEnd((result) => {
        result.errors.forEach(({ text, location }) => {
          console.error(`✘ [ERROR] ${text}`);
          if (location) {
            console.error(
              `    ${location.file}:${location.line}:${location.column}:`,
            );
          }
        });
        console.log(`[watch] build finished (${label})`);
      });
    },
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
