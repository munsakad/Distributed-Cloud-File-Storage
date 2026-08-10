import crypto from 'crypto';

// Every chunk is encrypted independently with AES-256-GCM (authenticated
// encryption: tampering with a stored chunk is detected on read, not just
// silently decrypted into garbage). The IV and auth tag travel alongside
// the chunk reference in the metadata store, never inside the ciphertext
// blob itself.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export interface EncryptedChunk {
  ciphertext: Buffer;
  iv: string; // hex
  authTag: string; // hex
}

function getKey(): Buffer {
  const keyHex = process.env.MASTER_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'MASTER_KEY env var must be a 64-character hex string (32 bytes) for AES-256. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

export function encryptChunk(plaintext: Buffer): EncryptedChunk {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv: iv.toString('hex'), authTag: authTag.toString('hex') };
}

export function decryptChunk(ciphertext: Buffer, ivHex: string, authTagHex: string): Buffer {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
