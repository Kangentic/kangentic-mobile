import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes, randomBytes } from '@kangentic/protocol';
import {
  LEGACY_PUSH_STORAGE_OPTIONS,
  PUSH_IDENTITY_PUBLIC_KEY_STORAGE_KEY,
  sharedPushStorageOptions,
  usesSharedKeychain,
} from './sharedKeychain';

const PUSH_DECRYPT_KEY_STORAGE_KEY = 'push.decrypt.key';
const LAST_REGISTERED_EXPO_TOKEN_STORAGE_KEY = 'push.expoToken.lastRegistered';

/** XChaCha20-Poly1305 key length the push envelope requires (the protocol root does not re-export its AEAD key-length constant). */
export const PUSH_KEY_LENGTH = 32;

/**
 * Mirrors src/pairing/deviceIdentity.ts: the push-decrypt key never leaves
 * the device it was generated on. A backup restored onto new hardware must
 * not carry a key the desktop still seals notifications with
 * (secure-storage.md).
 *
 * Still the right options for the Expo token, which nothing outside the app
 * reads. The push KEY itself now goes through sharedPushStorageOptions() so
 * the iOS Notification Service Extension can reach it; see sharedKeychain.ts
 * for why that one needs different accessibility.
 */
const DEVICE_BOUND_STORAGE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let cachedPushKey: Uint8Array | null = null;
let inFlightPushKey: Promise<Uint8Array> | null = null;
/**
 * Bumped by clearPushRegistration so a load that was already in flight when
 * the wipe landed cannot write its now-deleted key back into the cache.
 */
let pushKeyGeneration = 0;

/**
 * Base64url (RFC 4648 section 5, unpadded) - the encoding
 * `RegisterPushRequestPayload.pushKeyBase64` requires on the wire. The
 * protocol package implements the matching decoder internally but does not
 * export it from its root, and Hermes has no Buffer, so this is the one
 * local encoder. Pure and side-effect free for unit testing.
 */
const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64UrlEncode(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const firstByte = bytes[index];
    const secondByte = index + 1 < bytes.length ? bytes[index + 1] : null;
    const thirdByte = index + 2 < bytes.length ? bytes[index + 2] : null;
    encoded += BASE64_URL_ALPHABET[firstByte >> 2];
    encoded += BASE64_URL_ALPHABET[((firstByte & 0x03) << 4) | ((secondByte ?? 0) >> 4)];
    if (secondByte !== null) encoded += BASE64_URL_ALPHABET[((secondByte & 0x0f) << 2) | ((thirdByte ?? 0) >> 6)];
    if (thirdByte !== null) encoded += BASE64_URL_ALPHABET[thirdByte & 0x3f];
  }
  return encoded;
}

/**
 * Loads the 32-byte push-decrypt key from the Keychain/Keystore, generating
 * and persisting one on first use. The desktop receives it (base64url) via
 * the register-push verb and seals every notification envelope with it;
 * only this device can open them. The in-flight promise is shared so two
 * racing first-use callers cannot generate keys that clobber each other.
 */
export async function getOrCreatePushKey(): Promise<Uint8Array> {
  if (cachedPushKey) return cachedPushKey;
  if (!inFlightPushKey) {
    const generationAtLoadStart = pushKeyGeneration;
    inFlightPushKey = loadOrGeneratePushKey()
      .then((pushKey) => {
        // An unpair that landed mid-load wins: caching here unconditionally
        // would resurrect the just-wiped key in memory and hand it back to
        // the next getOrCreatePushKey caller in this process.
        if (generationAtLoadStart === pushKeyGeneration) cachedPushKey = pushKey;
        return pushKey;
      })
      .finally(() => {
        inFlightPushKey = null;
      });
  }
  return inFlightPushKey;
}

/**
 * The decrypt path's loader: returns null instead of generating, because a
 * freshly generated key can never open an envelope the desktop sealed with
 * the registered one - the caller degrades to the generic placeholder.
 */
