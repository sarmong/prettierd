import path from "node:path";
import fs from "node:fs";
import type Prettier from "prettier";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";

type Task = "check" | "format";

type CliOptions = {
  [key: string]: boolean | number | string | undefined;
  config?: false | string;
  configPrecedence: "cli-override" | "file-override" | "prefer-file";
  editorconfig?: boolean;
};

const toCamelcase = (str: string) =>
  str.replace(/-./g, (s) => s[1].toUpperCase());

function argsToOptions(args: string[]) {
  const options: CliOptions = {
    configPrecedence: "cli-override",
  };

  for (const arg of args) {
    let [key, ...valueParts] = arg.replace(/^-+/, "").split("=");
    let value: boolean | number | string = valueParts.join("=");
    if (!value.length) {
      value = !key.startsWith("no-");
      if (!value) {
        key = key.slice(3);
      }
    } else if (/^\d+$/.test(value)) {
      value = Number(value);
    } else if (/^(true|false)$/.test(value)) {
      value = value === "true";
    }

    options[toCamelcase(key)] = value;
  }

  return options;
}

type EnvMap = { [name: string]: string | undefined };

async function tryToResolveConfigFromEnvironmentValue(
  prettier: typeof Prettier,
  editorconfig: boolean,
  value: string | undefined,
): Promise<Prettier.Options | null> {
  if (value) {
    return prettier.resolveConfig(path.dirname(value), {
      config: value,
      editorconfig,
      useCache: false,
    });
  }
  return null;
}

async function resolveConfig(
  env: EnvMap,
  prettier: typeof Prettier,
  filepath: string,
  { config, editorconfig = true }: Pick<CliOptions, "config" | "editorconfig">,
): Promise<Prettier.Options | null> {
  if (config === false) {
    return null;
  }

  let prettierConfig = await prettier.resolveConfig(filepath, {
    editorconfig,
    useCache: false,
  });

  if (!prettierConfig) {
    prettierConfig = await tryToResolveConfigFromEnvironmentValue(
      prettier,
      editorconfig,
      env.PRETTIERD_DEFAULT_CONFIG,
    );
  }

  return prettierConfig;
}

export type ResolvedPrettier = {
  module: typeof Prettier;
  filePath: string;
};

async function resolvePrettier(
  env: EnvMap,
  filePath: string,
): Promise<ResolvedPrettier | undefined> {
  let prettierPath: string;

  if (fs.existsSync(path.join(process.cwd(), ".pnp.cjs"))) {
    require(path.join(process.cwd(), ".pnp.cjs")).setup();
  }

  try {
    prettierPath = require.resolve("prettier", { paths: [filePath] });
  } catch (e) {
    if (env.PRETTIERD_LOCAL_PRETTIER_ONLY) {
      return undefined;
    }
    prettierPath = require.resolve("prettier");
  }

  return import(prettierPath).then((v) => {
    if (v !== undefined) {
      return {
        module: v,
        filePath: prettierPath,
      };
    }
    return undefined;
  });
}

function resolveFile(cwd: string, fileName: string): string {
  if (path.isAbsolute(fileName)) {
    return fileName;
  }

  return path.join(cwd, fileName);
}

interface CLIArguments {
  noColor: boolean;
  /** @see https://prettier.io/docs/en/cli.html#--ignore-path */
  ignorePath: string;
}

const defaultCLIArguments: CLIArguments = {
  noColor: false,
  ignorePath: ".prettierignore",
};

