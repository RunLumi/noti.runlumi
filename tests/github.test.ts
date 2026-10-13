import {describe,it,expect} from 'vitest';
import {classifyGithubEvent,verifyGithubSignature} from '../src/connectors/sources/github/events';
describe('GitHub source',()=>{
 it('distinguishes merged and closed PRs',()=>{expect(classifyGithubEvent('pull_request',{action:'closed',pull_request:{merged:true}})).toBe('pull_request.merged');expect(classifyGithubEvent('pull_request',{action:'closed',pull_request:{merged:false}})).toBe('pull_request.closed');});
 it('classifies completed workflow by conclusion',()=>{expect(classifyGithubEvent('workflow_run',{action:'completed',workflow_run:{conclusion:'failure'}})).toBe('workflow_run.failure');});
 it('rejects malformed signatures',async()=>{expect(await verifyGithubSignature('{}','sha256=abc','secret')).toBe(false);});
 it('accepts valid HMAC and rejects modified body',async()=>{
 const body='{"repository":{"full_name":"example/repo"}}', secret='top-secret';
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body)));
 const signature='sha256='+[...digest].map(x=>x.toString(16).padStart(2,'0')).join('');
 expect(await verifyGithubSignature(body,signature,secret)).toBe(true);
 expect(await verifyGithubSignature(body+' ',signature,secret)).toBe(false);
 });
});
