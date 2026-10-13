export type LarkEvent = { title: string; url: string; repo?: string; actor?: string; status?: 'success'|'failure'|'info' };
export async function larkSignature(secret: string, timestamp: number): Promise<string> {
  // Lark custom bot signature: base64(HMAC-SHA256(key=timestamp + "\n" + secret, message="")).
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(timestamp+'\n'+secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=await crypto.subtle.sign('HMAC',key,new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}
export function larkCard(event: LarkEvent) {
  const color=event.status==='failure'?'red':event.status==='success'?'green':'blue';
  const text=[event.repo,event.actor?'By '+event.actor:undefined].filter(Boolean).join(' · ');
  return {schema:'2.0',config:{enable_forward:true},header:{title:{tag:'plain_text',content:event.title.slice(0,200)},template:color},body:{elements:[
    ...(text?[{tag:'markdown',content:text.slice(0,500)}]:[]),
    {tag:'markdown',content:event.url?'[Open in source]('+event.url+')':'Source link unavailable'}
  ]}};
}
export async function larkPayload(event:LarkEvent, secret?:string, now=Date.now()) {
  const payload:Record<string,unknown>={msg_type:'interactive',card:larkCard(event)};
  if(secret){const timestamp=Math.floor(now/1000);payload.timestamp=String(timestamp);payload.sign=await larkSignature(secret,timestamp);}
  return payload;
}
export function larkAccepted(body:unknown):boolean {
  if(!body||typeof body!=='object')return false;
  const obj=body as Record<string,unknown>;
  return obj.code===0||obj.StatusCode===0;
}
