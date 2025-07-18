import * as childProcess from 'child_process';
import * as path from 'path';
import { ToolkitError } from '@aws-cdk/toolkit-lib';
import * as chalk from 'chalk';
import * as fs from 'fs-extra';
import { invokeBuiltinHooks } from './init-hooks';
import type { IoHelper } from '../../api-private';
import { cliRootDir } from '../../cli/root-dir';
import { versionNumber } from '../../cli/version';
import { cdkHomeDir, formatErrorMessage, rangeFromSemver } from '../../util';

/* eslint-disable @typescript-eslint/no-var-requires */ // Packages don't have @types module
// eslint-disable-next-line @typescript-eslint/no-require-imports
const camelCase = require('camelcase');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const decamelize = require('decamelize');

export interface CliInitOptions {
  readonly type?: string;
  readonly language?: string;
  readonly canUseNetwork?: boolean;
  readonly generateOnly?: boolean;
  readonly workDir?: string;
  readonly stackName?: string;
  readonly migrate?: boolean;

  /**
   * Override the built-in CDK version
   */
  readonly libVersion?: string;

  readonly ioHelper: IoHelper;
}

/**
 * Initialize a CDK package in the current directory
 */
export async function cliInit(options: CliInitOptions) {
  const ioHelper = options.ioHelper;
  const canUseNetwork = options.canUseNetwork ?? true;
  const generateOnly = options.generateOnly ?? false;
  const workDir = options.workDir ?? process.cwd();
  if (!options.type && !options.language) {
    await printAvailableTemplates(ioHelper);
    return;
  }

  const type = options.type || 'default'; // "default" is the default type (and maps to "app")

  const template = (await availableInitTemplates()).find((t) => t.hasName(type!));
  if (!template) {
    await printAvailableTemplates(ioHelper, options.language);
    throw new ToolkitError(`Unknown init template: ${type}`);
  }
  if (!options.language && template.languages.length === 1) {
    const language = template.languages[0];
    await ioHelper.defaults.warn(
      `No --language was provided, but '${type}' supports only '${language}', so defaulting to --language=${language}`,
    );
  }
  if (!options.language) {
    await ioHelper.defaults.info(`Available languages for ${chalk.green(type)}: ${template.languages.map((l) => chalk.blue(l)).join(', ')}`);
    throw new ToolkitError('No language was selected');
  }

  await initializeProject(
    ioHelper,
    template,
    options.language,
    canUseNetwork,
    generateOnly,
    workDir,
    options.stackName,
    options.migrate,
    options.libVersion,
  );
}

/**
 * Returns the name of the Python executable for this OS
 */
function pythonExecutable() {
  let python = 'python3';
  if (process.platform === 'win32') {
    python = 'python';
  }
  return python;
}
const INFO_DOT_JSON = 'info.json';

export class InitTemplate {
  public static async fromName(templatesDir: string, name: string) {
    const basePath = path.join(templatesDir, name);
    const languages = await listDirectory(basePath);
    const initInfo = await fs.readJson(path.join(basePath, INFO_DOT_JSON));
    return new InitTemplate(basePath, name, languages, initInfo);
  }

  public readonly description: string;
  public readonly aliases = new Set<string>();

  constructor(
    private readonly basePath: string,
    public readonly name: string,
    public readonly languages: string[],
    initInfo: any,
  ) {
    this.description = initInfo.description;
    for (const alias of initInfo.aliases || []) {
      this.aliases.add(alias);
    }
  }

  /**
   * @param name - the name that is being checked
   * @returns ``true`` if ``name`` is the name of this template or an alias of it.
   */
  public hasName(name: string): boolean {
    return name === this.name || this.aliases.has(name);
  }

  /**
   * Creates a new instance of this ``InitTemplate`` for a given language to a specified folder.
   *
   * @param language    - the language to instantiate this template with
   * @param targetDirectory - the directory where the template is to be instantiated into
   */
  public async install(ioHelper: IoHelper, language: string, targetDirectory: string, stackName?: string, libVersion?: string) {
    if (this.languages.indexOf(language) === -1) {
      await ioHelper.defaults.error(
        `The ${chalk.blue(language)} language is not supported for ${chalk.green(this.name)} ` +
          `(it supports: ${this.languages.map((l) => chalk.blue(l)).join(', ')})`,
      );
      throw new ToolkitError(`Unsupported language: ${language}`);
    }

    const projectInfo: ProjectInfo = {
      name: decamelize(path.basename(path.resolve(targetDirectory))),
      stackName,
      versions: await loadInitVersions(),
    };

    if (libVersion) {
      projectInfo.versions['aws-cdk-lib'] = libVersion;
    }

    const sourceDirectory = path.join(this.basePath, language);

    await this.installFiles(sourceDirectory, targetDirectory, language, projectInfo);
    await this.applyFutureFlags(targetDirectory);
    await invokeBuiltinHooks(
      ioHelper,
      { targetDirectory, language, templateName: this.name },
      {
        substitutePlaceholdersIn: async (...fileNames: string[]) => {
          for (const fileName of fileNames) {
            const fullPath = path.join(targetDirectory, fileName);
            const template = await fs.readFile(fullPath, { encoding: 'utf-8' });
            await fs.writeFile(fullPath, expandPlaceholders(template, language, projectInfo));
          }
        },
        placeholder: (ph: string) => expandPlaceholders(`%${ph}%`, language, projectInfo),
      },
    );
  }