export async function getPushKeyIfExists(): Promise<Uint8Array | null> {
  if (cachedPushKey) return cachedPushKey;
  const generationAtLoadStart = pushKeyGeneration;
  const storedKeyHex = await readStoredPushKeyHex();
  if (!storedKeyHex) return null;
  const pushKey = hexToBytes(storedKeyHex);
  if (pushKey.length !== PUSH_KEY_LENGTH) return null;
  // The same unpair-wins rule getOrCreatePushKey applies, and it matters more
  // here: this is the DECRYPT path, so handing back a key the wipe already
  // removed would let a push sealed by the just-unpaired desktop still open.
  // Returning null degrades that notification to the generic placeholder.
  if (generationAtLoadStart !== pushKeyGeneration) return null;
  cachedPushKey = pushKey;
  return pushKey;
}

/**
 * Reads the push key from its current home, migrating it out of the pre-NSE
 * location on first encounter.
 *
 * `kSecAttrAccessible` and the access group cannot be changed by querying an
 * existing item differently, so moving it is a genuine rewrite. The order below
 * is deliberate and interruption-safe: write the new copy, prove it reads back
 * through the NEW query, and only then delete the old one. Deleting first (or
 * trusting the write) risks taking the only copy of a key the desktop still
 * seals against, and the resulting failure is silent - every push degrades to
 * the generic placeholder, which looks exactly like an NSE that never ran.
 *
 * Migration is iOS-only. Off iOS both option sets produce the same query, so
 * the legacy read would be a pointless second round trip.
 */
async function readStoredPushKeyHex(): Promise<string | null> {
  const generationAtReadStart = pushKeyGeneration;
  const storageOptions = sharedPushStorageOptions();
  const currentKeyHex = await SecureStore.getItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, storageOptions);
  if (currentKeyHex) return currentKeyHex;
  if (!usesSharedKeychain()) return null;

  const legacyKeyHex = await SecureStore.getItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, LEGACY_PUSH_STORAGE_OPTIONS);
  if (!legacyKeyHex) return null;

  // An unpair that landed while the reads above were in flight wins. Migrating
  // now would WRITE the just-wiped key back into the shared group that
  // clearPushRegistration has already deleted from, resurrecting it in storage
  // rather than merely in memory, and leaving the old desktop able to push.
  if (generationAtReadStart !== pushKeyGeneration) return null;

  await SecureStore.setItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, legacyKeyHex, storageOptions);

  // The check above narrows the window but cannot close it: clearPushRegistration
  // can run its deletes WHILE the write is in flight, so the write lands after
  // the wipe has already been and gone and the revoked key is back on disk,
  // where it survives a process restart. Undo it rather than leave it there.
  // Checked after the await, which is the only place that can observe it.
  //
  // The delete is guarded on the VALUE, not just on the item existing. A re-pair
  // in the same process can already have persisted a fresh key to this location
  // by now, and deleting that one would strand the desktop sealing against a key
  // the phone can no longer produce - a permanent placeholder, which is worse
  // than the resurrection this is undoing.
  //
  // One sub-case is deliberately left open: if the stale write CLOBBERED a newer
  // key, this cannot tell that from its own write and leaves it. Closing that
  // needs a lock shared with clearPushRegistration, which is more machinery than
  // a migration that runs once per install warrants.
  if (generationAtReadStart !== pushKeyGeneration) {
    const strayKeyHex = await SecureStore.getItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, storageOptions);
    if (strayKeyHex === legacyKeyHex) {
      await SecureStore.deleteItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, storageOptions);
    }
    return null;
  }

  const readBackKeyHex = await SecureStore.getItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, storageOptions);
  if (readBackKeyHex === legacyKeyHex) {
    await SecureStore.deleteItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, LEGACY_PUSH_STORAGE_OPTIONS);
  }
  // Returned either way: the key is valid and usable even if the tidy-up did
  // not land, and the next call simply retries the migration.
  return legacyKeyHex;
}

/**
 * Persists the phone's static public key where the Notification Service
 * Extension can read it. That key is the AAD the desktop seals every envelope
 * with, and the NSE cannot derive it: deviceIdentity.ts stores only the SECRET
 * key and re-derives the public one at load, and handing an extension the
 * secret to do the same would widen its reach for no reason.
 *
 * A public key is not a secret, so copying it here is not the duplicate copy
 * secure-storage.md forbids - that clause governs the decrypt key, which moves
 * rather than being copied.
 *
 * Written from the registration path so it is always the identity the desktop
 * actually registered against, which the dev rig can make differ from the
 * persistent device identity.
 */
