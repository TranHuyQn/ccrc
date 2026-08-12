// Turning a failed web-push send into something worth reading in the log.
//
// `web-push` rejects with a `WebPushError` whose `.body` is the push
// service's own response text — for Apple that is where the actual reason
// lives, e.g. `{"reason":"BadJwtToken"}`. Logging only `err.statusCode` (as
// this hub used to) throws that away: every failure reads as a bare number,
// and diagnosing a silently-broken iPhone means guessing which of the
// several things Apple's push service can reject with a generic-looking
// status actually happened.

/**
 * Cap on the logged body. `err.body` originates from whatever service is on
 * the other end of a subscription's endpoint — a hostile or merely verbose
 * one must not be able to grow the hub's log without bound just because a
 * push happened to fail.
 */
export const PUSH_ERROR_BODY_MAX = 500;

/**
 * Renders `err.body` from a failed `webpush.sendNotification()` call as a
 * short, loggable string. Defensive because the shape is not this hub's to
 * control: normally a string (the raw HTTP response text), sometimes an
 * object (nothing in `web-push` promises otherwise for every failure path),
 * and absent entirely for failures that never got a response (DNS, timeout).
 */
export function formatPushErrorBody(body, max = PUSH_ERROR_BODY_MAX) {
  if (body === undefined || body === null || body === '') return '(no body)';
  let text;
  if (typeof body === 'string') {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  if (text.length > max) {
    return `${text.slice(0, max)}… (cắt, dài ${text.length} ký tự)`;
  }
  return text;
}