  private async installFiles(sourceDirectory: string, targetDirectory: string, language: string, project: ProjectInfo) {
    for (const file of await fs.readdir(sourceDirectory)) {
      const fromFile = path.join(sourceDirectory, file);
      const toFile = path.join(targetDirectory, expandPlaceholders(file, language, project));
      if ((await fs.stat(fromFile)).isDirectory()) {
        await fs.mkdir(toFile);
        await this.installFiles(fromFile, toFile, language, project);
        continue;
      } else if (file.match(/^.*\.template\.[^.]+$/)) {
        await this.installProcessed(fromFile, toFile.replace(/\.template(\.[^.]+)$/, '$1'), language, project);
        continue;
      } else if (file.match(/^.*\.hook\.(d.)?[^.]+$/)) {
        // Ignore
        continue;
      } else {
        await fs.copy(fromFile, toFile);
      }
    }
  }

  private async installProcessed(templatePath: string, toFile: string, language: string, project: ProjectInfo) {
    const template = await fs.readFile(templatePath, { encoding: 'utf-8' });
    await fs.writeFile(toFile, expandPlaceholders(template, language, project));
  }

  /**
   * Adds context variables to `cdk.json` in the generated project directory to
   * enable future behavior for new projects.
   */
  private async applyFutureFlags(projectDir: string) {
    const cdkJson = path.join(projectDir, 'cdk.json');
    if (!(await fs.pathExists(cdkJson))) {
      return;
    }

    const config = await fs.readJson(cdkJson);
    config.context = {
      ...config.context,
      ...await currentlyRecommendedAwsCdkLibFlags(),
    };

    await fs.writeJson(cdkJson, config, { spaces: 2 });
  }

  public async addMigrateContext(projectDir: string) {
    const cdkJson = path.join(projectDir, 'cdk.json');
    if (!(await fs.pathExists(cdkJson))) {
      return;
    }

    const config = await fs.readJson(cdkJson);
    config.context = {
      ...config.context,
      'cdk-migrate': true,
    };

    await fs.writeJson(cdkJson, config, { spaces: 2 });
  }
}

export function expandPlaceholders(template: string, language: string, project: ProjectInfo) {
  const cdkVersion = project.versions['aws-cdk-lib'];
  const cdkCliVersion = project.versions['aws-cdk'];
  let constructsVersion = project.versions.constructs;

  switch (language) {
    case 'java':
    case 'csharp':
    case 'fsharp':
      constructsVersion = rangeFromSemver(constructsVersion, 'bracket');
      break;
    case 'python':
      constructsVersion = rangeFromSemver(constructsVersion, 'pep');
      break;
  }
  return template
    .replace(/%name%/g, project.name)
    .replace(/%stackname%/, project.stackName ?? '%name.PascalCased%Stack')
    .replace(
      /%PascalNameSpace%/,
      project.stackName ? camelCase(project.stackName + 'Stack', { pascalCase: true }) : '%name.PascalCased%',
    )
    .replace(
      /%PascalStackProps%/,
      project.stackName ? camelCase(project.stackName, { pascalCase: true }) + 'StackProps' : 'StackProps',
    )
    .replace(/%name\.camelCased%/g, camelCase(project.name))
    .replace(/%name\.PascalCased%/g, camelCase(project.name, { pascalCase: true }))
    .replace(/%cdk-version%/g, cdkVersion)
    .replace(/%cdk-cli-version%/g, cdkCliVersion)
    .replace(/%constructs-version%/g, constructsVersion)
    .replace(/%cdk-home%/g, cdkHomeDir())
    .replace(/%name\.PythonModule%/g, project.name.replace(/-/g, '_'))
    .replace(/%python-executable%/g, pythonExecutable())
    .replace(/%name\.StackName%/g, project.name.replace(/[^A-Za-z0-9-]/g, '-'));
}

