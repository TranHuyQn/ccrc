// Turning a Web Push subscription into something a person can recognise on a
// list, and delete.
//
// A subscription carries nothing about the device it belongs to: an endpoint
// URL and two keys, and that is all. So "5 thiết bị" was the entire truth the
// hub could tell — with no way to know that four of them were the same iPhone,
// re-subscribed each time the PWA was reinstalled.
//
// Two things fix that, and only one of them helps retroactively:
//   · the push service host is in the endpoint, so Apple/Google/Mozilla can be
//     read off entries that already exist
//   · a label and a date can be recorded from now on, at subscribe time
//
// Entries stored before this simply have no label and no date. They are shown
// as such rather than guessed at.
import crypto from 'node:crypto';

// The endpoint is a capability: whoever holds it, plus the VAPID key, can push
// to that device. So the browser is given a hash to name a device by, never
// the endpoint itself.
export function deviceId(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16);
}

const SERVICES = [
  [/\.push\.apple\.com$/i, 'Apple'],
  [/(^|\.)fcm\.googleapis\.com$/i, 'Google'],
  [/(^|\.)android\.googleapis\.com$/i, 'Google'],
  [/(^|\.)push\.services\.mozilla\.com$/i, 'Mozilla'],
  [/(^|\.)notify\.windows\.com$/i, 'Microsoft'],
];

// Which push service the endpoint belongs to. Not the device, but it is the
// one fact every subscription carries — enough to tell an iPhone apart from a
// Chrome browser without storing anything new.
export function serviceOf(endpoint) {
  let host;
  try {
    host = new URL(String(endpoint)).host;
  } catch {
    return 'không rõ';
  }
  for (const [re, name] of SERVICES) if (re.test(host)) return name;
  return host;
}

// A short, human label derived from the user agent AT SUBSCRIBE TIME.
//
// Derived and then thrown away rather than stored raw: a full user-agent
// string is a fingerprint, and none of it is needed beyond "which of my
// devices is this". Returns '' when there is nothing usable, and the caller
// stores no label at all rather than a guess.
export function labelFromUserAgent(ua) {
  if (typeof ua !== 'string' || !ua) return '';
  const s = ua.slice(0, 400);
  const os = /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Android/.test(s) ? 'Android'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac'
    : /Windows/.test(s) ? 'Windows'
    : /Linux/.test(s) ? 'Linux'
    : '';
  // Order matters: every one of these puts "Safari" in its UA, and Chrome on
  // iOS calls itself CriOS. Most specific first.
  const browser = /EdgiOS|Edg\//.test(s) ? 'Edge'
    : /CriOS|Chrome\//.test(s) ? 'Chrome'
    : /FxiOS|Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari'
    : '';
  return [os, browser].filter(Boolean).join(' · ');
}

// The public shape of one device. Never includes the endpoint or the keys.
export function toPublicDevice(sub, currentEndpoint) {
  return {
    id: deviceId(sub.endpoint),
    label: typeof sub.label === 'string' && sub.label ? sub.label : '',
    service: serviceOf(sub.endpoint),
    addedAt: typeof sub.addedAt === 'number' ? sub.addedAt : null,
    current: typeof currentEndpoint === 'string' && currentEndpoint === sub.endpoint,
  };
}

export function listDevices(subs, currentEndpoint) {
  return (subs || []).map((s) => toPublicDevice(s, currentEndpoint));
}
