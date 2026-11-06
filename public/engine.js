/* Motor de ajedrez compartido: lo usan el navegador y el servidor */
const DR=[[1,0],[-1,0],[0,1],[0,-1]],DB=[[1,1],[1,-1],[-1,1],[-1,-1]],NM=[[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]],DA=DR.concat(DB);
const GL={K:"♚",Q:"♛",R:"♜",B:"♝",N:"♞",P:"♟\uFE0E"},VAL={P:100,N:320,B:330,R:500,Q:900,K:0};
const VARS={classic:{n:"Clásico",d:"Ajedrez tradicional"},freestyle:{n:"Aleatorio 960",f:1,d:"Chess960"},pawn7:{n:"Pawn7",p7:1,d:"Promoción en 7ª"}};
const $=s=>document.querySelector(s),opp=c=>c==="w"?"b":"w",sqn=i=>"abcdefgh"[i&7]+(8-(i>>3));
/* ---------- motor ---------- */
function att(b,sq,by){const r=sq>>3,c=sq&7,pr=by==="w"?r+1:r-1;
for(const dc of[-1,1]){const cc=c+dc;if(pr>=0&&pr<8&&cc>=0&&cc<8&&b[pr*8+cc]===by+"P")return true}
for(const[a,d]of NM){const rr=r+a,cc=c+d;if(rr>=0&&rr<8&&cc>=0&&cc<8&&b[rr*8+cc]===by+"N")return true}
for(const[a,d]of DA){const rr=r+a,cc=c+d;if(rr>=0&&rr<8&&cc>=0&&cc<8&&b[rr*8+cc]===by+"K")return true}
for(const[ds,t]of[[DR,"R"],[DB,"B"]])for(const[a,d]of ds){let rr=r+a,cc=c+d;while(rr>=0&&rr<8&&cc>=0&&cc<8){const p=b[rr*8+cc];if(p){if(p[0]===by&&(p[1]===t||p[1]==="Q"))return true;break}rr+=a;cc+=d}}
return false}
function pseudo(s){const b=s.b,t=s.turn,o=opp(t),out=[],dir=t==="w"?-1:1,st=t==="w"?6:1,last=t==="w"?0:7,sev=t==="w"?1:6;
for(let i=0;i<64;i++){const p=b[i];if(!p||p[0]!==t)continue;const ty=p[1],r=i>>3,c=i&7;
if(ty==="P"){const r1=r+dir;if(r1<0||r1>7)continue;
const add=(to,x)=>{const tr=to>>3;if(tr===last)for(const q of"QRBN")out.push({f:i,t:to,p:q,...x});else{out.push({f:i,t:to,...x});if(s.p7&&tr===sev)for(const q of"RBN")out.push({f:i,t:to,p:q,...x})}};
let to=r1*8+c;if(!b[to]){add(to,{});if(r===st&&!b[to+dir*8])out.push({f:i,t:to+dir*8})}
for(const dc of[-1,1]){const cc=c+dc;if(cc<0||cc>7)continue;to=r1*8+cc;if(b[to]&&b[to][0]===o)add(to,{});else if(to===s.ep)add(to,{e:1})}
}else if(ty==="N"||ty==="K"){for(const[a,d]of ty==="N"?NM:DA){const rr=r+a,cc=c+d;if(rr<0||rr>7||cc<0||cc>7)continue;const to=rr*8+cc;if(!b[to]||b[to][0]===o)out.push({f:i,t:to})}
if(ty==="K")for(const rk of s.cr[t]){if(b[rk]!==t+"R")continue;const base=t==="w"?56:0,ks=rk>i,kT=base+(ks?6:2),rT=base+(ks?5:3);
const lo=Math.min(i,rk,kT,rT),hi=Math.max(i,rk,kT,rT);let ok=true;for(let q=lo;q<=hi;q++)if(b[q]&&q!==i&&q!==rk)ok=false;if(!ok)continue;
for(let q=Math.min(i,kT);q<=Math.max(i,kT);q++)if(att(b,q,o))ok=false;if(ok)out.push({f:i,t:kT,castle:rk,rt:rT})}
}else{for(const[a,d]of ty==="R"?DR:ty==="B"?DB:DA){let rr=r+a,cc=c+d;while(rr>=0&&rr<8&&cc>=0&&cc<8){const to=rr*8+cc;if(b[to]){if(b[to][0]===o)out.push({f:i,t:to});break}out.push({f:i,t:to});rr+=a;cc+=d}}}}
return out}
function apply(s,m){const b=s.b.slice(),p=b[m.f],t=s.turn,ty=p[1],cr={w:s.cr.w.slice(),b:s.cr.b.slice()};let cap=b[m.t],ep=-1;
b[m.f]=null;
if(m.castle!==undefined){b[m.castle]=null;b[m.t]=t+"K";b[m.rt]=t+"R";cr[t]=[]}
else{if(m.e){b[m.t+(t==="w"?8:-8)]=null;cap="P"}b[m.t]=m.p?t+m.p:p;if(ty==="P"&&Math.abs(m.t-m.f)===16)ep=(m.f+m.t)/2;if(ty==="K")cr[t]=[]}
cr.w=cr.w.filter(x=>x!==m.f&&x!==m.t);cr.b=cr.b.filter(x=>x!==m.f&&x!==m.t);
return{b,turn:opp(t),cr,ep,hm:ty==="P"||cap?0:s.hm+1,p7:s.p7}}
function legal(s){return pseudo(s).filter(m=>{const n=apply(s,m);return!att(n.b,n.b.indexOf(s.turn+"K"),n.turn)})}
const inChk=s=>att(s.b,s.b.indexOf(s.turn+"K"),opp(s.turn));
function ev(s){let v=0;for(let i=0;i<64;i++){const p=s.b[i];if(!p)continue;const r=i>>3,c=i&7,w=p[0]==="w",ty=p[1];
let x=VAL[ty]+(ty==="P"?(w?6-r:r-1)*8:0)+(ty==="N"||ty==="B"?(7-Math.abs(3.5-r)-Math.abs(3.5-c))*5:ty==="P"?(3.5-Math.abs(3.5-c))*2:0);v+=w?x:-x}return v}
function ord(s,ms){return ms.map(m=>{const t=s.b[m.t];return[m,(t?VAL[t[1]]*10-VAL[s.b[m.f][1]]:0)+(m.p?800:0)]}).sort((a,b)=>b[1]-a[1]).map(x=>x[0])}
function nega(s,d,a,b){if(d===0)return(s.turn==="w"?1:-1)*ev(s);const ms=legal(s);if(!ms.length)return inChk(s)?-99999-d:0;
for(const m of ord(s,ms)){const v=-nega(apply(s,m),d-1,-b,-a);if(v>=b)return v;if(v>a)a=v}return a}
function best(s,d,noise){let bm=null,bv=-1e9;const ms=ord(s,legal(s));for(const m of ms){const v=-nega(apply(s,m),d-1,-1e9,-Math.max(bv-1,-1e9+1))+Math.random()*noise;if(v>bv){bv=v;bm=m}}return bm}
function back960(){const a=Array(8).fill(null);a[[0,2,4,6][Math.random()*4|0]]="B";a[[1,3,5,7][Math.random()*4|0]]="B";
const pick=ch=>{const f=a.map((x,i)=>x?-1:i).filter(i=>i>=0);a[f[Math.random()*f.length|0]]=ch};pick("Q");pick("N");pick("N");
const f=a.map((x,i)=>x?-1:i).filter(i=>i>=0);a[f[0]]="R";a[f[1]]="K";a[f[2]]="R";return a}
function newState(v){const bk=v.f?back960():["R","N","B","Q","K","B","N","R"],b=Array(64).fill(null);
for(let c=0;c<8;c++){b[c]="b"+bk[c];b[8+c]="bP";b[48+c]="wP";b[56+c]="w"+bk[c]}
const rk=o=>bk.map((x,i)=>x==="R"?o+i:-1).filter(i=>i>=0);
return{b,turn:"w",cr:{w:rk(56),b:rk(0)},ep:-1,hm:0,p7:!!v.p7}}

const key=s=>s.b.join(",")+s.turn+s.cr.w+s.cr.b+s.ep;
function insuf(b){const l=b.filter(x=>x&&x[1]!=="K");return l.length===0||(l.length===1&&(l[0][1]==="B"||l[0][1]==="N"))}

if(typeof module!=="undefined"&&module.exports)module.exports={opp,sqn,att,pseudo,apply,legal,inChk,ev,ord,best,newState,key,insuf,VAL,VARS};
