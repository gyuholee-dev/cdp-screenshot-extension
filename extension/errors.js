// What the user is told when something fails: a general description and what to do, per code
// (_locales: error_<CODE>). The raw message of the error (English, for developers) never reaches the
// screen; it goes to the console. Codes: core's ErrorCode, plus the extension's own (NO_TAB, BUSY,
// NO_RESPONSE, UNKNOWN) and one per action of the panel (SAVE, COPY, DELETE, DIR).
import { DEFAULTS } from '../core/index.js';
import { t } from './i18n.js';

// the values some descriptions show: made from the `details` of the error
const PARAMS = {
  TIMEOUT: (d) => ({ sec: (d?.pickTimeoutMs ?? DEFAULTS.pickTimeoutMs) / 1000 }),
  TOO_LARGE: (d) => ({ limit: `${d?.maxSide ?? DEFAULTS.maxSidePixels}px` }),
};

export function describeError(code, details) {
  const key = `error.${code}`;
  const text = t(key, PARAMS[code]?.(details));
  return text === key ? t('error.UNKNOWN') : text;
}
