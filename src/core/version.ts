import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

export function getVersion(): string {
  return version;
}
