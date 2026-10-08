import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pool } from './db';
import { login, getSession, logout, changePin } from './auth';
import { getGame, getPlayers, placeBets, cancelBet, getAdmin, applyResult, updateConfig, createManualMatch, setManualOdds } from './engine';
import { syncAll } from './sync';
import type { User } from '../shared/contracts';

const production=process.env.NODE_ENV==='production';
const cookieName='ponnicup_session';
const staticRoot=resolve('dist');
const maxBody=64*1024;
function send(res:ServerResponse,status:number,payload:unknown) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload));}
function cookie(res:ServerResponse,token:string,maxAge=30*86400){res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${production?'; Secure':''}`);}
function token(req:IncomingMessage){return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';}
async function body(req:IncomingMessage){
  if(!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(new Error('Pyyntö vaatii JSON-sisällön.'),{status:415});
  let content='';let length=0;
  for await(const part of req){length+=part.length;if(length>maxBody)throw Object.assign(new Error('Pyyntö on liian suuri.'),{status:413});content+=part.toString();}
  try{const value=JSON.parse(content);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw Object.assign(new Error('Virheellinen pyyntö.'),{status:400});}
}
function checkOrigin(req:IncomingMessage){
  const origin=req.headers.origin;const allowed=process.env.PUBLIC_ORIGIN;
  if(req.headers['sec-fetch-site']==='cross-site')throw Object.assign(new Error('Pyyntö estettiin.'),{status:403});
  if(origin){const host=req.headers.host;let parsed:URL;try{parsed=new URL(origin);}catch{throw Object.assign(new Error('Virheellinen pyynnön alkuperä.'),{status:403});}const okay=allowed?origin===allowed:(!production&&parsed.host===host);if(!okay)throw Object.assign(new Error('Pyyntö ei ole tästä sovelluksesta.'),{status:403});}
}
function requireAdmin(user:User){if(user.role!=='admin')throw Object.assign(new Error('Vain ylläpitäjälle.'),{status:403});}
export const server=createServer(async(req,res)=>{
  const requestId=randomUUID();res.setHeader('X-Request-Id',requestId);
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
  try{
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);const path=url.pathname;
    if(path.startsWith('/api/')){
      res.setHeader('Cache-Control','no-store');
      if(req.method==='GET'&&path==='/api/health'){await pool.query('SELECT 1');return send(res,200,{ok:true,service:'ponnicup'});}
      if(req.method==='GET'&&path==='/api/players')return send(res,200,{players:await getPlayers()});
      if(!['GET','HEAD'].includes(req.method||''))checkOrigin(req);
      if(req.method==='POST'&&path==='/api/login'){
        const input=await body(req);const ip=production?(req.headers['x-forwarded-for']?.toString().split(',').at(-1)?.trim()||req.socket.remoteAddress||'unknown'):(req.socket.remoteAddress||'local');
        const session=await login(input.userId,input.pin,ip);cookie(res,session.token);return send(res,200,{user:session.user});
      }
      if(req.method==='POST'&&path==='/api/logout'){await logout(token(req));cookie(res,'',0);return send(res,200,{ok:true});}
      const user=await getSession(token(req));
      if(req.method==='GET'&&path==='/api/session')return send(res,200,{user});
      if(!user)return send(res,401,{error:'Kirjaudu sisään jatkaaksesi.'});
      if(req.method==='POST'&&path==='/api/pin'){
        const input=await body(req);await changePin(user.id,input.currentPin,input.newPin);const session=await login(user.id,input.newPin,req.socket.remoteAddress||'local');cookie(res,session.token);return send(res,200,{user:session.user});
      }
      if(user.pinResetRequired)return send(res,403,{error:'Vaihda aloitus-PIN ennen pelaamista.'});
      if(req.method==='GET'&&path==='/api/game')return send(res,200,await getGame(user,url.searchParams.get('roundId')||undefined));
      if(req.method==='POST'&&path==='/api/bets'){const input=await body(req);return send(res,200,{bets:await placeBets(user,input.bets)});}
      if(req.method==='DELETE'&&/^\/api\/bets\/[^/]+$/.test(path)){const input=await body(req);await cancelBet(user,decodeURIComponent(path.split('/').at(-1)!),input.requestId);return send(res,200,{ok:true});}
      if(path.startsWith('/api/admin')){
        requireAdmin(user);
        if(req.method==='GET'&&path==='/api/admin')return send(res,200,await getAdmin());
        if(req.method==='POST'&&path==='/api/admin/matches'){return send(res,200,await createManualMatch(await body(req),user.id));}
        if(req.method==='POST'&&path==='/api/admin/odds'){await setManualOdds(await body(req),user.id);return send(res,200,{ok:true});}
        if(req.method==='POST'&&path==='/api/admin/results'){await applyResult(await body(req),user.id);return send(res,200,{ok:true});}
        if(req.method==='POST'&&path==='/api/admin/config'){const input=await body(req);await updateConfig(input.config,user.id,input.reason);return send(res,200,{ok:true});}
        if(req.method==='POST'&&path==='/api/admin/sync'){
          const summary=await syncAll(true);await pool.query("INSERT INTO audit_log(actor_id,action,reason,detail) VALUES($1,'manual_sync','Ylläpitäjän käynnistämä tietojen päivitys.',$2)",[user.id,summary]);return send(res,200,{ok:true,summary});
        }
      }
      return send(res,404,{error:'Sivua ei löytynyt.'});
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Toiminto ei ole sallittu.'});
    const decoded=decodeURIComponent(path);let file=resolve(staticRoot,'.'+decoded);
    if(file!==staticRoot&&!file.startsWith(staticRoot+sep))return send(res,404,{error:'Sivua ei löytynyt.'});
    let isFile=false;try{isFile=(await stat(file)).isFile();}catch{}
    if(!isFile){if(extname(file))return send(res,404,{error:'Tiedostoa ei löytynyt.'});file=resolve(staticRoot,'index.html');}
    const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.ico':'image/x-icon'};
    const content=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
  }catch(error){
    const e=error as Error&{status?:number;code?:string};const status=e.status&&e.status>=400&&e.status<600?e.status:500;
    if(status>=500)console.error(JSON.stringify({requestId,code:e.code||'INTERNAL_ERROR',message:e.message}));
    if(!res.headersSent)send(res,status,{error:status>=500?'Palvelussa on häiriö. Kokeile hetken kuluttua.':e.message,requestId});else res.end();
  }
});
server.requestTimeout=30_000;server.headersTimeout=15_000;
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||3000);server.listen(port,'0.0.0.0',()=>console.info(`Ponnicup listening on ${port}`));
  const stop=()=>server.close(()=>pool.end().then(()=>process.exit(0)));process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