export async function persistNsePushIdentityPublicKey(identityPublicKey: Uint8Array): Promise<void> {
  if (!usesSharedKeychain()) return;
  await SecureStore.setItemAsync(
    PUSH_IDENTITY_PUBLIC_KEY_STORAGE_KEY,
    bytesToHex(identityPublicKey),
    sharedPushStorageOptions(),
  );
}

/**
 * PROBE ONLY (`build-ios.yml -f nse_probe=true`, src/devsupport/nseProbe.ts).
 * Overwrites both items the Notification Service Extension reads with KNOWN
 * vectors, through the SAME options every real write uses, so the runner can
 * seal a push with the same vectors and prove the extension decrypts on a
 * simulator. Refuses without a shared group: there is nowhere shared to write,
 * and seeding the private location would render a placeholder that reads
 * exactly like an extension failure. Lives here so every `push.*` key-storage
 * call site stays in this module (secure-storage.md's inventory).
 */
export async function seedSharedPushKeysForProbe(pushKey: Uint8Array, identityPublicKey: Uint8Array): Promise<void> {
  if (!usesSharedKeychain()) {
    throw new Error('No shared Keychain group is configured, so there is nowhere the extension could read a seeded key from');
  }
  if (pushKey.length !== PUSH_KEY_LENGTH || identityPublicKey.length !== PUSH_KEY_LENGTH) {
    throw new Error(`Probe vectors must be ${PUSH_KEY_LENGTH} bytes each`);
  }
  // The decrypt path must read the seeded key, never a generated one cached
  // earlier in this process: same invalidation as clearPushRegistration.
  pushKeyGeneration += 1;
  cachedPushKey = null;
  await SecureStore.setItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, bytesToHex(pushKey), sharedPushStorageOptions());
  await SecureStore.setItemAsync(PUSH_IDENTITY_PUBLIC_KEY_STORAGE_KEY, bytesToHex(identityPublicKey), sharedPushStorageOptions());
}

/**
 * The last Expo push token successfully registered with the desktop, for
 * rotation detection. The token is a per-device bearer secret
 * (docs/architecture.md), so it lives in the secure store like every other
 * long-lived secret (secure-storage.md names it explicitly).
 */
export async function getLastRegisteredExpoToken(): Promise<string | null> {
  return SecureStore.getItemAsync(LAST_REGISTERED_EXPO_TOKEN_STORAGE_KEY);
}

export async function setLastRegisteredExpoToken(expoPushToken: string): Promise<void> {
  await SecureStore.setItemAsync(LAST_REGISTERED_EXPO_TOKEN_STORAGE_KEY, expoPushToken, DEVICE_BOUND_STORAGE_OPTIONS);
}

/**
 * Unpair must leave the old desktop unable to push: without this, the
 * desktop still holds a valid (expoPushToken, pushKey) pair after
 * unpairing and can send notifications this phone will happily decrypt
 * and display. Clears both secure-store entries and the in-memory cache
 * so a subsequent re-pair on this process generates a fresh key rather
 * than reusing the wiped one.
 */
export async function clearPushRegistration(): Promise<void> {
  pushKeyGeneration += 1;
  cachedPushKey = null;
  await SecureStore.deleteItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, sharedPushStorageOptions());
  // Also the pre-NSE location: a migration that never ran, or was interrupted
  // between its write and its delete, would otherwise leave a readable key
  // behind after an unpair. Harmless when there is nothing there.
  await SecureStore.deleteItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, LEGACY_PUSH_STORAGE_OPTIONS);
  await SecureStore.deleteItemAsync(PUSH_IDENTITY_PUBLIC_KEY_STORAGE_KEY, sharedPushStorageOptions());
  await SecureStore.deleteItemAsync(LAST_REGISTERED_EXPO_TOKEN_STORAGE_KEY);
}

async function loadOrGeneratePushKey(): Promise<Uint8Array> {
  const storedKeyHex = await readStoredPushKeyHex();
  if (storedKeyHex) {
    const storedKey = hexToBytes(storedKeyHex);
    if (storedKey.length === PUSH_KEY_LENGTH) return storedKey;
  }
  const generatedKey = randomBytes(PUSH_KEY_LENGTH);
  await SecureStore.setItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, bytesToHex(generatedKey), sharedPushStorageOptions());
  return generatedKey;
}
