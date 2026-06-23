import { getOptions } from './options.js';

/**
 * Minimal, dependency-free leveled logger.
 * Writes "<ISO timestamp> [LEVEL] ..." to stdout/stderr, which Home Assistant
 * captures in the add-on Log tab. The threshold is read once from the
 * `log_level` option (changing it requires an add-on restart).
 */
const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 };

const configured = String(getOptions().log_level || 'info').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const prefix = `${new Date().toISOString()} [${level.toUpperCase()}]`;
  const sink = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
  sink(prefix, ...args);
}

export const log = {
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warning: (...args) => emit('warning', args),
  error: (...args) => emit('error', args),
};
