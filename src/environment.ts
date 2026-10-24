import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'dotenv';

// Both src/environment.ts and dist/environment.js live one level below the project root.
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function loadEnvironment(
  args = process.argv.slice(2),
  processEnv: NodeJS.ProcessEnv = process.env,
  root = projectRoot,
): NodeJS.ProcessEnv {
  if (args.length > 1 || (args.length === 1 && !/^--profile=(web|mobile)$/.test(args[0]!)))
    throw new Error('Expected at most one --profile=web or --profile=mobile argument.');
  const profile = args[0]?.slice('--profile='.length);
  const filename = profile ? `.${profile}.env` : '.env';
  let values: Record<string, string> = {};
  try { values = parse(readFileSync(join(root, filename))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || profile)
      throw new Error(`Unable to read ${filename}. Create the local profile file before starting.`, { cause: error });
  }
  const env = { ...values };
  for (const [key, value] of Object.entries(processEnv)) if (value !== undefined) env[key] = value;
  if (profile && env.EXAMPLE_MODE !== profile)
    throw new Error('EXAMPLE_MODE must match the selected profile.');
  return env;
}
