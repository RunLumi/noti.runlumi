import {Hono} from 'hono';
import {checkPassword,hashPassword,randomToken,sha256} from './crypto';
type Env={DB:D1Database;AUTH_EMAIL?:SendEmail;APP_ORIGIN:string;AUTH_FROM_EMAIL:string};
type SendEmail={send:(message:unknown)=>Promise<void>};
const auth=new Hono<{Bindings:Env}>();
const now=()=>Math.floor(Date.now()/1000);
const emailOk=(s:string)=>s.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const cookie=(token:string)=>'noti_session='+token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000';
async function issue(db:D1Database,userId:string,kind:'verify'|'reset'|'session',ttl:number){const token=randomToken();await db.prepare('INSERT INTO auth_tokens(id,user_id,kind,expires_at,created_at) VALUES(?,?,?,?,?)').bind(await sha256(token),userId,kind,now()+ttl,now()).run();return token;}
async function mail(env:Env,to:string,subject:string,body:string){if(!env.AUTH_EMAIL)throw Error('Email sender unavailable');await env.AUTH_EMAIL.send({from:env.AUTH_FROM_EMAIL,to,subject,text:body});}
auth.post('/signup',async c=>{
 const p=await c.req.json().catch(()=>null) as {email?:string;password?:string;orgName?:string}|null;
 const email=p?.email?.trim().toLowerCase()||'';
 if(!emailOk(email)||!p?.password||p.password.length<12||p.password.length>128)return c.json({error:'Invalid signup data'},400);
 const userId=crypto.randomUUID(),orgId=crypto.randomUUID(),pw=await hashPassword(p.password);
 try{await c.env.DB.batch([
 c.env.DB.prepare('INSERT INTO auth_users(id,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)').bind(userId,email,pw.hash,pw.salt,now()),
 c.env.DB.prepare('INSERT INTO auth_orgs(id,name,created_at) VALUES(?,?,?)').bind(orgId,(p.orgName||'My organization').slice(0,100),now()),
 c.env.DB.prepare("INSERT INTO auth_memberships(user_id,org_id,role) VALUES(?,?,'admin')").bind(userId,orgId)]);}
 catch{return c.json({error:'Unable to create account'},409);}
 const token=await issue(c.env.DB,userId,'verify',3600);
 try{await mail(c.env,email,'Verify your Lumi Noti email',c.env.APP_ORIGIN+'/auth/verify?token='+token);}
 catch{return c.json({message:'Account created. Email delivery unavailable; contact support to verify.'},202);}
 return c.json({message:'Check your email to verify your account'},202);
});
auth.get('/verify',async c=>{
 const token=c.req.query('token')||'';if(!/^[a-f0-9]{64}$/.test(token))return c.json({error:'Invalid token'},400);
 const id=await sha256(token);
 const row=await c.env.DB.prepare("SELECT user_id FROM auth_tokens WHERE id=? AND kind='verify' AND used_at IS NULL AND expires_at>?").bind(id,now()).first<{user_id:string}>();
 if(!row)return c.json({error:'Invalid or expired token'},400);
 await c.env.DB.batch([c.env.DB.prepare('UPDATE auth_tokens SET used_at=? WHERE id=? AND used_at IS NULL').bind(now(),id),c.env.DB.prepare('UPDATE auth_users SET verified_at=? WHERE id=? AND verified_at IS NULL').bind(now(),row.user_id)]);
 return c.json({verified:true});
});
auth.post('/signin',async c=>{
 const p=await c.req.json().catch(()=>null) as {email?:string;password?:string}|null;
 const email=p?.email?.trim().toLowerCase()||'';
 if(!emailOk(email)||typeof p?.password!=='string')return c.json({error:'Invalid credentials'},401);
 const user=await c.env.DB.prepare('SELECT id,password_hash,password_salt,verified_at FROM auth_users WHERE email=?').bind(email).first<{id:string;password_hash:string|null;password_salt:string|null;verified_at:number|null}>();
 if(!user?.password_hash||!user.password_salt||!await checkPassword(p.password,user.password_salt,user.password_hash))return c.json({error:'Invalid credentials'},401);
 if(!user.verified_at)return c.json({error:'Email verification required'},403);
 const token=await issue(c.env.DB,user.id,'session',2592000);
 c.header('Set-Cookie',cookie(token));return c.json({authenticated:true});
});
auth.post('/forgot-password',async c=>{
 const p=await c.req.json().catch(()=>null) as {email?:string}|null;const email=p?.email?.trim().toLowerCase()||'';
 if(emailOk(email)){const u=await c.env.DB.prepare('SELECT id FROM auth_users WHERE email=?').bind(email).first<{id:string}>();
 if(u){const token=await issue(c.env.DB,u.id,'reset',900);try{await mail(c.env,email,'Reset your Lumi Noti password',c.env.APP_ORIGIN+'/auth/reset?token='+token);}catch{/* Do not reveal account existence. */}}}
 return c.json({message:'If the account exists, a reset email will be sent.'});
});
auth.post('/reset-password',async c=>{
 const p=await c.req.json().catch(()=>null) as {token?:string;password?:string}|null;
 if(!p?.token||!/^[a-f0-9]{64}$/.test(p.token)||!p.password||p.password.length<12||p.password.length>128)return c.json({error:'Invalid reset request'},400);
 const id=await sha256(p.token),user=await c.env.DB.prepare("SELECT user_id FROM auth_tokens WHERE id=? AND kind='reset' AND used_at IS NULL AND expires_at>?").bind(id,now()).first<{user_id:string}>();
 if(!user)return c.json({error:'Invalid or expired token'},400);
 const pw=await hashPassword(p.password);
 await c.env.DB.batch([
 c.env.DB.prepare('UPDATE auth_users SET password_hash=?,password_salt=? WHERE id=?').bind(pw.hash,pw.salt,user.user_id),
 c.env.DB.prepare('UPDATE auth_tokens SET used_at=? WHERE id=? AND used_at IS NULL').bind(now(),id),
 c.env.DB.prepare("DELETE FROM auth_tokens WHERE user_id=? AND kind='session'").bind(user.user_id)]);
 return c.json({reset:true});
});
auth.get('/me',async c=>{
 const token=/\bnoti_session=([a-f0-9]{64})/.exec(c.req.header('cookie')||'')?.[1];
 if(!token)return c.json({error:'Unauthorized'},401);
 const row=await c.env.DB.prepare("SELECT u.id,u.email,m.org_id,m.role FROM auth_tokens t JOIN auth_users u ON u.id=t.user_id JOIN auth_memberships m ON m.user_id=u.id WHERE t.id=? AND t.kind='session' AND t.used_at IS NULL AND t.expires_at>? AND u.verified_at IS NOT NULL").bind(await sha256(token),now()).first();
 if(!row)return c.json({error:'Unauthorized'},401);
 return c.json({user:row});
});
auth.post('/signout',async c=>{
 const token=/\bnoti_session=([a-f0-9]{64})/.exec(c.req.header('cookie')||'')?.[1];
 if(token)await c.env.DB.prepare("DELETE FROM auth_tokens WHERE id=? AND kind='session'").bind(await sha256(token)).run();
 c.header('Set-Cookie','noti_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');return c.json({signedOut:true});
});
export default auth;
