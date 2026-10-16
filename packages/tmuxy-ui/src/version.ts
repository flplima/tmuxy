import pkg from '../package.json';

/**
 * The build's version, read from the package at build time — the same number
 * the release bump writes everywhere else. Help ▸ About shows it.
 */
export const APP_VERSION: string = pkg.version;
