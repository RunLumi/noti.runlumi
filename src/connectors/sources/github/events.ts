export type GithubEvent = Record<string, unknown>;
export function classifyGithubEvent(kind: string, event: GithubEvent): string {
  const action=typeof event.action==='string'?event.action:'';
  if(kind==='pull_request'&&action==='closed'&&(event.pull_request as {merged?:boolean}|undefined)?.merged===true)return 'pull_request.merged';
  if(kind==='workflow_run'&&action==='completed'){
    const conclusion=(event.workflow_run as {conclusion?:unknown}|undefined)?.conclusion;
    if(typeof conclusion==='string')return 'workflow_run.'+conclusion;
  }
  return kind+(action?'.'+action:'');
}
export async function verifyGithubSignature(body:string,signature:string,secret:string):Promise<boolean>{
  if(!secret||!/^sha256=[a-f0-9]{64}$/.test(signature))return false;
  const bytes=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',bytes.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes.encode(body)));
  const received=new Uint8Array(signature.slice(7).match(/../g)!.map(part=>parseInt(part,16)));
  let mismatch=0;
  for(let i=0;i<digest.length;i++)mismatch|=digest[i]^received[i];
  return mismatch===0;
}
