import { describe, it, expect } from 'vitest';
import { hashPin, verifyPin } from '../server/auth';

describe('salted PIN hashing', () => {
  it('uses a different salt for equal PINs and verifies only the right PIN', async () => {
    const first=await hashPin('123456'); const second=await hashPin('123456');
    expect(first).not.toBe(second);expect(first).not.toContain('123456');
    expect(await verifyPin('123456',first)).toBe(true);
    expect(await verifyPin('654321',first)).toBe(false);
  });
  it('rejects weak input and malformed stored hashes', async () => {
    await expect(hashPin(123456 as unknown as string)).rejects.toMatchObject({status:400});
    await expect(hashPin('1234')).rejects.toThrow();
    await expect(hashPin('abcdef')).rejects.toThrow();
    expect(await verifyPin('123456','plain-text')).toBe(false);
    expect(await verifyPin('123456','scrypt$bad$bad')).toBe(false);
  });
});