function parseCLIArguments(
  args: string[],
): [CLIArguments, string, Task, CliOptions] {
  const parsedArguments: CLIArguments = { ...defaultCLIArguments };
  let fileName: string | null = null;
  let task: Task = "format";

  const optionArgs: string[] = [];

  const argsIterator = args[Symbol.iterator]();
  for (const arg of argsIterator) {
    if (arg.startsWith("-")) {
      switch (arg) {
        case "--no-color":
          parsedArguments.noColor = true;
          break;

        case "--ignore-path": {
          const nextArg = argsIterator.next();
          if (nextArg.done) {
            throw new Error("--ignore-path option expects a file path");
          }

          parsedArguments.ignorePath = nextArg.value;
          break;
        }
        case "--check": {
          task = "check";
          break;
        }
        case "--format": {
          task = "format";
          break;
        }
        default: {
          optionArgs.push(arg);
        }
      }
    } else {
      if (fileName) {
        throw new Error("Only a single file path is supported");
      }
      // NOTE: positional arguments are assumed to be file paths
      fileName = arg;
    }
  }

  if (!fileName) {
    throw new Error("File name must be provided as an argument");
  }

  return [parsedArguments, fileName, task, argsToOptions(optionArgs)];
}

type InvokeArgs = {
  args: string[];
  clientEnv: EnvMap;
};

async function run(
  cwd: string,
  { args, clientEnv }: InvokeArgs,
  text: string,
): Promise<string> {
  const [
    { ignorePath },
    fileName,
    task,
    { config, configPrecedence, editorconfig, ...cliOptions },
  ] = parseCLIArguments(args);
  const env = { ...process.env, ...clientEnv };
  const fullPath = resolveFile(cwd, fileName);
  const resolvedPrettier = await resolvePrettier(env, path.dirname(fullPath));
  if (!resolvedPrettier) {
    return text;
  }

  const { module: prettier } = resolvedPrettier;
  const { ignored } = await prettier.getFileInfo(fileName, { ignorePath });
  if (ignored) {
    return text;
  }

  const fileOptions = await resolveConfig(env, prettier, fullPath, {
    config,
    editorconfig,
  });

  const options: Record<string, unknown> =
    configPrecedence === "prefer-file" && fileOptions !== null
      ? fileOptions
      : configPrecedence === "file-override"
        ? { ...cliOptions, ...fileOptions }
        : { ...fileOptions, ...cliOptions };

  switch (task) {
    case "format":
      return await prettier.format(text, {
        ...options,
        filepath: fullPath,
      });
    case "check":
      const valid = await prettier.check(text, {
        ...options,
        filepath: fullPath,
      });
      if (!valid) throw `Invalid formatting: ${fullPath}`;
      return "";
  }
}

export type DebugInfo = {
  resolvedPrettier?: ResolvedPrettier;
};

export async function getDebugInfo(
  cwd: string,
  args: string[],
): Promise<DebugInfo> {
  const [_, fileName] = parseCLIArguments(args);
  const fullPath = resolveFile(cwd, fileName);

  const resolvedPrettier = await resolvePrettier(process.env, fullPath);

  return { resolvedPrettier };
}

export async function stopAll(
  runtimeDir: string,
  prefix: string,
): Promise<void> {
  const files = await readdir(runtimeDir);
  const coredFiles = files.filter((file) => file.startsWith(prefix));

  // this is horrible
  for (const file of coredFiles) {
    process.env.CORE_D_DOTFILE = file;

    const core_d = require("core_d");
    const stop = promisify(core_d.stop);
    await stop();

    // core_d will cache the value of CORE_D_DOTFILE, so we have to clear the
    // cache.
    //
    // Alternatively, we could read the file and submit the stop command over
    // TCP, but let's keep this horrible approach for now.
    for (const key of Object.keys(require.cache)) {
      if (key.includes("/core_d/")) {
        delete require.cache[key];
      }
    }

    console.log(`stopped ${file}`);
  }
}

export function invoke(
  cwd: string,
  args: InvokeArgs | [string, InvokeArgs],
  text: string,
  cb: (_err?: string, _resp?: string) => void,
): void {
  if (Array.isArray(args)) {
    args = { ...args[1], args: [args[0], ...args[1].args] };
  }
  run(cwd, args, text)
    .then((resp) => void cb(undefined, resp))
    .catch((error) => void cb(error));
}
