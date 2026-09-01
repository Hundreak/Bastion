'use strict'

const crypto = require('crypto')

/**
 * Host key policy, separated from Electron so it can be tested.
 *
 * ssh2 documents its default as "auto-accept if hostVerifier is not set", and
 * this client never set one. Every host key was therefore trusted, including a
 * substituted one — on sessions that log in as an administrator and then type
 * commands into a shell.
 */

/** The SHA-256 fingerprint OpenSSH prints, from a raw host key. */
function fingerprint(hostKey) {
  return crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')
}

/**
 * Trust-on-first-use.
 *
 * `first-seen` records and allows; `known` allows; `mismatch` refuses. The
 * mismatch is the case that actually indicates interception, and it is refused
 * rather than prompted: a dialog at that moment is answered "yes" by someone
 * who wants their terminal, and the one time it matters is the one time that
 * answer is wrong.
 */
function decideHostKey(knownFingerprint, actualFingerprint) {
  if (!actualFingerprint) return { status: 'mismatch', trust: false }
  if (!knownFingerprint) return { status: 'first-seen', trust: true, remember: true }
  if (knownFingerprint === actualFingerprint) return { status: 'known', trust: true }
  return { status: 'mismatch', trust: false, expected: knownFingerprint }
}

module.exports = { fingerprint, decideHostKey }
