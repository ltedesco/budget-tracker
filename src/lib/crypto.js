// Passphrase-encrypted token storage.
//
// The sync token is a credential with write access to a private repo, and
// GitHub Pages project sites all share one origin (`<user>.github.io`), so
// localStorage here is readable by any other Pages site on the same account.
// Keeping the token as plaintext there is the thing worth fixing.
//
// So: the token is encrypted at rest with a passphrase, and only ever exists
// in the clear in memory (and, if the device is trusted, sessionStorage, which
// dies with the tab). AES-GCM with a PBKDF2-SHA256 derived key.

const PBKDF2_ITERATIONS = 310_000 // OWASP guidance for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16
const IV_BYTES = 12 // 96-bit nonce, the size AES-GCM is specified for

const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('This browser has no Web Crypto support, so the token cannot be encrypted.')
  return s
}

const bytesToB64 = (bytes) => {
  let binary = ''
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b)
  return btoa(binary)
}

const b64ToBytes = (b64) => {
  const binary = atob(b64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function deriveKey(passphrase, salt) {
  const base = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// --- reusable primitives ------------------------------------------------
//
// The app lock encrypts whole budget documents, which is the same operation
// on a much larger payload and many more times. Deriving a key costs 310,000
// PBKDF2 rounds, so it is done ONCE at unlock and the CryptoKey is held in
// memory; every save reuses it. Re-deriving per save would make typing in the
// grid unusable.

export const randomSaltB64 = () => bytesToB64(globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES)))

/** Derive the AES key for a passphrase and a stored salt. */
export const keyFor = (passphrase, saltB64) => deriveKey(passphrase, b64ToBytes(saltB64))

/** Encrypt text under an already-derived key. */
export async function encryptWith(key, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text),
  )
  return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) }
}

/**
 * Decrypt an envelope. AES-GCM is authenticated, so a wrong key throws rather
 * than returning plausible rubbish — which is what makes "did it decrypt?" a
 * sound passphrase check on its own.
 */
export async function decryptWith(key, envelope) {
  if (!envelope?.ct || !envelope?.iv) throw new Error('Nothing to decrypt.')
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) },
    key,
    b64ToBytes(envelope.ct),
  )
  return new TextDecoder().decode(plain)
}

/** Whether a stored value is one of our envelopes rather than a plain document. */
export const isEnvelope = (v) => Boolean(v && typeof v === 'object' && v.ct && v.iv)

/** Encrypt a token. Returns a JSON-serialisable envelope safe to store. */
export async function encryptToken(token, passphrase) {
  if (!token) throw new Error('No token to encrypt.')
  if (!passphrase) throw new Error('Set a passphrase first.')
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(passphrase, salt)
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token),
  )
  return { v: 1, salt: bytesToB64(salt), iv: bytesToB64(iv), ct: bytesToB64(ct) }
}

/**
 * Decrypt a token. A wrong passphrase fails the GCM tag check, which surfaces
 * as an OperationError — reported as a wrong passphrase rather than leaking
 * the raw crypto error.
 */
export async function decryptToken(envelope, passphrase) {
  if (!envelope || envelope.v !== 1) throw new Error('Saved token is missing or in an unknown format.')
  if (!passphrase) throw new Error('Enter your passphrase.')
  const key = await deriveKey(passphrase, b64ToBytes(envelope.salt))
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) },
      key,
      b64ToBytes(envelope.ct),
    )
    return new TextDecoder().decode(plain)
  } catch {
    throw new Error('Wrong passphrase.')
  }
}

export const hasEncryptedToken = (sync) => Boolean(sync?.tokenEnc?.ct)

// --- setup code -------------------------------------------------------------
//
// Moving sync to a new device means carrying the encrypted token plus the
// repo settings. A setup code is exactly that, base64'd into one line you can
// AirDrop or message to yourself (or to the other person).
//
// It is deliberately NOT published anywhere. The app repo is public, so a blob
// committed there could be fetched by anyone and brute-forced offline with no
// rate limit. Kept off the internet, an attacker needs the code *and* the
// passphrase, which is what lets the passphrase stay memorable.
//
// The code still contains your encrypted token: treat it like a password, not
// like a share link.

const SETUP_PREFIX = 'budget-setup-v1.'

/** Pack sync settings + the encrypted token into one transferable line. */
export function makeSetupCode(sync) {
  if (!sync?.tokenEnc?.ct) throw new Error('Save an encrypted token first.')
  const payload = {
    owner: sync.owner,
    repo: sync.repo,
    branch: sync.branch || 'main',
    path: sync.path,
    tokenEnc: sync.tokenEnc,
  }
  const json = new TextEncoder().encode(JSON.stringify(payload))
  let binary = ''
  for (const b of json) binary += String.fromCharCode(b)
  return SETUP_PREFIX + btoa(binary)
}

/**
 * Unpack a setup code. Returns the settings to apply; the token inside stays
 * encrypted, so the passphrase is still required to actually unlock it.
 */
export function readSetupCode(code) {
  const trimmed = String(code || '').trim()
  if (!trimmed.startsWith(SETUP_PREFIX)) {
    throw new Error('That does not look like a setup code.')
  }
  let parsed
  try {
    const binary = atob(trimmed.slice(SETUP_PREFIX.length))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('Setup code is damaged — copy it again, all on one line.')
  }
  if (!parsed?.owner || !parsed?.repo || !parsed?.path || !parsed?.tokenEnc?.ct) {
    throw new Error('Setup code is missing some settings.')
  }
  return {
    owner: String(parsed.owner),
    repo: String(parsed.repo),
    branch: String(parsed.branch || 'main'),
    path: String(parsed.path),
    tokenEnc: parsed.tokenEnc,
  }
}
