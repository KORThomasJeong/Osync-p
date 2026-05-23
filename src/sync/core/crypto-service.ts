import type { SyncedEntryMetadata } from "./content";
import type { SyncBlobCryptoContext, SyncMetadataCryptoContext } from "./crypto";
import {
  decryptSyncBlob,
  decryptSyncMetadata,
  derivePathToken,
  encryptSyncBlob,
  encryptSyncMetadata,
} from "./crypto";

export interface SyncCryptoService {
  encryptMetadata(metadata: SyncedEntryMetadata, context: SyncMetadataCryptoContext): Promise<string>;
  decryptMetadata(encryptedMetadata: string, context: SyncMetadataCryptoContext): Promise<SyncedEntryMetadata>;
  encryptBlob(plaintext: Uint8Array, context: SyncBlobCryptoContext): Promise<Uint8Array>;
  decryptBlob(encryptedBlob: Uint8Array, context: SyncBlobCryptoContext): Promise<Uint8Array>;
  derivePathToken(path: string): Promise<string>;
}

export class VaultKeyCryptoService implements SyncCryptoService {
  constructor(private readonly getKey: () => Uint8Array) {}

  encryptMetadata(metadata: SyncedEntryMetadata, context: SyncMetadataCryptoContext): Promise<string> {
    return encryptSyncMetadata(this.getKey(), metadata, context);
  }

  decryptMetadata(encryptedMetadata: string, context: SyncMetadataCryptoContext): Promise<SyncedEntryMetadata> {
    return decryptSyncMetadata(this.getKey(), encryptedMetadata, context);
  }

  encryptBlob(plaintext: Uint8Array, context: SyncBlobCryptoContext): Promise<Uint8Array> {
    return encryptSyncBlob(this.getKey(), plaintext, context);
  }

  decryptBlob(encryptedBlob: Uint8Array, context: SyncBlobCryptoContext): Promise<Uint8Array> {
    return decryptSyncBlob(this.getKey(), encryptedBlob, context);
  }

  derivePathToken(path: string): Promise<string> {
    return derivePathToken(this.getKey(), path);
  }
}
