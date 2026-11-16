// What the user is told when something fails: a general description and what to do, per code
// (_locales: error_<CODE>). The raw message of the error (English, for developers) never reaches the
// screen; it goes to the console. Codes: core's ErrorCode, plus the extension's own (NO_TAB, BUSY,
// NO_RESPONSE, UNKNOWN) and one per action of the panel (SAVE, COPY, DELETE, FOLDER).
import { t } from './i18n.js';

export function describeError(code) {
  const key = `error.${code}`;
  const text = t(key);
  return text === key ? t('error.UNKNOWN') : text;
}
