import {describe,it,expect} from 'vitest';
import {hashPassword,checkPassword,randomToken,sha256} from '../src/auth/crypto';
describe('auth primitives',()=>{
 it('hashes and checks passwords with unique salts',async()=>{const a=await hashPassword('long-password-123');const b=await hashPassword('long-password-123');expect(a.hash).not.toBe(b.hash);expect(await checkPassword('long-password-123',a.salt,a.hash)).toBe(true);expect(await checkPassword('wrong',a.salt,a.hash)).toBe(false);});
 it('generates unpredictable token shapes',async()=>{const a=randomToken(),b=randomToken();expect(a).toMatch(/^[a-f0-9]{64}$/);expect(a).not.toBe(b);expect(await sha256(a)).not.toBe(a);});
});
