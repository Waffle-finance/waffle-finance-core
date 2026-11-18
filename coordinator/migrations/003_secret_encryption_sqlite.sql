-- Migration: 003_secret_encryption
-- Adds a preimage_enc_version column to track how each preimage row is stored.
--
-- Storage format by enc_version value:
--   NULL  → plaintext hex string (legacy rows / encryption disabled)
--   1     → AES-256-GCM authenticated encryption
--           (base64url blob: version(1) || iv(12) || authTag(16) || ciphertext(N))
--
-- All existing rows default to NULL (plaintext), preserving backwards
-- compatibility with coordinators that have not set SECRET_STORAGE_KEY.
--
-- When SECRET_STORAGE_KEY is configured the coordinator writes enc_version=1
-- for every new secret reveal.  Existing plaintext rows are decrypted
-- transparently on read — they are NOT automatically re-encrypted.
-- A separate re-encryption migration job can be run offline if required.

ALTER TABLE orders
  ADD COLUMN preimage_enc_version INTEGER DEFAULT NULL;
