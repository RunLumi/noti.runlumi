import {describe,it,expect} from 'vitest';
import {larkSignature,larkPayload,larkCard,larkAccepted} from '../src/connectors/destinations/lark/webhook';
describe('Lark webhook adapter',()=>{
  it('signs deterministically',async()=>{expect(await larkSignature('secret',123456)).toBe(await larkSignature('secret',123456));expect(await larkSignature('other',123456)).not.toBe(await larkSignature('secret',123456));});
  it('omits optional signature',async()=>{const p=await larkPayload({title:'Issue',url:'https://github.com/example/repo/issues/1'});expect(p.sign).toBeUndefined();});
  it('includes timestamp and signature when configured',async()=>{const p=await larkPayload({title:'Issue',url:'https://github.com/example/repo/issues/1'},'secret',123456000);expect(p.timestamp).toBe('123456');expect(p.sign).toBe(await larkSignature('secret',123456));});
  it('renders a status-aware card',()=>{expect(larkCard({title:'Failed',url:'https://github.com/example',status:'failure'}).header.template).toBe('red');});
  it('checks Lark response status',()=>{expect(larkAccepted({code:0})).toBe(true);expect(larkAccepted({code:19001})).toBe(false);expect(larkAccepted({})).toBe(false);});
});
