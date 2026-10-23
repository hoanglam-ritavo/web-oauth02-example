import { readConfig } from '../src/config.js';

export function readWebConfig(env: NodeJS.ProcessEnv) {
  const config = readConfig(env);
  if (config.mode === 'mobile') throw new Error('Expected browser configuration in browser fixture.');
  return config;
}
