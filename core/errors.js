/** Error codes thrown by core. Hosts can show `error.message` to the user. */
export const ErrorCode = Object.freeze({
  TOO_LARGE: 'TOO_LARGE',
  NO_ELEMENT: 'NO_ELEMENT',
  CANCELED: 'CANCELED',
  TIMEOUT: 'TIMEOUT',
  DETACHED: 'DETACHED',
  NOT_ATTACHABLE: 'NOT_ATTACHABLE',
  INVALID_OPTION: 'INVALID_OPTION',
  CDP_ERROR: 'CDP_ERROR',
});

export class CaptureError extends Error {
  /**
   * @param {string} code one of ErrorCode
   * @param {string} message
   * @param {{cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'CaptureError';
    this.code = code;
  }
}

/** Map a raw CDP/transport failure to a CaptureError (CaptureErrors pass through). */
export function fromCdpError(err) {
  if (err instanceof CaptureError) return err;
  const msg = String(err?.message ?? err);
  if (/another debugger is already attached/i.test(msg)) {
    return new CaptureError(ErrorCode.NOT_ATTACHABLE, '다른 디버거가 이미 붙어 있습니다(개발자 도구가 열려 있는지 확인하세요).', { cause: err });
  }
  if (/cannot (attach|access)|not allowed|chrome:\/\/|chrome web store/i.test(msg)) {
    return new CaptureError(ErrorCode.NOT_ATTACHABLE, '이 페이지에는 디버거를 붙일 수 없습니다.', { cause: err });
  }
  if (/could not find node|no node (found|with given id)|does not have a layout object|node is not an element/i.test(msg)) {
    return new CaptureError(ErrorCode.NO_ELEMENT, '대상 요소를 찾을 수 없거나 화면에 그려지지 않습니다.', { cause: err });
  }
  if (/target closed|detached|inspected target navigated|session with given id not found|cannot find context/i.test(msg)) {
    return new CaptureError(ErrorCode.DETACHED, '캡처 중 디버거 연결이 끊겼습니다.', { cause: err });
  }
  return new CaptureError(ErrorCode.CDP_ERROR, msg, { cause: err });
}