interface ProjectInfo {
  /** The value used for %name% */
  readonly name: string;
  readonly stackName?: string;

  readonly versions: Versions;
}

export async function availableInitTemplates(): Promise<InitTemplate[]> {
  return new Promise(async (resolve) => {
    try {
      const templatesDir = path.join(cliRootDir(), 'lib', 'init-templates');
      const templateNames = await listDirectory(templatesDir);
      const templates = new Array<InitTemplate>();
      for (const templateName of templateNames) {
        templates.push(await InitTemplate.fromName(templatesDir, templateName));
      }
      resolve(templates);
    } catch {
      resolve([]);
    }
  });
}

export async function availableInitLanguages(): Promise<string[]> {
  return new Promise(async (resolve) => {
    const templates = await availableInitTemplates();
    const result = new Set<string>();
    for (const template of templates) {
      for (const language of template.languages) {
        result.add(language);
      }
    }
    resolve([...result]);
  });
}

/**
 * @param dirPath - is the directory to be listed.
 * @returns the list of file or directory names contained in ``dirPath``, excluding any dot-file, and sorted.
 */
async function listDirectory(dirPath: string) {
  return (
    (await fs.readdir(dirPath))
      .filter((p) => !p.startsWith('.'))
      .filter((p) => !(p === 'LICENSE'))
      // if, for some reason, the temp folder for the hook doesn't get deleted we don't want to display it in this list
      .filter((p) => !(p === INFO_DOT_JSON))
      .sort()
  );
}

export async function printAvailableTemplates(ioHelper: IoHelper, language?: string) {
  await ioHelper.defaults.info('Available templates:');
  for (const template of await availableInitTemplates()) {
    if (language && template.languages.indexOf(language) === -1) {
      continue;
    }
    await ioHelper.defaults.info(`* ${chalk.green(template.name)}: ${template.description}`);
    const languageArg = language
      ? chalk.bold(language)
      : template.languages.length > 1
        ? `[${template.languages.map((t) => chalk.bold(t)).join('|')}]`
        : chalk.bold(template.languages[0]);
    await ioHelper.defaults.info(`   └─ ${chalk.blue(`cdk init ${chalk.bold(template.name)} --language=${languageArg}`)}`);
  }
}

async function initializeProject(
  ioHelper: IoHelper,
  template: InitTemplate,
  language: string,
  canUseNetwork: boolean,
  generateOnly: boolean,
  workDir: string,
  stackName?: string,
  migrate?: boolean,
  cdkVersion?: string,
) {
  await assertIsEmptyDirectory(workDir);
  await ioHelper.defaults.info(`Applying project template ${chalk.green(template.name)} for ${chalk.blue(language)}`);
  await template.install(ioHelper, language, workDir, stackName, cdkVersion);
  if (migrate) {
    await template.addMigrateContext(workDir);
  }
  if (await fs.pathExists(`${workDir}/README.md`)) {
    const readme = await fs.readFile(`${workDir}/README.md`, { encoding: 'utf-8' });
    await ioHelper.defaults.info(chalk.green(readme));
  }

  if (!generateOnly) {
    await initializeGitRepository(ioHelper, workDir);
    await postInstall(ioHelper, language, canUseNetwork, workDir);
  }

  await ioHelper.defaults.info('✅ All done!');
}

async function assertIsEmptyDirectory(workDir: string) {
  const files = await fs.readdir(workDir);
  if (files.filter((f) => !f.startsWith('.')).length !== 0) {
    throw new ToolkitError('`cdk init` cannot be run in a non-empty directory!');
  }
}

async function initializeGitRepository(ioHelper: IoHelper, workDir: string) {
  if (await isInGitRepository(workDir)) {
    return;
  }
  await ioHelper.defaults.info('Initializing a new git repository...');
  try {
    await execute(ioHelper, 'git', ['init'], { cwd: workDir });
    await execute(ioHelper, 'git', ['add', '.'], { cwd: workDir });
    await execute(ioHelper, 'git', ['commit', '--message="Initial commit"', '--no-gpg-sign'], { cwd: workDir });
  } catch {
    await ioHelper.defaults.warn('Unable to initialize git repository for your project.');
  }
}

async function postInstall(ioHelper: IoHelper, language: string, canUseNetwork: boolean, workDir: string) {
  switch (language) {
    case 'javascript':
      return postInstallJavascript(ioHelper, canUseNetwork, workDir);
    case 'typescript':
      return postInstallTypescript(ioHelper, canUseNetwork, workDir);
    case 'java':
      return postInstallJava(ioHelper, canUseNetwork, workDir);
    case 'python':
      return postInstallPython(ioHelper, workDir);
  }
}

