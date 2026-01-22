const encryption = require('../../utils/encryption');

describe('Encryption Service', () => {
    describe('encrypt/decrypt', () => {
        it('should encrypt and decrypt text correctly', () => {
            const plaintext = 'my_secret_password123';

            const encrypted = encryption.encrypt(plaintext);

            // Verify encrypted object structure
            expect(encrypted).toHaveProperty('encrypted');
            expect(encrypted).toHaveProperty('iv');
            expect(encrypted).toHaveProperty('authTag');
            expect(typeof encrypted.encrypted).toBe('string');
            expect(typeof encrypted.iv).toBe('string');
            expect(typeof encrypted.authTag).toBe('string');

            // Decrypt and verify
            const decrypted = encryption.decrypt(encrypted);
            expect(decrypted).toBe(plaintext);
        });

        it('should produce different ciphertext for same input (random IV)', () => {
            const plaintext = 'test_password';

            const enc1 = encryption.encrypt(plaintext);
            const enc2 = encryption.encrypt(plaintext);

            // Different ciphertext and IV
            expect(enc1.encrypted).not.toBe(enc2.encrypted);
            expect(enc1.iv).not.toBe(enc2.iv);

            // But both should decrypt to the same value
            expect(encryption.decrypt(enc1)).toBe(plaintext);
            expect(encryption.decrypt(enc2)).toBe(plaintext);
        });

        it('should handle empty string', () => {
            const plaintext = '';

            const encrypted = encryption.encrypt(plaintext);
            const decrypted = encryption.decrypt(encrypted);

            expect(decrypted).toBe(plaintext);
        });

        it('should handle unicode characters', () => {
            const plaintext = 'Contraseña123 ñáéíóú 中文 🔒';

            const encrypted = encryption.encrypt(plaintext);
            const decrypted = encryption.decrypt(encrypted);

            expect(decrypted).toBe(plaintext);
        });

        it('should throw on invalid auth tag', () => {
            const encrypted = encryption.encrypt('test');

            // Corrupt the auth tag
            encrypted.authTag = '00'.repeat(16);

            expect(() => encryption.decrypt(encrypted)).toThrow();
        });

        it('should throw on invalid IV', () => {
            const encrypted = encryption.encrypt('test');

            // Corrupt the IV
            encrypted.iv = 'invalid';

            expect(() => encryption.decrypt(encrypted)).toThrow();
        });

        it('should throw on tampered ciphertext', () => {
            const encrypted = encryption.encrypt('test');

            // Tamper with the encrypted data
            encrypted.encrypted = encrypted.encrypted.substring(0, encrypted.encrypted.length - 4) + '0000';

            expect(() => encryption.decrypt(encrypted)).toThrow();
        });
    });

    describe('security properties', () => {
        it('should generate different IVs for each encryption', () => {
            const ivs = new Set();

            for (let i = 0; i < 100; i++) {
                const encrypted = encryption.encrypt('test');
                ivs.add(encrypted.iv);
            }

            // All IVs should be unique
            expect(ivs.size).toBe(100);
        });

        it('should produce ciphertext of reasonable length', () => {
            const plaintext = 'short';
            const encrypted = encryption.encrypt(plaintext);

            // Encrypted should be longer than plaintext (hex encoding + padding)
            expect(encrypted.encrypted.length).toBeGreaterThan(plaintext.length);

            // IV should be 32 chars (16 bytes in hex)
            expect(encrypted.iv.length).toBe(32);

            // AuthTag should be 32 chars (16 bytes in hex)
            expect(encrypted.authTag.length).toBe(32);
        });
    });
});
