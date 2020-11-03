const { readFileSync, existsSync, mkdirpSync } = require('fs-extra');
const { relative, join, dirname, resolve } = require('path');
const compiler = require('jsx-compiler');
const { getOptions } = require('loader-utils');
const chalk = require('chalk');
const PrettyError = require('pretty-error');
const cached = require('./cached');
const { removeExt, isFromTargetDirs, doubleBackslash, normalizeOutputFilePath, addRelativePathPrefix } = require('./utils/pathHelper');
const eliminateDeadCode = require('./utils/dce');
const { isTypescriptFile } = require('./utils/judgeModule');
const processCSS = require('./styleProcessor');
const output = require('./output');

const pe = new PrettyError();

const ComponentLoader = __filename;
const ScriptLoader = require.resolve('./script-loader');

module.exports = async function componentLoader(content) {
  const loaderOptions = getOptions(this);
  const { platform, entryPath, constantDir, mode, disableCopyNpm, turnOffSourceMap } = loaderOptions;
  const rawContent = readFileSync(this.resourcePath, 'utf-8');
  const resourcePath = this.resourcePath;
  const rootContext = this.rootContext;
  const absoluteConstantDir = constantDir.map(dir => join(rootContext, dir));
  const outputPath = this._compiler.outputPath;
  const sourcePath = join(rootContext, dirname(entryPath));

  const relativeSourcePath = relative(sourcePath, this.resourcePath);
  const distFileWithoutExt = removeExt(join(outputPath, relativeSourcePath), platform.type);

  const isFromConstantDir = cached(isFromTargetDirs(absoluteConstantDir));

  const compilerOptions = Object.assign({}, compiler.baseOptions, {
    resourcePath: this.resourcePath,
    outputPath,
    sourcePath,
    type: 'component',
    platform,
    sourceFileName: this.resourcePath,
    disableCopyNpm,
    turnOffSourceMap
  });

  const rawContentAfterDCE = eliminateDeadCode(rawContent);

  let transformed;
  try {
    transformed = compiler(rawContentAfterDCE, compilerOptions);
  } catch (e) {
    console.log(chalk.red(`\n[${platform.name}] Error occured when handling Component ${this.resourcePath}`));
    console.log(pe.render(e));
    throw new Error(e);
  }

  const { style, assets } = await processCSS(transformed.cssFiles, sourcePath);
  transformed.style = style;
  transformed.assets = assets;

  const config = Object.assign({}, transformed.config);
  if (Array.isArray(transformed.dependencies)) {
    transformed.dependencies.forEach(dep => {
      this.addDependency(dep);
    });
  }
  if (config.usingComponents) {
    const usingComponents = {};
    Object.keys(config.usingComponents).forEach(key => {
      const value = config.usingComponents[key];

      if (/^c-/.test(key)) {
        const result = removeExt(addRelativePathPrefix(relative(dirname(this.resourcePath), value))); // ./components/Repo
        usingComponents[key] = normalizeOutputFilePath(result);
      } else {
        usingComponents[key] = normalizeOutputFilePath(value);
      }
    });
    config.usingComponents = usingComponents;
  }

  const distFileDir = dirname(distFileWithoutExt);
  if (!existsSync(distFileDir)) mkdirpSync(distFileDir);

  const outputContent = {
    code: transformed.code,
    map: transformed.map,
    css: transformed.style || '',
    json: config,
    template: transformed.template,
    assets: transformed.assets
  };
  const outputOption = {
    outputPath: {
      code: distFileWithoutExt + '.js',
      json: distFileWithoutExt + '.json',
      css: distFileWithoutExt + platform.extension.css,
      template: distFileWithoutExt + platform.extension.xml,
      assets: outputPath
    },
    mode,
    isTypescriptFile: isTypescriptFile(this.resourcePath)
  };

  output(outputContent, rawContent, outputOption);

  function isCustomComponent(name, usingComponents = {}) {
    const matchingPath = join(dirname(resourcePath), name);
    for (let key in usingComponents) {
      if (
        usingComponents.hasOwnProperty(key)
        && usingComponents[key]
        && usingComponents[key].indexOf(matchingPath) === 0
      ) {
        return true;
      }
    }
    return false;
  }

  const dependencies = [];
  Object.keys(transformed.imported).forEach(name => {
    if (isCustomComponent(name, transformed.usingComponents)) {
      const componentPath = resolve(dirname(resourcePath), name);
      dependencies.push({
        name,
        loader: isFromConstantDir(componentPath) ? ScriptLoader : ComponentLoader, // Native miniapp component js file will loaded by script-loader
        options: loaderOptions
      });
    } else {
      const importedArray = transformed.imported[name];
      let entirePush = false;
      importedArray.forEach(importedContent => {
        // Component library
        if (importedContent.isFromComponentLibrary) {
          dependencies.push({
            name,
            loader: ScriptLoader,
            options: Object.assign({}, loaderOptions, {
              importedComponent: importedContent.local
            })
          });
        } else {
          if (!entirePush) {
            dependencies.push({ name });
            entirePush = true;
          }
        }
      });
    }
  });

  return [
    `/* Generated by JSX2MP ComponentLoader, sourceFile: ${this.resourcePath}. */`,
    generateDependencies(dependencies),
  ].join('\n');
};

function generateDependencies(dependencies) {
  return dependencies
    .map(({ name, loader, options }) => {
      let mod = name;
      if (loader) mod = loader + '?' + JSON.stringify(options) + '!' + mod;
      return createImportStatement(mod);
    })
    .join('\n');
}

function createImportStatement(req) {
  return `import '${doubleBackslash(req)}';`;
}
