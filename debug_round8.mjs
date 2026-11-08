// Debug: run one marquee drag in-page and report internal state at each step.
const url = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getJSON(p){const r=await fetch(CDP_HTTP+p);if(!r.ok)throw new Error(p+' '+r.status);return r.json();}
class WS{constructor(u){this.u=u;this.id=0;this.h=new Map();}
connect(){return new Promise((res,rej)=>{const w=new WebSocket(this.u);w.onopen=()=>{this.w=w;res();};w.onerror=()=>rej(new Error('ws'));w.onmessage=(m)=>{const d=JSON.parse(m.data);if(d.id&&this.h.has(d.id)){this.h.get(d.id)(d);this.h.delete(d.id);}};});}
send(method,params={},sessionId){const id=++this.id;const msg={id,method,params};if(sessionId)msg.sessionId=sessionId;
return new Promise((res,rej)=>{this.h.set(id,(d)=>d.error?rej(new Error(JSON.stringify(d.error))):res(d.result));this.w.send(JSON.stringify(msg));});}}

const ver=await getJSON('/json/version');
const bw=new WS(ver.webSocketDebuggerUrl);await bw.connect();
const cr=await bw.send('Target.createTarget',{url:url+'/'});
await sleep(2000);
const at=await bw.send('Target.attachToTarget',{targetId:cr.targetId,flatten:true});
const SID=at.sessionId;
const ev=async(expr)=>{const r=await bw.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true},SID);
if(r.exceptionDetails)throw new Error('page exc: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result?.value;};

const USER='r8d'+Math.random().toString(36).slice(2,8);
console.log('login:',await ev(`(async()=>{const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'${USER}',password:'pw12345678'})});const me=await(await fetch('/api/auth/me')).json();return r.status+':'+(me.user&&me.user.username);})()`));
const dr=await ev(`(async()=>{const r=await fetch('/api/drawings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'dbg'+Date.now(),data:{layers:[{name:'Walls',color:'#d9dee6',visible:true,locked:false,lineweight:1}],entities:[{type:'line',layer:'Walls',p1:[-80,-50],p2:[80,50]}]}})});const j=await r.json();return j.drawing.id;})()`);
console.log('drawing:',dr);
await bw.send('Page.navigate',{url:url+'/d/'+dr},SID);
await sleep(3000);

const probe = `(function(){
 const A=window.__WebCAD;if(!A)return {err:'no hook'};
 const st=A.state, cv=document.getElementById('cv'), rect=cv.getBoundingClientRect();
 const p1=A.w2s([-80,-50]),p2=A.w2s([80,50]);
 const s1=[rect.left+p1[0],rect.top+p1[1]], s2=[rect.left+p2[0],rect.top+p2[1]];
 return {tool:st.tool, zoom:st.view.zoom, entCount:st.doc.entities.length,
   entPts: A.entitiesInWindow({x0:-80,y0:-50,x1:80,y1:50,cross:false}).length,
   s1,s2, rect:{l:rect.left,t:rect.top,w:rect.width,h:rect.height},
   hasClick:false};})()`;
console.log('probe0:', await ev(probe));

// Now do a drag and report state after each event
const steps = `(async()=>{
 const A=window.__WebCAD, cv=document.getElementById('cv'), rect=cv.getBoundingClientRect();
 const p1=A.w2s([-80,-50]),p2=A.w2s([80,50]);
 const sx=rect.left+p1[0]-40, sy=rect.top+p1[1]-40;
 const ex=rect.left+p2[0]+40, ey=rect.top+p2[1]+40;
 const ev=(t,x,y)=>cv.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true}));
 const out=[];
 out.push(['pre', A.state.tool, A.state.sel.size]);
 ev('mousedown',sx,sy); await new Promise(r=>setTimeout(r,100));
 out.push(['md', A.state.tool, A.state.sel.size, JSON.stringify(A.state.rubber)]);
 ev('mousemove',(sx+ex)/2,(sy+ey)/2); await new Promise(r=>setTimeout(r,100));
 out.push(['mm', A.state.tool, A.state.sel.size, JSON.stringify(A.state.rubber)]);
 ev('mouseup',ex,ey); await new Promise(r=>setTimeout(r,300));
 out.push(['mu', A.state.tool, A.state.sel.size, document.getElementById('selInfo').textContent]);
 // what does the app compute for the rubber rect?
 const st=A.state;
 return {out, view:st.view};
})()`;
console.log('drag:', JSON.stringify(await ev(steps)));
await bw.close?0:0;
process.exit(0);