async function postInstallJavascript(ioHelper: IoHelper, canUseNetwork: boolean, cwd: string) {
  return postInstallTypescript(ioHelper, canUseNetwork, cwd);
}

async function postInstallTypescript(ioHelper: IoHelper, canUseNetwork: boolean, cwd: string) {
  const command = 'npm';

  if (!canUseNetwork) {
    await ioHelper.defaults.warn(`Please run '${command} install'!`);
    return;
  }

  await ioHelper.defaults.info(`Executing ${chalk.green(`${command} install`)}...`);
  try {
    await execute(ioHelper, command, ['install'], { cwd });
  } catch (e: any) {
    await ioHelper.defaults.warn(`${command} install failed: ` + formatErrorMessage(e));
  }
}

async function postInstallJava(ioHelper: IoHelper, canUseNetwork: boolean, cwd: string) {
  const mvnPackageWarning = "Please run 'mvn package'!";
  if (!canUseNetwork) {
    await ioHelper.defaults.warn(mvnPackageWarning);
    return;
  }

  await ioHelper.defaults.info("Executing 'mvn package'");
  try {
    await execute(ioHelper, 'mvn', ['package'], { cwd });
  } catch {
    await ioHelper.defaults.warn('Unable to package compiled code as JAR');
    await ioHelper.defaults.warn(mvnPackageWarning);
  }
}

async function postInstallPython(ioHelper: IoHelper, cwd: string) {
  const python = pythonExecutable();
  await ioHelper.defaults.warn(`Please run '${python} -m venv .venv'!`);
  await ioHelper.defaults.info(`Executing ${chalk.green('Creating virtualenv...')}`);
  try {
    await execute(ioHelper, python, ['-m venv', '.venv'], { cwd });
  } catch {
    await ioHelper.defaults.warn('Unable to create virtualenv automatically');
    await ioHelper.defaults.warn(`Please run '${python} -m venv .venv'!`);
  }
}

/**
 * @param dir - a directory to be checked
 * @returns true if ``dir`` is within a git repository.
 */
async function isInGitRepository(dir: string) {
  while (true) {
    if (await fs.pathExists(path.join(dir, '.git'))) {
      return true;
    }
    if (isRoot(dir)) {
      return false;
    }
    dir = path.dirname(dir);
  }
}

/**
 * @param dir - a directory to be checked.
 * @returns true if ``dir`` is the root of a filesystem.
 */
function isRoot(dir: string) {
  return path.dirname(dir) === dir;
}

/**
 * Executes `command`. STDERR is emitted in real-time.
 *
 * If command exits with non-zero exit code, an exception is thrown and includes
 * the contents of STDOUT.
 *
 * @returns STDOUT (if successful).
 */
async function execute(ioHelper: IoHelper, cmd: string, args: string[], { cwd }: { cwd: string }) {
  const child = childProcess.spawn(cmd, args, {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  return new Promise<string>((ok, fail) => {
    child.once('error', (err) => fail(err));
    child.once('exit', (status) => {
      if (status === 0) {
        return ok(stdout);
      } else {
        return fail(new ToolkitError(`${cmd} exited with status ${status}`));
      }
    });
  }).catch(async (err) => {
    await ioHelper.defaults.error(stdout);
    throw err;
  });
}

interface Versions {
  ['aws-cdk']: string;
  ['aws-cdk-lib']: string;
  constructs: string;
}

/**
 * Return the 'aws-cdk-lib' version we will init
 *
 * This has been built into the CLI at build time.
 */
async function loadInitVersions(): Promise<Versions> {
  const initVersionFile = path.join(cliRootDir(), 'lib', 'init-templates', '.init-version.json');
  const contents = JSON.parse(await fs.readFile(initVersionFile, { encoding: 'utf-8' }));

  const ret = {
    'aws-cdk-lib': contents['aws-cdk-lib'],
    'constructs': contents.constructs,
    'aws-cdk': versionNumber(),
  };
  for (const [key, value] of Object.entries(ret)) {
    /* c8 ignore start */
    if (!value) {
      throw new ToolkitError(`Missing init version from ${initVersionFile}: ${key}`);
    }
    /* c8 ignore stop */
  }

  return ret;
}

/**
 * Return the currently recommended flags for `aws-cdk-lib`.
 *
 * These have been built into the CLI at build time.
 */
export async function currentlyRecommendedAwsCdkLibFlags() {
  const recommendedFlagsFile = path.join(cliRootDir(), 'lib', 'init-templates', '.recommended-feature-flags.json');
  return JSON.parse(await fs.readFile(recommendedFlagsFile, { encoding: 'utf-8' }));
}
