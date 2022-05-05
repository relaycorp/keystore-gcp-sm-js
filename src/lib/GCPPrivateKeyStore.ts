import { Datastore } from '@google-cloud/datastore';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import {
  derDeserializeRSAPublicKey,
  getPrivateAddressFromIdentityKey,
  IdentityKeyPair,
  PrivateKeyStore,
  RSAKeyGenOptions,
  SessionPrivateKeyData,
} from '@relaycorp/relaynet-core';

import { DatastoreIdentityKeyEntity } from './gcp/DatastoreIdentityKeyEntity';
import { GcpKmsError } from './gcp/GcpKmsError';
import { GcpKmsRsaPssPrivateKey } from './gcp/GcpKmsRsaPssPrivateKey';
import { GcpKmsRsaPssProvider } from './gcp/GcpKmsRsaPssProvider';
import { GcpOptions } from './gcp/GcpOptions';

export interface GCPKeyOptions {
  readonly kmsKeyRing: string;
  readonly kmsKey: string;
}

const ID_KEY_DATASTORE_KIND = 'identity_keys';

export class GCPPrivateKeyStore extends PrivateKeyStore {
  constructor(
    protected kmsClient: KeyManagementServiceClient,
    protected datastoreClient: Datastore,
    protected identityKeyOptions: GCPKeyOptions,
    protected sessionKeyOptions: GCPKeyOptions,
    protected gcpOptions: GcpOptions,
    protected rsaPSSProvider: GcpKmsRsaPssProvider,
  ) {
    super();
  }

  public async retrieveIdentityKey(privateAddress: string): Promise<CryptoKey | null> {
    throw new Error('implement ' + privateAddress);
  }

  public override async generateIdentityKeyPair(
    options: Partial<RSAKeyGenOptions> = {},
  ): Promise<IdentityKeyPair> {
    const kmsKeyName = this.kmsClient.cryptoKeyPath(
      this.gcpOptions.projectId,
      this.gcpOptions.location,
      this.identityKeyOptions.kmsKeyRing,
      this.identityKeyOptions.kmsKey,
    );
    await this.validateExistingSigningKey(kmsKeyName, options);

    const isInitialKeyVersionLinked = await this.isInitialKeyVersionLinked();
    const kmsKeyVersionPath = await this.getOrCreateKMSVersion(
      kmsKeyName,
      isInitialKeyVersionLinked,
    );

    const privateKey = new GcpKmsRsaPssPrivateKey(kmsKeyVersionPath);
    const kmsPublicKeySerialized = await this.rsaPSSProvider.onExportKey('spki', privateKey);
    const publicKey = await derDeserializeRSAPublicKey(kmsPublicKeySerialized);
    const privateAddress = await getPrivateAddressFromIdentityKey(publicKey);

    await this.linkKMSKeyVersion(kmsKeyVersionPath, privateAddress, isInitialKeyVersionLinked);

    return { privateAddress, privateKey, publicKey };
  }

  protected async saveIdentityKey(privateAddress: string, privateKey: CryptoKey): Promise<void> {
    throw new Error('implement ' + privateAddress + privateKey);
  }

  protected async retrieveSessionKeyData(keyId: string): Promise<SessionPrivateKeyData | null> {
    throw new Error('implement ' + keyId);
  }

  protected async saveSessionKeySerialized(
    keyId: string,
    keySerialized: Buffer,
    peerPrivateAddress?: string,
  ): Promise<void> {
    throw new Error('implement ' + keyId + keySerialized + peerPrivateAddress);
  }

  private async validateExistingSigningKey(
    kmsKeyName: string,
    options: Partial<RSAKeyGenOptions>,
  ): Promise<void> {
    const [kmsKey] = await this.kmsClient.getCryptoKey({ name: kmsKeyName });
    const keyAlgorithm = kmsKey.versionTemplate!.algorithm as string;
    if (!keyAlgorithm.startsWith('RSA_SIGN_PSS_')) {
      throw new GcpKmsError(`Key ${kmsKeyName} is not an RSA-PSS key`);
    }

    const requiredRSAModulus = options.modulus ?? 2048;
    if (!keyAlgorithm.includes(`_${requiredRSAModulus}_`)) {
      throw new GcpKmsError(`Key ${kmsKeyName} does not use modulus ${requiredRSAModulus}`);
    }

    const requiredHashingAlgorithm = options.hashingAlgorithm ?? 'SHA-256';
    if (!keyAlgorithm.endsWith(requiredHashingAlgorithm.replace('-', ''))) {
      throw new GcpKmsError(`Key ${kmsKeyName} does not use ${requiredHashingAlgorithm}`);
    }
  }

  private async getOrCreateKMSVersion(
    kmsKeyName: string,
    isInitialKeyVersionLinked: boolean,
  ): Promise<string> {
    if (isInitialKeyVersionLinked) {
      // Version 1 of the KMS key was already assigned, so create a new version.
      const [kmsVersionResponse] = await this.kmsClient.createCryptoKeyVersion({
        parent: kmsKeyName,
      });
      return kmsVersionResponse.name!;
    }

    // Version 1 of the KMS key is unassigned so let's assign it by registering it on Datastore
    return this.kmsClient.cryptoKeyVersionPath(
      this.gcpOptions.projectId,
      this.gcpOptions.location,
      this.identityKeyOptions.kmsKeyRing,
      this.identityKeyOptions.kmsKey,
      '1', // TODO: GET LATEST VERSION INSTEAD
    );
  }

  //region Identity key linking

  private async isInitialKeyVersionLinked(): Promise<boolean> {
    const query = this.datastoreClient
      .createQuery(ID_KEY_DATASTORE_KIND)
      .select('version')
      .filter('key', '=', this.identityKeyOptions.kmsKey)
      .limit(1);
    const [entities] = await this.datastoreClient.runQuery(query);
    return !!entities.length;
  }

  private async linkKMSKeyVersion(
    kmsKeyVersionPath: string,
    privateAddress: string,
    isInitialKeyVersionLinked: boolean,
  ): Promise<void> {
    const datastoreKey = this.datastoreClient.key([ID_KEY_DATASTORE_KIND, privateAddress]);
    const identityKeyEntity: DatastoreIdentityKeyEntity = {
      key: this.identityKeyOptions.kmsKey,
      version: this.kmsClient.matchCryptoKeyVersionFromCryptoKeyVersionName(
        kmsKeyVersionPath,
      ) as string,
    };
    await this.datastoreClient.save({
      data: identityKeyEntity,
      excludeFromIndexes: ['version', ...(isInitialKeyVersionLinked ? ['key'] : [])],
      key: datastoreKey,
    });
  }

  //endregion
}
