import bcrypt from 'bcrypt';

const COST = 12;

/** @param {string} plaintext */
export function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, COST);
}

/** @param {string} plaintext @param {string} hash */
export function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}
