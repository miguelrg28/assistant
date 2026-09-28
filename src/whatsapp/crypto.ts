import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** AES-256-GCM ciphertext as stored in `whatsapp_account.token_encrypted`. */
export interface EncryptedValue {
  iv: string
  authTag: string
  data: string
}

/** Accepts 64 hex chars or base64 that decodes to exactly 32 bytes. */
export function parseKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('WHATSAPP_TOKEN_KEY must be 32 bytes (openssl rand -base64 32)')
  return key
}

export function encrypt(text: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function decrypt(value: EncryptedValue, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')
}
