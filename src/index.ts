import { createAuth, type AuthBindings } from './auth/better-auth';
import workspace from './auth/workspace';
import {classifyGithubEvent,verifyGithubSignature} from './connectors/sources/github/events';
import { larkPayload, larkAccepted } from './connectors/destinations/lark/webhook';
import { Hono } from 'hono';
type Bindings = AuthBindings & { DELIVERY_QUEUE: Queue<Delivery>; GITHUB_WEBHOOK_SECRET: string; ENCRYPTION_KEY: string };
type Delivery = { id: string; integrationId: string; destination: 'lark'|'slack'; ciphertext: string; larkSecretCiphertext?: string | null; title: string; url: string };
const app = new Hono<{Bindings: Bindings}>();
const enc = new TextEncoder();
async function decrypt(ciphertext:string, keyHex:string) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw Error('Invalid encryption key');
  const raw = Uint8Array.from(keyHex.match(/../g)!,x=>parseInt(x,16));
  const key = await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
  const bytes = Uint8Array.from(atob(ciphertext),c=>c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12)));
}
app.all('/api/auth/*', (c) => createAuth(c.env, c.executionCtx).handler(c.req.raw));
app.route('/api/workspace', workspace);
app.get('/health',c=>c.json({ok:true,service:'lumi-noti'}));
app.post('/webhooks/github',async c=>{
  if (!c.env.GITHUB_WEBHOOK_SECRET) return c.text('Not configured',503);
  if (Number(c.req.header('content-length')||0)>1024*1024) return c.text('Too large',413);
  const body=await c.req.text();
  if (enc.encode(body).length>1024*1024) return c.text('Too large',413);
  if (!await verifyGithubSignature(body,c.req.header('x-hub-signature-256')||'',c.env.GITHUB_WEBHOOK_SECRET)) return c.text('Unauthorized',401);
  let event: any; try {event=JSON.parse(body);} catch {return c.text('Invalid JSON',400);}
  const repo=event.repository?.full_name;
  const kind=c.req.header('x-github-event')||'';
  const eventType=classifyGithubEvent(kind,event);
  const deliveryId=c.req.header('x-github-delivery');
  if (!repo||!deliveryId) return c.text('Invalid event',400);
  const rows=await c.env.DB.prepare('SELECT id,destination,webhook_ciphertext,lark_secret_ciphertext,event_types FROM integrations WHERE repo=? AND enabled=1').bind(repo).all<{id:string;destination:'lark'|'slack';webhook_ciphertext:string;lark_secret_ciphertext:string|null;event_types:string}>();
  let queued=0;
  for(const row of rows.results) {
    let types:string[]; try {types=JSON.parse(row.event_types);}catch{continue;}
    if(!types.includes(eventType))continue;
    const id=deliveryId+':'+row.id;
    
    const obj=event.issue||event.pull_request||event.workflow_run||event;
    const title=String(obj.title||obj.name||eventType).slice(0,300);
    const url=String(obj.html_url||event.repository.html_url||'');
    const payload:Delivery={id,integrationId:row.id,destination:row.destination,ciphertext:row.webhook_ciphertext,larkSecretCiphertext:row.lark_secret_ciphertext,title,url};
    const results=await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR IGNORE INTO deliveries(id,integration_id,state) VALUES(?,?,'pending')").bind(id,row.id),
      c.env.DB.prepare("INSERT OR IGNORE INTO notification_outbox(id,payload_json) VALUES(?,?)").bind(id,JSON.stringify(payload))
    ]);
    if(results[1].meta.changes)queued++;
  }
  if(queued>0)c.executionCtx.waitUntil(dispatchOutbox(c.env));
  return c.json({accepted:true,persisted:queued},202);
});
async function dispatchOutbox(env:Bindings) {
  const rows=await env.DB.prepare("SELECT id,payload_json FROM notification_outbox WHERE state='pending' ORDER BY created_at LIMIT 50").all<{id:string;payload_json:string}>();
  for(const row of rows.results){
    try {
      const payload=JSON.parse(row.payload_json) as Delivery;
      await env.DELIVERY_QUEUE.send(payload);
      await env.DB.prepare("UPDATE notification_outbox SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=?").bind(row.id).run();
    }catch { /* Leave pending for scheduled reconciliation. */ }
  }
}
export default {fetch:app.fetch,async scheduled(_event:ScheduledEvent,env:Bindings){await dispatchOutbox(env);},async queue(batch:MessageBatch<Delivery>,env:Bindings) {
  for(const msg of batch.messages) {
    const d=msg.body;
    try {
      const url=await decrypt(d.ciphertext,env.ENCRYPTION_KEY);
      const host=new URL(url);
      const valid=d.destination==='slack'?host.hostname==='hooks.slack.com'&&host.pathname.startsWith('/services/'):['open.larksuite.com','open.feishu.cn'].includes(host.hostname)&&host.pathname.startsWith('/open-apis/bot/v2/hook/');
      if(host.protocol!=='https:'||!valid||host.username||host.password)throw Error('Destination not allowed');
      const payload=d.destination==='slack'?{text:d.title+'\n'+d.url}:await larkPayload({title:d.title,url:d.url},d.larkSecretCiphertext?await decrypt(d.larkSecretCiphertext,env.ENCRYPTION_KEY):undefined);
      const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error'});
      if(!res.ok)throw Error('Provider HTTP '+res.status);
      if(d.destination==='lark'){const reply:any=await res.json();if(!larkAccepted(reply))throw Error('Provider rejected message');}
      await env.DB.prepare("UPDATE deliveries SET state='sent',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(d.id).run();
      msg.ack();
    }catch(e) {
      await env.DB.prepare("UPDATE deliveries SET state='retrying',attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(e instanceof Error?e.message.slice(0,100):'unknown',d.id).run();
      msg.retry();
    }
  }
}};