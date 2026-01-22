const crypto = require('crypto');
const { machineIdSync } = require('node-machine-id');

class Encryption {
    constructor() {
        this.algorithm = 'aes-256-gcm';
        const machineId = machineIdSync({ original: true });
        this.key = crypto.scryptSync(machineId, 'screens-salt-v1', 32);
    }

    /**
     * Encrypt a plaintext string
     * @param {string} text - Plaintext to encrypt
     * @returns {Object} Encrypted data with iv and authTag
     */
    encrypt(text) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();

        return {
            encrypted,
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex')
        };
    }

    /**
     * Decrypt encrypted data
     * @param {Object} encryptedData - Object with encrypted, iv, and authTag
     * @returns {string} Decrypted plaintext
     * @throws {Error} If decryption fails or auth tag is invalid
     */
    decrypt(encryptedData) {
        const decipher = crypto.createDecipheriv(
            this.algorithm,
            this.key,
            Buffer.from(encryptedData.iv, 'hex')
        );

        decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));

        let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }
}

module.exports = new Encryption();
