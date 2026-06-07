/**
 * Normalizes a path into the canonical key used for comparison artifacts only:
 * Dexie unique indexes (remotePathKey / localPathKey) and pathToken (HMAC) derivation.
 *
 * macOS returns filenames in NFD while the server derives pathToken from NFC, so the
 * raw forms differ and break index/token equality. NFC normalization reconciles them.
 *
 * NEVER use this for file I/O (read/write/stat/rename): localPath / remotePath must stay
 * in the OS-returned form (NFD on macOS). Do not reconstruct write paths from path keys.
 */
export const toPathKey = (p: string): string => p.normalize("NFC");

export const samePathKey = (a: string, b: string): boolean => toPathKey(a) === toPathKey(b);
