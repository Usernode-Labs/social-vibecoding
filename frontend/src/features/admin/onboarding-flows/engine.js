// The chart behind Admin › Onboarding flows: every person is one thread,
// drawn from where they arrived from to where they are now, and five views
// redraw the same threads around one question each.
//
// This is a drawn surface, not a tree of components: it lays the threads out
// by hand, morphs them between views frame by frame, and pans and zooms the
// whole drawing as one, so it is written as one imperative module that owns
// the nodes inside the hosts React rendered once (admin-onboarding-flows.tsx
// marks each with data-of). Nothing else writes to them.
//
// `mountFlows(root, DATA)` draws into `root` from the reading the server sent
// (services/onboarding-flows.js: the people, the public apps, the waiting
// summary) and returns `{ destroy }`, which takes every listener and timer
// with it. Every rule about who is in which lane was applied by the server;
// this module only draws and counts.

import { reducedMotion } from '../../../lib/reduced-motion';

/* eslint-disable */
export function mountFlows(root, DATA) {
var dead=false, cleanups=[];
function byId(id){return root.querySelector('[data-of="'+id+'"]');}
function listen(target,type,fn,opts){target.addEventListener(type,fn,opts);cleanups.push(function(){target.removeEventListener(type,fn,opts);});}
var ALL=DATA.people, P=ALL, BY={}, NO_S1=false;
ALL.forEach(function(p){BY[p.k]=p;});
var NS='http://www.w3.org/2000/svg';
// the people who were here before the waitlist, by the name of the first season
var EARLY=(DATA.early&&DATA.early.label)||'Earlier members';
var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dayWords(iso){var d=new Date(iso);return isNaN(d)?'':d.getUTCDate()+' '+MONTHS[d.getUTCMonth()]+' '+d.getUTCFullYear();}
var ASOF=dayWords(DATA.asOf);
// the waiting summary, worded: [label, count] rows for the selection sheet
var WAIT=(function(w){
  if(!w||!w.people)return null;
  var words={under_2_weeks:'Under 2 weeks','2_to_5_weeks':'2 to 5 weeks','6_to_12_weeks':'6 to 12 weeks','3_months_or_more':'3 months or more',
    confirmed:'Confirmed their address',answered:'Answered the follow-up',account:'Has an account',none:'None of these',
    x:'X',friend:'A friend',event:'An event',other:'Something else',not_said:'Did not say',
    form:'The waitlist page',app:'The card in the app',not_recorded:'Not recorded'};
  function word(k){k=String(k);if(words[k])return words[k];if(k.indexOf('partner')===0)return 'A partner\u2019s form';return k.charAt(0).toUpperCase()+k.slice(1);}
  function rows(list){return (list||[]).map(function(r){return [word(r[0]),r[1]];});}
  return {n:w.people,median:w.medianDays,longest:w.longestDays,waited:rows(w.waited),far:rows(w.far),said:rows(w.said),
    form:rows((w.form||[]).map(function(r){return [r[0]==='account'?'made_account':r[0],r[1]];})).map(function(r){return [r[0]==='Made_account'?'Made an account':r[0],r[1]];}),
    months:(w.months||[]).map(function(r){var p=String(r[0]).split('-');return [(MONTHS[Number(p[1])-1]||'')+' '+p[0],r[1]];})};
})(DATA.waiting);
// Settings › Reduce motion or the device's own preference: the views switch without the morph
var reduce=reducedMotion();

/* ---------- small helpers ---------- */
function h(tag,attrs){var e=document.createElement(tag),i,c;for(var k in attrs||{}){if(k==='class')e.className=attrs[k];else if(k==='text')e.textContent=attrs[k];else e.setAttribute(k,attrs[k]);}
  for(i=2;i<arguments.length;i++){c=arguments[i];if(c==null||c===false)continue;if(Array.isArray(c))c.forEach(function(x){if(x!=null&&x!==false)e.appendChild(typeof x==='string'?document.createTextNode(x):x);});else e.appendChild(typeof c==='string'?document.createTextNode(c):c);}return e;}
function s(tag,attrs){var e=document.createElementNS(NS,tag);for(var k in attrs||{}){if(k==='text')e.textContent=attrs[k];else e.setAttribute(k,attrs[k]);}return e;}
function count(arr,fn){var n=0;arr.forEach(function(x){if(fn(x))n++;});return n;}
function pct(a,b){return b?Math.round(100*a/b)+'%':'0%';}
function plural(n,one,many){return n+' '+(n===1?one:many);}
function has(p,ch){return p.st.indexOf(ch)>=0;}
function median(a){if(!a.length)return null;a=a.slice().sort(function(x,y){return x-y;});var m=a.length>>1;return a.length%2?a[m]:Math.round((a[m-1]+a[m])/2);}
function tally(arr,fn){var m={},o=[];arr.forEach(function(x){var k=fn(x);if(k==null)return;if(!(k in m)){m[k]=0;o.push(k);}m[k]++;});return o.map(function(k){return [k,m[k]];}).sort(function(a,b){return b[1]-a[1];});}

/* ---------- node vocabulary ---------- */
var N={
 'src:season1':{l:EARLY}, 'src:unrecorded':{l:'Not recorded',kind:'ghost'}, 'src:x':{l:'Said: X'}, 'src:friend':{l:'Said: a friend'}, 'src:event':{l:'Said: an event'}, 'src:other':{l:'Said: somewhere else'}, 'src:invite':{l:"A member's invite link",w:"Member's invite link"},
 'door:direct':{l:'Let in directly',s:'Directly'}, 'door:waitlist':{l:'Joined the waitlist',s:'Waitlist'}, 'door:invite':{l:'Opened an invite link',w:'By invite link'},
 'got:in':{l:'Made an account'}, 'got:new':{l:'Let off this week, too early to say',w:'Too early to say',kind:'ghost',neutral:true}, 'got:away':{l:'Had an account, has not come back',w:'Had an account, not back'}, 'got:waiting':{l:'Has an account, waiting for access',w:'Waiting for access'}, 'got:mail':{l:'Ignored the admit mail',w:'Ignored admit mail'}, 'got:nomail':{l:'No admit mail sent'},
 'first:app':{l:'Tried an app'}, 'first:spoke':{l:'Spoke, voted or asked',w:'Spoke or voted'}, 'first:joined':{l:'Joined a community'}, 'first:none':{l:'Opened, did nothing'}, 'first:never':{l:'Never opened it'},
 'made:yes':{l:'Made an app'}, 'made:no':{l:"Used others' apps"},
 'dw:c':{l:'Waited 6 weeks or more',w:'6+ weeks'}, 'dw:na':{l:'Wait not recorded',kind:'ghost'},
 'dwp:direct':{l:'',pass:true,full:'Let in directly'}, 'dwp:invite':{l:'',pass:true,full:'Opened an invite link'},
 'dw:waiting':{l:'Not let off yet',kind:'ghost',phantom:(WAIT?WAIT.n+' \u00b7 not to scale':'not in this data'),full:'Still on the waitlist, not let off yet'}, 'dw:b':{l:'Waited 2 to 5 weeks',w:'2 to 5 weeks'}, 'dw:a':{l:'Waited under 2 weeks',w:'Under 2 weeks'},
 'gm:unopened':{l:'Never opened the mail',w:'Never opened it'}, 'gm:opened':{l:"Opened the mail, didn't sign in",w:'Opened, no sign-in'}, 'gm:untracked':{l:'Mail opens not tracked',w:'Opens not tracked',kind:'ghost'},
 'gmp:in':{l:'',pass:true,full:'Made an account'},
 'mk:shared':{l:'Private app, someone joined',w:'Private app, joined'}, 'mk:solo':{l:'Private app, no one joined',w:'Private app, solo'}, 'mk:pub':{l:'Made a public app'}, 'mk:joined':{l:"Joined a friend's private app",w:"Joined a friend's"},
 'out:pub_contrib':{l:'Contributes to public apps',w:'Public: contributes'}, 'out:pub_user':{l:'Uses public apps',w:'Public: uses'}, 'out:quiet':{l:'Went quiet'}, 'out:lapsed':{l:'Was taking part, nothing in four weeks',w:'Lapsed'}, 'out:both':{l:'Private and public',w:'Private + public'}, 'out:priv':{l:'Private apps only',w:'Private only'}, 'out:member':{l:"In a friend's private app",w:"In a friend's app"}, 'out:shared':{l:'Shared a private app',w:'Shared private app'},
 'pa:made':{l:'Made a private app'}, 'pa:joined':{l:"Joined a friend's"},
 'ps:shared':{l:'Someone joined it'}, 'ps:solo':{l:'No one joined yet'}, 'ps:member':{l:'Takes part in it'}, 'ps:lurk':{l:'Joined, nothing yet'},
 'pp:yes':{l:'On public apps too'}, 'pp:no':{l:'Not on public apps'},
 'aud:private':{l:'A private app'}, 'aud:public':{l:'A public app'},
 'how:new':{l:'Made a new account',w:'New to Homeroom'}, 'how:had':{l:'Already had an account',w:'Already inside'}, 'how:unk':{l:'Not recorded',kind:'ghost'},
 'join:yes':{l:'Joined the app',w:'Joined'}, 'join:wait':{l:'Waiting for access',w:'Waiting'},
 'then:invites':{l:'Invites others too',w:'Invites others'}, 'then:contrib':{l:'Votes, asks or builds',w:'Votes or builds'}, 'then:back':{l:'Came back'}, 'then:once':{l:'Tried it once'}, 'then:none':{l:'Nothing yet'},
 'app:none':{l:'',pass:true,full:'Returns to no public app'}, 'app:other':{l:'Other public apps'},
 'lc:0':{l:'Contributed this week or last',w:'This week or last'}, 'lc:1':{l:'Contributed 2 to 4 weeks ago',w:'2 to 4 weeks ago'}, 'lc:2':{l:'Contributed 5 to 8 weeks ago',w:'5 to 8 weeks ago'}, 'lc:3':{l:'No contribution in the last 8 weeks',w:'Over 8 weeks ago'},
 'pn:0':{l:'Contributes, returns to no public app',w:'Returns to no app'}, 'pn:1':{l:'Returns to 1 public app',w:'1 app'}, 'pn:2':{l:'Returns to 2 to 4 public apps',w:'2 to 4 apps'}, 'pn:5':{l:'Returns to 5 or more public apps',w:'5 or more apps'},
 'deep:live':{l:'Their change went live'}, 'deep:voice':{l:'Votes or gives feedback'}, 'deep:use':{l:'Uses it'},
 'rh:stay':{l:'Active two weeks running'}, 'rh:not':{l:'Not yet'},
 'wait:none':{l:'No waitlist'}, 'wait:a':{l:'Under 2 weeks'}, 'wait:b':{l:'2 to 5 weeks'}, 'wait:c':{l:'6 weeks or more'},
 'far:admit':{l:'Admitted, never signed in'}, 'far:new':{l:'Let off this week'}, 'far:away':{l:'Let in, already had an account'}, 'far:queued':{l:'Signed up, not let in'}, 'far:account':{l:'Made an account'}, 'far:opened':{l:'Opened Homeroom'}, 'far:acted':{l:'Did one thing'},
 'why:openmail':{l:"Opened the mail, didn't sign in"}, 'why:unopened':{l:'Never opened the mail'}, 'why:untracked':{l:'Mail opens not tracked',kind:'ghost'}, 'why:nomail':{l:'No admit mail on record'},
 'why:queued':{l:'Invited, waiting to be let in'}, 'why:new':{l:'Too early to say',kind:'ghost'}, 'why:away':{l:'Has not come back since'}, 'why:lapsed':{l:'Was taking part, nothing in four weeks'}, 'why:neveropen':{l:'Has access, never opened it'}, 'why:noact':{l:'Looked, did nothing'},
 'why:solo':{l:'Made an app, never shared'}, 'why:joined':{l:'Joined a community only'}, 'why:explored':{l:'Explored apps, then stopped'}, 'why:tried':{l:'Opened an app briefly'}
};

/* ---------- per-person node functions ---------- */
function gotNode(p){ if(p.got==='new')return 'got:new'; if(p.got==='away')return 'got:away'; if(p.got==='mail_ignored')return 'got:mail'; if(p.got==='mail_none')return 'got:nomail'; if(p.got==='waiting')return 'got:waiting'; return 'got:in'; }
function isIn(p){return p.got==='in'||p.got==='acct';}
function firstNode(p){ if(!isIn(p))return null; if(p.got==='acct'||p.stuck==='opened')return 'first:never'; return 'first:'+p.first; }
function acted(p){var f=firstNode(p);return !!f&&f!=='first:never'&&f!=='first:none';}
function outNode(p){ if(!acted(p))return null; if(p.lane==='both')return 'out:both'; if(p.lane==='share')return 'out:priv'; if(p.lane==='pub')return p.pub==='contrib'?'out:pub_contrib':'out:pub_user'; return p.out==='lapsed'?'out:lapsed':'out:quiet'; }
function madePriv(p){return p.made.some(function(m){return m.aud==='private';});}
function sharedPriv(p){return p.shared.some(function(x){return x.aud==='private';});}
function joinedPriv(p){return !!p.inv&&p.inv.aud==='private'&&p.inv.status==='joined';}
function primaryShare(p){ if(!p.shared.length)return null; var priv=p.shared.filter(function(x){return x.aud==='private';}); var a=(priv.length?priv:p.shared).slice().sort(function(x,y){return y.inv.length-x.inv.length;}); return a[0]; }
function firstGen(p){return p.shared.length>0&&!p.inv;}
function shKey(by,app){return 'sh:'+by+'|'+app;}
function thenNode(p){ if(p.inv.status!=='joined')return null; if(p.shared.length)return 'then:invites'; if(p.contribFlag)return 'then:contrib'; if(has(p,'S')||has(p,'E'))return 'then:back'; if(p.first!=='none')return 'then:once'; return 'then:none'; }
P.forEach(function(p){ p.contribFlag=has(p,'B')||p.kinds.indexOf('vote')>=0||p.kinds.indexOf('feedback')>=0; });
var TOPAPPS=tally(P.filter(function(p){return p.pub&&p.pubApp;}),function(p){return p.pubApp;}).filter(function(a){return a[1]>=3;}).map(function(a){return a[0];});
TOPAPPS.forEach(function(a){N['app:'+a]={l:a};});
// lastC is days since the last contribution: this week or last, two to four weeks, five to eight, longer or never
function lastNode(p){var d=p.lastC;return d==null?'lc:3':(d<14?'lc:0':(d<35?'lc:1':(d<63?'lc:2':'lc:3')));}
function appNode(p){ if(!p.pubApp)return 'app:none'; return TOPAPPS.indexOf(p.pubApp)>=0?'app:'+p.pubApp:'app:other'; }
function deepNode(p){ return has(p,'U')?'deep:live':(p.contribFlag?'deep:voice':'deep:use'); }
function waitNode(p){ if(p.door!=='waitlist'||p.wait==null)return 'wait:none'; return p.wait<14?'wait:a':(p.wait<42?'wait:b':'wait:c'); }
function farNode(p){ if(p.got==='new')return 'far:new'; if(p.got==='away')return 'far:away'; if(p.got==='mail_ignored'||p.got==='mail_none')return 'far:admit'; if(p.got==='waiting')return 'far:queued'; var f=firstNode(p); if(f==='first:never')return 'far:account'; if(f==='first:none')return 'far:opened'; return 'far:acted'; }
function whyNode(p){
  if(p.got==='new')return 'why:new';
  if(p.got==='away')return 'why:away';
  if(p.got==='mail_none')return 'why:nomail';
  if(p.got==='mail_ignored'){ if(!p.mail||p.mail[0]==null)return 'why:untracked'; return p.mail[0]?'why:openmail':'why:unopened'; }
  if(p.got==='waiting')return 'why:queued';
  var f=firstNode(p); if(f==='first:never')return 'why:neveropen'; if(f==='first:none')return 'why:noact';
  if(p.out==='lapsed')return 'why:lapsed';
  if(p.made.length)return 'why:solo'; if(p.first==='joined')return 'why:joined'; if(has(p,'E'))return 'why:explored'; return 'why:tried';
}

/* the engaged step: contribution rows against use columns */
var EROWS=[{k:'core',l:'Builds often',d:'6 or more changes live'},{k:'build',l:'Builds',d:'a change of theirs went live'},{k:'voice',l:'Voices',d:'votes, feedback or a proposal'},{k:'uses',l:'Uses only',d:'no contribution yet'}];
var ECOLS=[{l:'None',d:'0 app-days'},{l:'Light',d:'1 to 9 app-days'},{l:'Regular',d:'10 to 29 app-days'},{l:'Heavy',d:'30 or more app-days'}];
var EROW={};EROWS.forEach(function(r){EROW[r.k]=r;});
function engaged(p){return acted(p)&&p.lane!=='none';}
function useTier(p){var d=p.useDays||0;return d>=30?3:(d>=10?2:(d>=1?1:0));}
function conTier(p){ if((p.accepted||0)>=6)return 'core'; if((p.accepted||0)>=1||has(p,'U'))return 'build'; if(p.contribFlag||p.kinds.indexOf('change')>=0)return 'voice'; return 'uses'; }
EROWS.forEach(function(r){ECOLS.forEach(function(c,ci){
  N['eng:'+r.k+':'+ci]={l:'',small:true,full:r.l+' · '+c.l.toLowerCase()+' use',grid:true};
  N['engp:'+r.k+':'+ci]={l:'',pass:true,full:r.l};
});});
function gridCol(ci,at,gap){return {t:['None','Light','Regular','Heavy'][ci],gap:gap||.5,pad:26,topPad:20,band:function(id){return id.split(':')[1];},bandCol:at,
  node:function(p){ if(!engaged(p))return null; var u=useTier(p),r=conTier(p); return u>ci?'engp:'+r+':'+ci:(u===ci?'eng:'+r+':'+ci:null); },
  order:[].concat.apply([],EROWS.map(function(r){return ['engp:'+r.k+':'+ci,'eng:'+r.k+':'+ci];}))};}
function gridDecor(L,g){
  var at=L.view.gridAt,tops={},n={},inv={};
  L.all.forEach(function(nd){ if(nd.col!==at)return; var k=nd.id.split(':')[1]; if(!(k in tops)||nd.y<tops[k])tops[k]=nd.y; });
  L.people.forEach(function(p){ if(!L.T[p.k]||!engaged(p))return; var k=conTier(p); n[k]=(n[k]||0)+1; if(p.shared.length)inv[k]=(inv[k]||0)+1; });
  EROWS.forEach(function(r){ if(!(r.k in tops))return; g.appendChild(s('text',{'class':'caption',x:L.xs[at],y:(tops[r.k]-8).toFixed(1),text:r.l+' · '+n[r.k]+(inv[r.k]?' · '+inv[r.k]+' invite':'')})); });
}
function sharerN(sh){return NO_S1?count(P,function(p){return p.inv&&p.inv.by===sh.by&&p.inv.n===sh.app;}):sh.n;}
function inviteTarget(L){var b=null;L.nodes.forEach(function(n){if(n.id==='src:invite')b=n;});return b?{x:b.x+b.w/2,y:b.y+b.h+7}:null;}
[2,3,4,5].forEach(function(c){N['sk:'+c]={l:'',pass:true,full:'Sharers themselves'};});
/* arrival: a recorded channel where there is one, else what they said, else Season 1 or nothing */
N['arr:noref']={l:'No referrer given'}; N['via:noref']={l:'No referrer given'}; N['via:unrec']={l:'Not recorded',kind:'ghost'};
var ARR_REC=[],VIA_REC=[];
P.forEach(function(p){
  if(p.arr&&p.arr.t==='rec'){var a='arr:rec:'+p.arr.l;if(!N[a]){N[a]={l:p.arr.l};ARR_REC.push(a);}}
  if(p.via&&p.via.t==='rec'){var v='via:rec:'+p.via.l;if(!N[v]){N[v]={l:p.via.l};VIA_REC.push(v);}}
});
function arrNode(p){ return p.arr?(p.arr.t==='rec'?'arr:rec:'+p.arr.l:'arr:noref'):'src:'+p.src; }
function viaNode(p){ return p.via?(p.via.t==='rec'?'via:rec:'+p.via.l:'via:noref'):'via:unrec'; }
var ARR_ORDER=ARR_REC.concat(['arr:noref']);
function dispName(id){var m=N[id]||{};if(m.pass)return 'Engaged: '+m.full.toLowerCase();return m.full||m.l||id;}

/* sharer nodes: one per (sharer, app), private apps first */
var SHARERS=[];
(function(){
  var m={};
  function add(name,x,team,person){ var id=shKey(name,x.n); if(m[id])return; m[id]={id:id,by:name,app:x.n,aud:x.aud,n:x.inv.length,team:team,person:person,second:!!(person&&person.inv)}; SHARERS.push(m[id]); }
  P.forEach(function(p){p.shared.forEach(function(x){add(p.n,x,false,p);});});
  DATA.ghost.forEach(function(g){g.shared.forEach(function(x){add(g.n,x,true,null);});});
  SHARERS.sort(function(a,b){ if(a.aud!==b.aud)return a.aud==='private'?-1:1; if(a.team!==b.team)return a.team?1:-1; return b.n-a.n; });
  var seenPriv=false,seenPub=false;
  SHARERS.forEach(function(sh){
    var app=sh.app.length>24?sh.app.slice(0,23)+'\u2026':sh.app;
    var meta={l:sh.by+(sh.team?' (team)':'')+' · '+app,small:true,left:true,sharer:sh};
    if(sh.team)meta.kind='team';
    if(sh.aud==='private'&&!seenPriv){meta.caption='Private apps';seenPriv=true;}
    if(sh.aud==='public'&&!seenPub){meta.caption='Public apps';meta.gapBefore=30;seenPub=true;}
    N[sh.id]=meta;
  });
})();

/* ---------- views ---------- */
var LANES={share:{l:'Private only',d:'in a private app with someone else, not on public apps, and active in the last four weeks'},both:{l:'Private and public',d:'in a private app with someone else and on public apps too, and active in the last four weeks'},pub:{l:'Public only',d:'uses or contributes to a public app, and active in the last four weeks'},none:{l:'Dropped off',d:'neither, or nothing in the last four weeks'}};
var LANEKEYS=['share','both','pub','none'];
var VIEWS=[
 {id:'whole',tab:'Whole funnel',dot:'all',laneOrder:['pub','both','share','none'],filter:function(){return true;},loop:true,leaks:true,right:92,minW:1180,gridAt:8,
  zones:[{l:'Off-platform',from:0,to:0},{l:'On Homeroom · trial',from:1,to:5},{l:'Engaged',from:6,to:7},{l:'How engaged · use \u2192',from:8,to:11}],
  cols:[
   {t:'Arrived from',short:'w',node:arrNode,order:['src:season1','src:unrecorded'].concat(ARR_ORDER,['src:x','src:friend','src:other','src:event','src:invite'])},
   {t:'Door',short:'w',cgap:26,gapsBefore:{'door:invite':56},node:function(p){return 'door:'+p.door;},order:['door:direct','door:waitlist','door:invite']},   // the gap lines the invite card up with its pass-through, under the wait cards
   {t:'Time on waitlist',short:'w',detail:true,node:function(p){ if(p.door!=='waitlist')return 'dwp:'+p.door; return p.wait==null?'dw:na':(p.wait<14?'dw:a':(p.wait<42?'dw:b':'dw:c')); },order:['dwp:direct','dw:c','dw:b','dw:a','dw:na','dw:waiting','dwp:invite'],phantoms:['dw:waiting']},
   {t:'Getting in',short:'w',cgap:26,node:gotNode,order:['got:in','got:mail','got:away','got:waiting','got:nomail','got:new']},
   {t:'Admit mail',short:'w',detail:true,node:function(p){ var g=gotNode(p); if(g==='got:in')return 'gmp:in'; if(g!=='got:mail')return null; if(!p.mail||p.mail[0]==null)return 'gm:untracked'; return p.mail[0]?'gm:opened':'gm:unopened'; },order:['gmp:in','gm:unopened','gm:opened','gm:untracked']},
   {t:'First session',short:'w',node:firstNode,order:['first:app','first:spoke','first:joined','first:none','first:never']},
   {t:'Made or joined',short:'w',node:function(p){ if(!acted(p))return null; if(sharedPriv(p))return 'mk:shared'; if(madePriv(p))return 'mk:solo'; if(p.made.length)return 'mk:pub'; if(joinedPriv(p))return 'mk:joined'; return 'made:no'; },order:['mk:pub','mk:solo','mk:shared','mk:joined','made:no']},
   {t:'Where they are now',short:'w',gap:.95,node:outNode,order:['out:pub_contrib','out:pub_user','out:both','out:priv','out:lapsed','out:quiet']},
   gridCol(0,8),gridCol(1,8),gridCol(2,8),gridCol(3,8)
  ],
  loopTo:function(L){var tg=inviteTarget(L);if(!tg)return null;var eng=L.people.filter(engaged);tg.text='The loop: '+count(eng,function(p){return p.shared.length>0;})+' of the '+eng.length+' engaged people brought someone in, and '+count(P,function(p){return p.door==='invite';})+' new people came in by an invite link';return tg;},
  decor:gridDecor},
 {id:'share',tab:'Sharing',dot:'loop',laneOrder:['share','both','pub','none'],filter:function(p){return p.shared.length>0||!!p.inv;},loop:true,right:92,minW:1180,gridAt:6,
  zones:[{l:'Sharers',from:0,to:0},{l:'The share',from:1,to:1,lx:function(L){return L.xs[0]+NODEW+96;}},{l:'What happened to the people they invited',from:2,to:5},{l:'How engaged · use \u2192',from:6,to:9}],
  cols:[
   {t:'Came in by',gap:2.4,short:'s',node:function(p){return firstGen(p)?'door:'+p.door:null;},order:['door:waitlist','door:direct']},
   {t:'Sharer · app',gap:1,pad:11,cpad:5,cardMin:21,right:true,node:function(p){ if(p.inv)return shKey(p.inv.by,p.inv.n); var x=primaryShare(p); return x?shKey(p.n,x.n):null; },order:SHARERS.map(function(x){return x.id;})},
   {t:'Link came via',topPad:20,node:function(p){ if(!p.inv)return firstGen(p)?'sk:2':null; return viaNode(p); },order:['sk:2'].concat(VIA_REC,['via:noref','via:unrec'])},
   {t:'Before the link',short:'w',topPad:20,node:function(p){ if(!p.inv)return firstGen(p)?'sk:3':null; return (p.inv.how==='was_signed_in'||p.linkJoin)?'how:had':'how:new'; },order:['sk:3','how:new','how:had']},
   {t:'Joined',short:'w',topPad:20,node:function(p){ if(!p.inv)return firstGen(p)?'sk:4':null; return p.inv.status==='joined'?'join:yes':'join:wait'; },order:['sk:4','join:yes','join:wait']},
   {t:'Since then',short:'w',gap:.95,topPad:20,node:function(p){ if(!p.inv)return firstGen(p)?'sk:5':null; return thenNode(p); },order:['sk:5','then:invites','then:contrib','then:back','then:once','then:none']},
   gridCol(0,6),gridCol(1,6),gridCol(2,6),gridCol(3,6)
  ],
  loopTo:function(L){var n=count(L.people,function(p){return !!p.inv&&p.shared.length>0;});return {x:L.xs[1]+L.cw[1]/2,y:L.cols[1].bottom+7,text:'The loop: '+n+' of the people who were invited now invite others'};},
  decor:function(L,g){
    gridDecor(L,g);
    var sk=null;L.all.forEach(function(nd){if(nd.id==='sk:2')sk=nd;});
    if(sk)g.appendChild(s('text',{'class':'caption',x:L.xs[2],y:(sk.y-8).toFixed(1),text:'Sharers themselves · '+sk.n}));
  }},
 {id:'priv',tab:'Private apps',dot:'share',laneOrder:['share','both','pub','none'],filter:function(p){return madePriv(p)||sharedPriv(p)||joinedPriv(p);},loop:true,right:92,minW:1180,gridAt:5,
  zones:[{l:'Where they came from · low resolution',from:0,to:1},{l:'Their private app',from:2,to:4},{l:'How engaged · use \u2192',from:5,to:8}],
  cols:[
   {t:'Arrived from',gap:.72,short:'w',node:arrNode,order:['src:season1','src:unrecorded'].concat(ARR_ORDER,['src:x','src:friend','src:other','src:event','src:invite'])},
   {t:'Door',gap:.85,node:function(p){return 'door:'+p.door;},order:['door:direct','door:waitlist','door:invite']},
   {t:'Made or joined',node:function(p){return (madePriv(p)||sharedPriv(p))?'pa:made':'pa:joined';},order:['pa:made','pa:joined']},
   {t:'Then',node:function(p){ if(madePriv(p)||sharedPriv(p))return sharedPriv(p)?'ps:shared':'ps:solo'; return p.first!=='none'?'ps:member':'ps:lurk'; },order:['ps:solo','ps:shared','ps:member','ps:lurk']},
   {t:'Public apps too?',gap:.95,node:function(p){return p.pub?'pp:yes':'pp:no';},order:['pp:yes','pp:no']},
   gridCol(0,5),gridCol(1,5),gridCol(2,5),gridCol(3,5)
  ],
  loopTo:function(L){var b=null;L.nodes.forEach(function(n){if(n.id==='pa:joined')b=n;});if(!b)return null;return {x:b.x+b.w/2,y:b.y+b.h+7,text:'The loop: '+count(L.people,function(p){return joinedPriv(p);})+' people joined a private app through a friend\u2019s link'};},
  decor:gridDecor},
 {id:'pub',tab:'Public apps',dot:'pub',laneOrder:['pub','both','share','none'],filter:function(p){return !!p.pub;},loop:true,right:92,gridAt:5,
  zones:[{l:'Where they came from · low resolution',from:0,to:1},{l:'Their apps',from:2,to:3},{l:'When',from:4,to:4},{l:'How engaged · use \u2192',from:5,to:8}],
  cols:[
   {t:'Arrived from',gap:.72,short:'w',node:arrNode,order:['src:season1','src:unrecorded'].concat(ARR_ORDER,['src:x','src:friend','src:other','src:event','src:invite'])},
   {t:'Door',gap:.85,node:function(p){return 'door:'+p.door;},order:['door:direct','door:waitlist','door:invite']},
   {t:'Public apps they return to',short:'w',gap:1,node:function(p){var k=p.pubN||0;return k>=5?'pn:5':(k>=2?'pn:2':(k===1?'pn:1':'pn:0'));},order:['pn:5','pn:2','pn:1','pn:0']},
   {t:'The one they return to most',gap:1.15,node:appNode,order:TOPAPPS.map(function(a){return 'app:'+a;}).concat(['app:other','app:none'])},
   {t:'Last contributed',short:'w',gap:1,node:lastNode,order:['lc:0','lc:1','lc:2','lc:3']},
   gridCol(0,5,.75),gridCol(1,5,.75),gridCol(2,5,.75),gridCol(3,5,.75)
  ],
  loopTo:function(L){var tg=inviteTarget(L);if(!tg)return null;tg.text='The loop: '+count(L.people,function(p){return p.shared.length>0;})+' of these '+L.people.length+' people brought someone in';return tg;},
  decor:gridDecor},
 {id:'drop',tab:'Drop-offs',dot:'none',laneOrder:['none','pub','both','share'],filter:function(p){return p.lane==='none';},
  zones:[{l:'Where they came from · low resolution',from:0,to:1},{l:'Their story',from:2,to:4}],
  cols:[
   {t:'Arrived from',gap:.6,node:arrNode,order:ARR_ORDER.concat(['src:x','src:friend','src:other','src:event','src:unrecorded','src:season1','src:invite'])},
   {t:'Door',gap:.8,node:function(p){return 'door:'+p.door;},order:['door:waitlist','door:direct','door:invite']},
   {t:'Time on the waitlist',node:waitNode,order:['wait:c','wait:b','wait:a','wait:none']},
   {t:'Got as far as',node:farNode,order:['far:admit','far:away','far:new','far:queued','far:account','far:opened','far:acted']},
   {t:'What the record shows',node:whyNode,order:['why:unopened','why:openmail','why:untracked','why:nomail','why:away','why:new','why:queued','why:neveropen','why:noact','why:tried','why:explored','why:joined','why:solo','why:lapsed']}
  ]}
];
VIEWS=['whole','priv','pub','share','drop'].map(function(id){return VIEWS.filter(function(v){return v.id===id;})[0];});
var VBY={};VIEWS.forEach(function(v){VBY[v.id]=v;});

/* ---------- layout ---------- */
var NODEW=12, TOP=64, LEFT=12, RIGHT=236;
var LEAK_MIN=10,LEAK_TAG=0.2,LEAK_STRONG=0.5,LEAK_OK=0.1,LEAK_ROOM=12;
function padBefore(cdef,list,i,pd){ var n=list[i]; if(!i)return cdef.topPad||(n.meta.caption?18:0); if(cdef.band&&cdef.band(list[i-1].id)===cdef.band(n.id))return 0; return pd+(n.meta.gapBefore||0)+((cdef.gapsBefore&&cdef.gapsBefore[n.id])||0); }
var MODE='cards';
var meas=document.createElement('canvas').getContext('2d');
// the fonts the labels are measured in: the console's own face, and the section's monospace
var FAMILY=(window.getComputedStyle(root).fontFamily||'sans-serif');
var FT='600 12.5px '+FAMILY,FS='10.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
function textW(str,font){meas.font=font;return meas.measureText(str).width;}
function layout(view,W,mode){
  mode=mode||MODE;
  var people=P.filter(view.filter), nc=view.cols.length, laneIdx={};
  view.laneOrder.forEach(function(l,i){laneIdx[l]=i;});
  // paths: the contiguous run of columns a person appears in
  var paths=[];
  people.forEach(function(p){
    var ids=[],start=-1,c,id;
    for(c=0;c<nc;c++){ id=view.cols[c].node(p); if(id){ if(start<0)start=c; ids.push(id);} else if(start>=0)break; }
    if(start>=0)paths.push({p:p,start:start,ids:ids});
  });
  // nodes per column
  var cols=[],c;
  for(c=0;c<nc;c++)cols.push({nodes:{},list:[]});
  paths.forEach(function(pa){ pa.ids.forEach(function(id,i){ var col=cols[pa.start+i]; if(!col.nodes[id]){col.nodes[id]={id:id,col:pa.start+i,th:[],meta:N[id]||{l:id}};} col.nodes[id].th.push(pa); }); });
  cols.forEach(function(col,ci){
    var cdef=view.cols[ci],order=cdef.order||[];
    (cdef.phantoms||[]).forEach(function(id){ if(mode==='cards'&&!col.nodes[id])col.nodes[id]={id:id,col:ci,th:[],meta:N[id]}; });
    col.list=Object.keys(col.nodes).map(function(id){return col.nodes[id];}).sort(function(a,b){var ia=order.indexOf(a.id),ib=order.indexOf(b.id);if(ia<0)ia=999;if(ib<0)ib=999;return ia-ib||b.th.length-a.th.length;});
    col.list.forEach(function(n,i){n.idx=i;});
    col.slots=0;col.list.forEach(function(n){col.slots+=n.th.length;});
    col.card=mode==='cards'&&!cdef.band;                       // grid cells stay bars
    col.pd=col.card?(cdef.cpad||8):(cdef.pad||16);
    col.minH=col.card?(cdef.cardMin||34):(cdef.band?0:2);
    col.w=NODEW;
    if(col.card){
      var mw=0;
      col.list.forEach(function(n){
        if(n.meta.pass)return;
        var m=n.meta;
        if(m.sharer)n.text={l:m.l,sub:String(sharerN(m.sharer)),single:true};
        else if(m.phantom)n.text={l:m.l,sub:m.phantom,single:false};
        else n.text={l:(cdef.short&&m[cdef.short])||m.w||m.l,sub:n.th.length+' · '+pct(n.th.length,col.slots),single:(cdef.cardMin||34)<30};
        var w=n.text.single?textW(n.text.l,FT)+10+textW(n.th.length+'/'+n.th.length,FS):Math.max(textW(n.text.l,FT),textW(n.text.sub,FS),textW(n.th.length+' of '+n.th.length+' \u00b7 100%',FS)+4);
        mw=Math.max(mw,w);
      });
      col.w=Math.round(Math.min(300,Math.max(56,mw+22)));
    }
  });
  function nodeH(col,n,u){ return n.meta.pass?n.th.length*u:Math.max(n.th.length*u,col.minH); }
  // every card carries a mark above it, so each gets room for it: the mark sits in the gap and not on a label
  var tagRoom={};
  if(view.leaks&&mode==='cards'){cols.forEach(function(col,ci){if(view.cols[ci].band)return;col.list.forEach(function(n){if(!n.meta.pass&&!n.meta.phantom&&n.th.length)tagRoom[n.id]=1;});});}
  function padB(cdef,list,i,pd){return padBefore(cdef,list,i,pd)+(i&&tagRoom[list[i].id]?LEAK_ROOM:0);}
  function colH(col,ci,u){ var hh=0; col.list.forEach(function(n,i){hh+=padB(view.cols[ci],col.list,i,col.pd)+nodeH(col,n,u);}); return hh; }
  var target=560,lo=2.4,hi=9,k;
  function fits(u){for(var i=0;i<cols.length;i++){if(colH(cols[i],i,u)>target)return false;}return true;}
  if(fits(hi))lo=hi; else if(fits(lo)){for(k=0;k<22;k++){var mid=(lo+hi)/2;if(fits(mid))lo=mid;else hi=mid;}}
  var unit=lo;
  // x positions
  var xs=[],x=LEFT;
  if(mode==='cards'){
    var lastGrid=!!view.cols[nc-1].band,right=lastGrid?40:14,sumW=0,nFlex=0,nGrid=0,tight=0;
    view.cols.forEach(function(cdef,i){ sumW+=cols[i].w; if(i<nc-1){ if(cdef.band||view.cols[i+1].band)nGrid++; else if(cdef.cgap!=null)tight+=cdef.cgap; else nFlex++; } });   // cgap: a fixed, closer gap that pairs a column with the next
    // gaps between cards: 56px when there is room, down to 34px before the chart has to scroll
    var fixed=LEFT+sumW+right+nGrid*50+tight, gap=nFlex?Math.max(34,Math.min(56,(W-fixed)/nFlex)):0, need=fixed+nFlex*gap;
    W=Math.max(W,Math.ceil(need));
    var extra=nFlex?(W-need)/nFlex:0;
    view.cols.forEach(function(cdef,i){xs.push(x);x+=cols[i].w+(i<nc-1?((cdef.band||view.cols[i+1].band)?50:(cdef.cgap!=null?cdef.cgap:gap+extra)):0);});
  }else{
    var gaps=0;view.cols.forEach(function(cdef,i){if(i<nc-1)gaps+=(cdef.gap||1);});
    var avail=W-LEFT-(view.right||RIGHT)-NODEW;
    view.cols.forEach(function(cdef,i){xs.push(x);x+=avail*(cdef.gap||1)/gaps;});
  }
  // y positions
  var bottom=0;
  cols.forEach(function(col,ci){
    var y=TOP,cdef=view.cols[ci];
    if(cdef.band&&cdef.bandCol!=null&&cdef.bandCol!==ci){
      var tops={},used={};
      cols[cdef.bandCol].list.forEach(function(m){var k=cdef.band(m.id);if(!(k in tops)||m.y<tops[k])tops[k]=m.y;});
      col.list.forEach(function(n){var k=cdef.band(n.id); n.x=xs[ci]; n.y=tops[k]+(used[k]||0); n.h=n.th.length*unit; used[k]=(used[k]||0)+n.h; y=Math.max(y,n.y+n.h);});
    }else{
      col.list.forEach(function(n,i){ y+=padB(cdef,col.list,i,col.pd); n.x=xs[ci]; n.y=y; n.h=nodeH(col,n,unit); y+=n.h; });
    }
    col.bottom=y; bottom=Math.max(bottom,y);
  });
  // slot order inside each node, left to right
  var T={};
  paths.forEach(function(pa){T[pa.p.k]={p:pa.p,lane:pa.p.lane,segs:[],w:unit,nodes:pa.ids,start:pa.start};pa.slotR=[];pa.slotL=[];});
  function nodeIdx(pa,i){ var col=cols[pa.start+i]; return col?col.nodes[pa.ids[i]].idx:-1; }
  cols.forEach(function(col,ci){
    col.list.forEach(function(n){
      if(n.meta.pass){ // an unseen pass-through keeps one order on both sides, longest path on top
        n.th.slice().sort(function(a,b){
          var ea=a.start+a.ids.length,eb=b.start+b.ids.length; if(ea!==eb)return eb-ea;
          var ia=ci-a.start,ib=ci-b.start,pa=ia>0?nodeIdx(a,ia-1):1e6,pb=ib>0?nodeIdx(b,ib-1):1e6; if(pa!==pb)return pa-pb;
          return (ia>0?a.slotR[ia-1]:0)-(ib>0?b.slotR[ib-1]:0);
        }).forEach(function(pa,i){pa.slotL[ci-pa.start]=i;pa.slotR[ci-pa.start]=i;});
        return;
      }
      var Lo=n.th.slice().sort(function(a,b){
        var ia=ci-a.start,ib=ci-b.start;
        var pa=ia>0?nodeIdx(a,ia-1):1e6,pb=ib>0?nodeIdx(b,ib-1):1e6;
        if(pa!==pb)return pa-pb;
        var sa=ia>0?a.slotR[ia-1]:1e6,sb=ib>0?b.slotR[ib-1]:1e6;
        if(sa!==sb)return sa-sb;
        return laneIdx[a.p.lane]-laneIdx[b.p.lane]||(a.p.n<b.p.n?-1:1);
      });
      Lo.forEach(function(pa,i){pa.slotL[ci-pa.start]=i;});
      var R=n.th.slice().sort(function(a,b){
        var ia=ci-a.start,ib=ci-b.start;
        var na=ia<a.ids.length-1?nodeIdx(a,ia+1):1e6,nb=ib<b.ids.length-1?nodeIdx(b,ib+1):1e6;
        if(na!==nb)return na-nb;
        var la=laneIdx[a.p.lane],lb=laneIdx[b.p.lane];
        if(la!==lb)return la-lb;
        var ea=a.ids.length,eb=b.ids.length; if(ea!==eb)return eb-ea;
        return a.slotL[ia]-b.slotL[ib];
      });
      R.forEach(function(pa,i){pa.slotR[ci-pa.start]=i;});
    });
  });
  paths.forEach(function(pa){
    var t=T[pa.p.k];
    pa.ids.forEach(function(id,i){
      var col=cols[pa.start+i],n=col.nodes[id],off=(n.h-n.th.length*unit)/2;   // a card taller than its bundle centres the bundle
      t.segs.push({xL:n.x,xR:n.x+col.w,yL:n.y+off+(pa.slotL[i]+.5)*unit,yR:n.y+off+(pa.slotR[i]+.5)*unit});
    });
    t.x0=t.segs[0].xL; t.x1=t.segs[t.segs.length-1].xR;
  });
  var nodes=[];cols.forEach(function(col,ci){col.list.forEach(function(n){nodes.push({id:n.id,col:n.col,short:view.cols[n.col].short||null,x:n.x,y:n.y,h:n.h,w:col.w,card:col.card&&!n.meta.pass,text:n.text||null,gkeys:n.meta.group?paths.filter(function(pa){return n.meta.group.test(pa.p);}).map(function(pa){return pa.p.k;}):null,n:n.th.length,keys:n.th.map(function(pa){return pa.p.k;}),meta:n.meta,colTotal:col.slots});});});
  var H=bottom+(view.loop?58:22);
  var all=nodes;nodes=nodes.filter(function(n){return !n.meta.pass;});
  return {view:view,mode:mode,W:W,H:H,unit:unit,xs:xs,cw:cols.map(function(c){return c.w;}),nodes:nodes,all:all,T:T,people:people,bottom:bottom,cols:cols};
}

/* ---------- thread geometry ---------- */
function yAt(t,x){
  var sg=t.segs,i,a,b,u;
  if(x<=sg[0].xL)return sg[0].yL;
  for(i=0;i<sg.length;i++){
    a=sg[i]; if(x<=a.xR)return a.yL+(a.yR-a.yL)*((x-a.xL)/(a.xR-a.xL));
    b=sg[i+1]; if(!b)return a.yR;
    if(x<b.xL){u=(x-a.xR)/(b.xL-a.xR);u=u*u*(3-2*u);return a.yR+(b.yL-a.yR)*u;}
  }
  return sg[sg.length-1].yR;
}
function staticD(t){
  var sg=t.segs,d='M'+sg[0].xL.toFixed(1)+' '+sg[0].yL.toFixed(1),i,j,a,b,K=14,x;
  for(i=0;i<sg.length;i++){
    a=sg[i]; d+='L'+a.xR.toFixed(1)+' '+a.yR.toFixed(1);
    b=sg[i+1]; if(!b)break;
    for(j=1;j<=K;j++){x=a.xR+(b.xL-a.xR)*j/K;d+='L'+x.toFixed(1)+' '+yAt(t,x).toFixed(1);}
  }
  return d;
}
function morphD(a,b,e){
  var Np=46,d='',i,u,xa,xb,x,y;
  for(i=0;i<=Np;i++){
    u=i/Np; xa=a.x0+(a.x1-a.x0)*u; xb=b.x0+(b.x1-b.x0)*u;
    x=xa+(xb-xa)*e; y=yAt(a,xa); y=y+(yAt(b,xb)-y)*e;
    d+=(i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1);
  }
  return d;
}

/* ---------- drawing ---------- */
var svg=byId('flow'),gT=byId('gThreads'),gN=byId('gNodes'),gZ=byId('gZones'),gL=byId('gLoop');
/* the fills the drawing refers to: hatching for a box with no record behind it, the stripe of a thread in
   both lanes, and the arrowhead of the loop. Their ids carry the section's prefix: ids are page-wide. */
(function(defs){
  function fill(tag,attrs,css){var e=s(tag,attrs);e.setAttribute('style',css);return e;}
  var a=s('pattern',{id:'of-hatch',width:5,height:5,patternUnits:'userSpaceOnUse',patternTransform:'rotate(45)'});
  a.appendChild(fill('rect',{width:2,height:5},'fill:var(--node)'));
  var b=s('pattern',{id:'of-hatchSoft',width:6,height:6,patternUnits:'userSpaceOnUse',patternTransform:'rotate(45)'});
  b.appendChild(fill('rect',{width:6,height:6},'fill:var(--surface)'));b.appendChild(fill('rect',{width:2,height:6},'fill:var(--node);opacity:.16'));
  var c=s('pattern',{id:'of-bothStripe',width:16,height:16,patternUnits:'userSpaceOnUse'});
  c.appendChild(fill('rect',{width:8,height:16},'fill:var(--share)'));c.appendChild(fill('rect',{x:8,width:8,height:16},'fill:var(--pub)'));
  var d=s('marker',{id:'of-arr',viewBox:'0 0 10 10',refX:7,refY:5,markerWidth:7,markerHeight:7,orient:'auto'});
  d.appendChild(fill('path',{d:'M2 1.5L7.5 5L2 8.5',fill:'none','stroke-width':1.6,'stroke-linecap':'round','stroke-linejoin':'round'},'stroke:var(--share)'));
  defs.textContent='';[a,b,c,d].forEach(function(e){defs.appendChild(e);});
})(byId('defs'));
var stage=byId('stage'),tip=byId('tip');
var paths={},nodeEls={},cur=null,curId='whole',anim=null,sel=null,hover=null;
P.forEach(function(p){ var e=s('path',{'class':'thread '+p.lane}); e.style.display='none'; paths[p.k]=e; });
// draw order: drop-offs under, then public, then sharing on top
['none','pub','both','share'].forEach(function(l){P.forEach(function(p){if(p.lane===l)gT.appendChild(paths[p.k]);});});

function strokeW(u){return Math.max(1,u>3.4?u-1:u*.8);}
var REL=null;   // the selected box's people in the current view: {set, n, label}
function relFor(L){
  if(!sel||sel.type!=='node'||!L)return null;
  var node=null,keys;L.nodes.forEach(function(m){if(m.id===sel.id)node=m;});
  keys=node?node.keys:(sel.keys||[]).filter(function(k){return !!L.T[k];});
  if(!keys.length)return null;
  var set={};keys.forEach(function(k){set[k]=1;});
  return {set:set,n:keys.length,label:sel.label};
}
function relCount(n){var k=0,i;for(i=0;i<n.keys.length;i++){if(REL.set[n.keys[i]])k++;}return k;}
function nodeLabel(n){
  var m=n.meta,share=n.colTotal?pct(n.n,n.colTotal):'',l,sub,short;
  if(n.card&&n.text){l=n.text.l;sub=n.text.sub;short=n.text.single?n.text.sub:String(n.n);}
  else if(m.sharer){l=m.l;sub=String(sharerN(m.sharer));short=sub;}
  else{l=(n.short&&m[n.short])||m.l;sub=n.n+' · '+share;short=String(n.n);}
  if(REL&&!m.phantom){var k=relCount(n);sub=k+' of '+REL.n+' · '+pct(k,REL.n);short=k+'/'+REL.n;}   // the fraction and the share are both of the selection; the box's own total is in its tooltip
  return {l:l,sub:sub,short:short};
}
function makeNode(n){
  var m=n.meta,g=s('g',{'class':'nodeg'+(m.kind?' '+m.kind:'')+(m.small?' small':''),tabindex:'0',role:'button'});
  g.appendChild(s('rect',{'class':'hit',x:-4,y:-3,width:NODEW+8}));
  g.appendChild(s('rect',{'class':'nbox',x:0,y:0,width:NODEW,rx:2}));
  if(m.caption){
    var cap=s('text',{'class':'caption'+(m.group?' gbtn':''),x:NODEW,y:-9,'text-anchor':'end',text:m.caption});
    if(m.group){
      cap.setAttribute('tabindex','0');cap.setAttribute('role','button');cap.__gid=m.group.id;
      var pill=s('rect',{'class':'gpill',rx:8});g.appendChild(pill);
      var pick=function(ev){ev.stopPropagation();var nn=g.__n;select({type:'node',group:true,id:m.group.id,label:m.group.label,keys:(nn.gkeys||[]).slice(),col:nn.col});};
      cap.addEventListener('click',pick);pill.addEventListener('click',pick);
      pill.addEventListener('pointerenter',function(ev){ev.stopPropagation();setHover({type:'node',id:m.group.id,keys:(g.__n.gkeys||[])});});
      pill.addEventListener('pointerleave',function(){setHover(null);});
      cap.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();pick(ev);}});
      cap.addEventListener('pointerenter',function(ev){ev.stopPropagation();setHover({type:'node',id:m.group.id,keys:(g.__n.gkeys||[])});});
      cap.addEventListener('pointerleave',function(){setHover(null);});
      cap.addEventListener('focus',function(ev){ev.stopPropagation();setHover({type:'node',id:m.group.id,keys:(g.__n.gkeys||[])});});
    }
    g.appendChild(cap);
  }
  g.appendChild(s('text',{'class':'nlabel',x:NODEW+7}));
  g.appendChild(s('text',{'class':'nsub',x:NODEW+7}));
  g.addEventListener('click',function(ev){ev.stopPropagation();select({type:'node',id:n.id});});
  g.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();select({type:'node',id:n.id});}});
  g.addEventListener('pointerenter',function(){setHover({type:'node',id:n.id});});
  g.addEventListener('pointerleave',function(){setHover(null);});
  g.addEventListener('focus',function(){setHover({type:'node',id:n.id});});
  g.addEventListener('blur',function(){setHover(null);});
  return g;
}
function placeNode(g,n,x,y,hh,op,ww){
  var w=ww!=null?ww:(n.w||NODEW),card=!!n.card;
  g.setAttribute('transform','translate('+x.toFixed(1)+','+y.toFixed(1)+')');
  g.style.opacity=op;
  g.classList.toggle('card',card);
  var box=g.querySelector('.nbox'),hit=g.querySelector('.hit'),cap=g.querySelector('.caption');
  box.setAttribute('height',Math.max(hh,2).toFixed(1)); box.setAttribute('width',w.toFixed(1)); box.setAttribute('rx',card?6:2);
  hit.setAttribute('height',(Math.max(hh,2)+6).toFixed(1)); hit.setAttribute('width',(w+8).toFixed(1));
  if(cap){ if(card){cap.setAttribute('x',n.meta.group?7:0);cap.removeAttribute('text-anchor');}else{cap.setAttribute('x',NODEW);cap.setAttribute('text-anchor','end');}
    cap.textContent=n.meta.caption+(n.gkeys?' \u00b7 '+n.gkeys.length:''); if(n.meta.group){cap.setAttribute('aria-label',n.meta.group.label+': '+plural((n.gkeys||[]).length,'person','people')+'. Select the whole group.');
      var pl=g.querySelector('.gpill'),bb=null;try{bb=cap.getBBox();}catch(e){}
      if(pl&&bb&&bb.width){pl.setAttribute('x',(bb.x-6).toFixed(1));pl.setAttribute('y',(bb.y-2.5).toFixed(1));pl.setAttribute('width',(bb.width+12).toFixed(1));pl.setAttribute('height',(bb.height+5).toFixed(1));} } }
  var lab=nodeLabel(n),tl=g.querySelector('.nlabel'),ts=g.querySelector('.nsub');
  tl.removeAttribute('text-anchor');
  if(card){
    tl.setAttribute('x',10); tl.textContent=lab.l;
    if(n.text.single||hh<30){
      tl.setAttribute('y',(hh/2+4.5).toFixed(1));
      ts.textContent=lab.short; ts.setAttribute('y',(hh/2+4).toFixed(1)); ts.setAttribute('x',10); ts.setAttribute('data-inline','1');
    }else{
      tl.setAttribute('y',(hh/2-2).toFixed(1));
      ts.textContent=lab.sub; ts.setAttribute('y',(hh/2+12.5).toFixed(1)); ts.setAttribute('x',10); ts.removeAttribute('data-inline');
    }
  }else if(n.meta.left){
    tl.textContent=lab.l+'  '+lab.short; tl.setAttribute('x',-7); tl.setAttribute('text-anchor','end'); tl.setAttribute('y',(hh/2+4.5).toFixed(1));
    ts.textContent=''; ts.removeAttribute('data-inline');
  }else if(n.meta.small||hh<30){
    tl.setAttribute('x',NODEW+7); tl.textContent=lab.l; tl.setAttribute('y',(hh/2+4.5).toFixed(1));
    ts.textContent=lab.short; ts.setAttribute('y',(hh/2+4).toFixed(1));
    ts.setAttribute('x',NODEW+7); ts.setAttribute('data-inline','1');
  }else{
    tl.setAttribute('x',NODEW+7); tl.textContent=lab.l; tl.setAttribute('y',(hh/2-1).toFixed(1));
    ts.textContent=lab.sub; ts.setAttribute('y',(hh/2+14).toFixed(1)); ts.setAttribute('x',NODEW+7); ts.removeAttribute('data-inline');
  }
  g.setAttribute('aria-label',(n.meta.full||lab.l)+': '+plural(n.n,'person','people'));
}
function fixInline(){ // put the count after the one-line label
  Object.keys(nodeEls).forEach(function(id){var g=nodeEls[id],ts=g.querySelector('.nsub');if(ts.getAttribute('data-inline')&&ts.textContent){var tl=g.querySelector('.nlabel');var w=0;try{w=tl.getComputedTextLength();}catch(e){w=tl.textContent.length*7;}
    ts.setAttribute('x',(g.classList.contains('card')?10+w+8:NODEW+(w?7+w+7:6)).toFixed(1));}});
}
function drawZones(L,op){
  gZ.textContent=''; gZ.style.opacity=op;
  var v=L.view;
  v.zones.forEach(function(z,i){
    var x=L.xs[z.from];
    var lx=(z.lx&&L.mode!=='cards')?z.lx(L):x-(L.mode==='cards'?19:16);
    if(i)gZ.appendChild(s('line',{'class':'zline',x1:lx,x2:lx,y1:8,y2:L.H-8}));
    gZ.appendChild(s('text',{'class':'ztitle',x:i?lx+10:x,y:20,text:z.l}));
  });
  if(v.decor)v.decor(L,gZ);
  v.cols.forEach(function(c,i){gZ.appendChild(s('text',(c.right&&L.mode!=='cards')?{'class':'ctitle',x:L.xs[i]+NODEW,y:46,'text-anchor':'end',text:c.t}:{'class':'ctitle',x:L.xs[i],y:46,text:c.t}));});
}
function drawLoop(L,op){
  gL.textContent=''; gL.style.opacity=op;
  var v=L.view; if(!v.loop||!v.loopTo||v.gridAt==null)return;
  var tg=v.loopTo(L); if(!tg)return;
  var gx=L.xs[v.gridAt],gb=L.cols[v.gridAt].bottom,yb=L.H-22,x1=gx+NODEW/2,x0=tg.x,r=10;
  var d='M'+x1+' '+(gb+6)+'V'+(yb-r)+'Q'+x1+' '+yb+' '+(x1-r)+' '+yb+'H'+(x0+r)+'Q'+x0+' '+yb+' '+x0+' '+(yb-r)+'V'+tg.y;
  gL.appendChild(s('path',{d:d,'marker-end':'url(#of-arr)'}));
  gL.appendChild(s('text',{x:(x0+x1)/2,y:yb+4,'text-anchor':'middle',text:tg.text}));
}
function setSize(Hh,W){svg.setAttribute('viewBox','0 0 '+W+' '+Hh.toFixed(0));svg.style.height=Hh.toFixed(0)+'px';}

function relNote(){
  var el=byId('relnote');svg.classList.toggle('rel',!!REL);
  if(!REL){el.hidden=true;el.textContent='';return;}
  el.hidden=false;el.textContent='';
  el.appendChild(h('b',{text:REL.label+' selected ('+REL.n+').'}));
  el.appendChild(h('span',{'class':'more',text:' Each box now shows how many of these '+REL.n+' pass through it, and that as a share of the '+REL.n+'. Point at a box for its share of the box\u2019s own people. Select the box again to clear.'}));
}
function refreshLabels(){
  if(!cur)return;
  cur.nodes.forEach(function(n){var g=nodeEls[n.id];if(g)placeNode(g,n,n.x,n.y,n.h,1);});
  fixInline();
}
/* Where people stop. A thread that ends at a card gets a bar on that card's right edge, and a card whose
   next step loses people gets a tag (leaksFor says what a step is). */
var gK=byId('gLeak');
/* one step = from a card to the next card its people reach (a pass-through is not a card).
   A person is lost at that step when the card they land in leads no further: their thread ends there,
   or goes on only into a column that breaks that card down.
   `threads` are {k, ids, start}: a person's key, the cards along their thread and the column it starts in. */
function leakSteps(v,threads){
  var cols=v.cols,nc=cols.length,firstBand=nc,i,lostAt={},stepTo={},via={};
  for(i=0;i<nc;i++){ if(cols[i].band){firstBand=i;break;} }
  threads.forEach(function(t){
    var vis=[];t.ids.forEach(function(id,i){if(!(N[id]||{}).pass)vis.push({id:id,c:t.start+i});});
    for(var a=0;a<vis.length-1;a++){
      var X=vis[a],zi=a+1; if(X.c>=firstBand)continue;
      // a card whose next column only breaks it down is tagged with that breakdown's own step: the total of its parts
      if(cols[vis[zi].c].detail){ var part=cols[vis[zi].c].t; while(zi<vis.length&&cols[vis[zi].c].detail)zi++; if(zi>=vis.length)continue; via[X.id]=part; }
      var Y=vis[zi]; if(Y.c>=firstBand){stepTo[X.id]='the engaged grid';continue;}
      stepTo[X.id]=cols[Y.c].t;
      var on=false;for(var b=zi+1;b<vis.length;b++){if(!cols[vis[b].c].detail){on=true;break;}}
      // a card that is too early to judge is not a loss
      if(!on&&!(N[Y.id]||{}).neutral)(lostAt[X.id]=lostAt[X.id]||[]).push(t.k);
    }
  });
  return {lostAt:lostAt,stepTo:stepTo,via:via};
}
function leakTagged(share,n){return n>=LEAK_MIN&&share>=LEAK_TAG;}
function leaksFor(L){
  var v=L.view,out={bars:[],steps:[],marks:[]}; if(!v||!v.leaks)return out;
  var cols=v.cols,nc=cols.length,firstBand=nc,i;
  for(i=0;i<nc;i++){ if(cols[i].band){firstBand=i;break;} }
  var last={};Object.keys(L.T).forEach(function(k){var t=L.T[k];last[k]=t.start+t.nodes.length-1;});
  var sp=leakSteps(v,Object.keys(L.T).map(function(k){return {k:k,ids:L.T[k].nodes,start:L.T[k].start};})),lostAt=sp.lostAt,stepTo=sp.stepTo,via=sp.via;
  L.nodes.forEach(function(n){
    if(n.meta.pass||n.meta.phantom||n.col>=firstBand)return;
    var stops=n.keys.filter(function(k){return last[k]===n.col;}).length;
    if(stops){var off=(n.h-n.n*L.unit)/2;out.bars.push({x:n.x+n.w,y0:n.y+off+(n.n-stops)*L.unit,y1:n.y+off+n.n*L.unit});}
    var lost=lostAt[n.id]||[];
    if(!n.n)return;
    if(!stepTo[n.id])out.marks.push({kind:n.meta.neutral?'early':'end',node:n,k:n.n,n:n.n,from:n.meta.full||n.meta.l});
    else out.marks.push({kind:lost.length/n.n<LEAK_OK?'ok':'lost',strong:lost.length/n.n>=LEAK_STRONG,node:n,k:lost.length,n:n.n,to:stepTo[n.id],from:n.meta.full||n.meta.l,id:'leak:'+n.id});
    if(n.n>=LEAK_MIN&&lost.length){
      var lostSet={};lost.forEach(function(k){lostSet[k]=1;});
      // the same step by the door people came through, where a door has enough people to say anything
      var doors=['waitlist','direct','invite'].map(function(dr){var ks=n.keys.filter(function(k){return BY[k].door===dr;});return {l:DOORWORD[dr],n:ks.length,k:ks.filter(function(k){return lostSet[k];}).length};}).filter(function(x){return x.n>=5;});
      out.steps.push({node:n,keys:lost,k:lost.length,n:n.n,share:lost.length/n.n,to:stepTo[n.id],via:via[n.id]||null,from:n.meta.full||n.meta.l,
        gone:n.keys.filter(function(k){return BY[k].lane==='none';}).length,doors:doors.length>1?doors:[]});
    }
  });
  out.lostKeys=lostAt;
  out.steps.sort(function(a,b){return b.k-a.k||b.share-a.share;});
  out.steps.forEach(function(st){st.strong=st.share>=LEAK_STRONG;st.tag=leakTagged(st.share,st.n);st.id='leak:'+st.node.id;});
  return out;
}
var DOORWORD={waitlist:'off the waitlist',direct:'let in directly',invite:'by invite link'};
function leakMore(st){
  var out=[];
  if(st.via)out.push('This is the total of the '+st.via+' cards beside it, which carry the same people.');
  if(st.gone>st.k)out.push('Counting those who stop later, '+st.gone+' of the '+st.n+' ('+pct(st.gone,st.n)+') end up dropped off.');
  if(st.doors.length)out.push('Lost at this step, by door: '+st.doors.map(function(x){return x.l+' '+x.k+' of '+x.n+' ('+pct(x.k,x.n)+')';}).join(', ')+'.');
  return out;
}
function leakText(st){return st.k+' of the '+st.n+' people in '+st.from+(st.k===1?' goes':' go')+' no further than '+st.to+' ('+pct(st.k,st.n)+').';}
function pickLeak(st){select({type:'node',group:true,id:st.id,label:'Lost after '+st.from,keys:st.keys.slice(),col:st.node.col});}
function drawLeaks(L){
  gK.textContent=''; var lk=leaksFor(L); L.leaks=lk;
  lk.bars.forEach(function(b){gK.appendChild(s('rect',{'class':'stopbar',x:(b.x-1.5).toFixed(1),y:b.y0.toFixed(1),width:3.5,height:Math.max(2,b.y1-b.y0).toFixed(1),rx:1.5}));});
  var stepBy={};lk.steps.forEach(function(st){stepBy[st.id]=st;});
  lk.marks.forEach(function(m){
    var n=m.node,g,w,x,y=n.y-15,st=m.id?stepBy[m.id]:null;
    if(m.kind==='early'){
      // too early to judge: a grey mark, and nobody here is counted as lost
      g=s('g',{'class':'leak end',tabindex:'0',role:'button','aria-label':m.from+': too early to say.',transform:'translate('+(n.x+n.w-9).toFixed(1)+','+y.toFixed(1)+')'});
      g.appendChild(s('circle',{cx:8.5,cy:8.5,r:8}));g.appendChild(s('path',{d:'M8.5 4.6V8.5L11.2 10.2'}));
      m.tip=['Too early to say','These '+m.n+' people were let off the waitlist in the last few days. They are not counted as lost.'];
    }else if(m.kind==='end'){
      // the card is itself an end: everyone in it stops here
      g=s('g',{'class':'leak end',tabindex:'0',role:'button','aria-label':'Everyone in '+m.from+' stops here.',transform:'translate('+(n.x+n.w-9).toFixed(1)+','+y.toFixed(1)+')'});
      g.appendChild(s('circle',{cx:8.5,cy:8.5,r:8}));g.appendChild(s('path',{d:'M4.6 8.5H12.4'}));
      m.tip=['Everyone stops here','All '+m.n+' people in '+m.from+' end here. They are counted as lost on the card they came from.'];
    }else{
      var ok=m.kind==='ok',txt=ok?(m.k?'\u2212'+m.k+' \u00b7 '+pct(m.k,m.n):'0'):('\u2212'+m.k+' \u00b7 '+pct(m.k,m.n)+' lost'),lead=ok?13:0;
      w=Math.ceil(textW(txt,FS))+14+lead; x=n.x+n.w-w+8;
      g=s('g',{'class':'leak '+(ok?'ok':(m.strong?'strong':'')),tabindex:'0',role:'button',transform:'translate('+x.toFixed(1)+','+y.toFixed(1)+')'});
      g.appendChild(s('rect',{width:w,height:17,rx:8.5}));
      if(ok)g.appendChild(s('path',{d:'M6.2 8.9L9 11.6L13.6 5.9'}));
      g.appendChild(s('text',{x:lead+(w-lead)/2,y:12,'text-anchor':'middle',text:txt}));
      m.tip=[m.from+' \u2192 '+m.to, m.k?(m.k+' of the '+m.n+' people in '+m.from+(m.k===1?' goes':' go')+' no further than '+m.to+' ('+pct(m.k,m.n)+').'):('Nobody in '+m.from+' is lost at the next step: all '+m.n+' go on.')];
      if(ok&&m.k)m.tip.push('Over 90% go on.');
      if(st)leakMore(st).forEach(function(t){m.tip.push(t);});
      if(m.k)m.tip.push('Select to follow the people lost here.');
      g.setAttribute('aria-label',m.tip.slice(1).join(' '));
    }
    g.__m=m;g.__id=m.id||null;
    var pick=function(){ if(m.kind!=='end'&&m.kind!=='early'&&m.k){ if(st)pickLeak(st); else select({type:'node',group:true,id:m.id,label:'Lost after '+m.from,keys:lk.lostKeys[n.id].slice(),col:n.col}); } else select({type:'node',id:n.id}); };
    g.addEventListener('click',function(ev){ev.stopPropagation();pick();});
    g.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();pick();}});
    gK.appendChild(g);
  });
  if(L.view&&L.view.id==='share')L.nodes.forEach(function(n){
    var sh=n.meta.sharer; if(!sh)return;
    var inv=n.keys.map(function(k){return BY[k];}).filter(function(p){return p.inv&&shKey(p.inv.by,p.inv.n)===n.id;}); if(!inv.length)return;
    var lost=inv.filter(function(p){return !engaged(p);}),k=lost.length,ok=!k;
    var waiting=count(lost,function(p){return p.inv.status!=='joined';}),quiet=k-waiting;
    var txt=ok?String(inv.length):('\u2212'+k+' of '+inv.length),lead=ok?13:0,w=Math.ceil(textW(txt,FS))+14+lead,x=n.x+n.w-w-4,y=n.y+(n.h-17)/2;
    var g=s('g',{'class':'leak '+(ok?'ok':(k/inv.length>=LEAK_STRONG?'strong':'')),tabindex:'0',role:'button',transform:'translate('+x.toFixed(1)+','+y.toFixed(1)+')'});
    g.appendChild(s('rect',{width:w,height:17,rx:8.5}));
    if(ok)g.appendChild(s('path',{d:'M6.2 8.9L9 11.6L13.6 5.9'}));
    g.appendChild(s('text',{x:lead+(w-lead)/2,y:12,'text-anchor':'middle',text:txt}));
    var who=sh.by+'\u2019s link to '+sh.app;
    var tipLines=[who, ok?('All '+inv.length+' of the people it reached are engaged now.'):(k+' of the '+inv.length+' people it reached '+(k===1?'is':'are')+' not engaged now.')];
    if(k)tipLines.push([waiting?waiting+' still waiting for access':'',quiet?quiet+' joined and did little since':''].filter(Boolean).join(', ')+'.');
    if(k)tipLines.push('Select to follow them.');
    var m={kind:ok?'ok':'lost',tip:tipLines,id:'leak:'+n.id};
    g.setAttribute('aria-label',tipLines.join(' '));g.__m=m;g.__id=m.id;
    var pick=function(){ if(k)select({type:'node',group:true,id:m.id,label:'Not engaged, from '+who,keys:lost.map(function(p){return p.k;}),col:n.col}); else select({type:'node',id:n.id}); };
    g.addEventListener('click',function(ev){ev.stopPropagation();pick();});
    g.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();pick();}});
    gK.appendChild(g);
  });
  var card=byId('leakCard'),ul=byId('leaks');ul.textContent='';
  card.hidden=!lk.steps.length;
  lk.steps.slice(0,6).forEach(function(st){
    var b=h('button',{'class':'linkbtn',type:'button',text:'Show'});b.addEventListener('click',function(){pickLeak(st);NOTES.close();});
    ul.appendChild(h('li',null,h('span',{'class':'fig none',text:'\u2212'+st.k+' \u00b7 '+pct(st.k,st.n)+' lost'}),h('p',null,h('b',{text:st.from+' \u2192 '+st.to+'. '}),leakText(st)+' '+leakMore(st).join(' ')+' ',b)));
  });
}
function renderStatic(L){
  REL=relFor(L);relNote();
  setSize(L.H,L.W);
  ALL.forEach(function(p){var e=paths[p.k],t=L.T[p.k];if(!t){e.style.display='none';return;}e.style.display='';e.style.opacity='';e.setAttribute('d',staticD(t));e.setAttribute('stroke-width',strokeW(t.w).toFixed(2));});
  var keep={};
  L.nodes.forEach(function(n){var g=nodeEls[n.id];if(!g){g=makeNode(n);nodeEls[n.id]=g;gN.appendChild(g);}g.__n=n;placeNode(g,n,n.x,n.y,n.h,1);keep[n.id]=1;});
  Object.keys(nodeEls).forEach(function(id){if(!keep[id]){gN.removeChild(nodeEls[id]);delete nodeEls[id];}});
  drawZones(L,1); drawLoop(L,1); fixInline(); drawLeaks(L); applyHighlight();
}
function ease(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;}
function transition(A,B){
  if(anim){cancelAnimationFrame(anim);anim=null;gZ.__for=null;renderStatic(A);}
  gK.textContent='';   // stop marks and leak tags come back when the threads settle
  if(reduce||!A){cur=B;renderStatic(B);return;}
  var t0=null,dur=1050;
  svg.classList.remove('dim');
  REL=relFor(B);relNote();
  // nodes: shared ids travel, the rest fade
  var both={},onlyA=[],onlyB=[];
  var aBy={};A.nodes.forEach(function(n){aBy[n.id]=n;});
  B.nodes.forEach(function(n){ if(aBy[n.id])both[n.id]=[aBy[n.id],n]; else onlyB.push(n); });
  A.nodes.forEach(function(n){ var hit=false;B.nodes.forEach(function(m){if(m.id===n.id)hit=true;}); if(!hit)onlyA.push(n); });
  onlyB.forEach(function(n){var g=makeNode(n);nodeEls[n.id]=g;g.__n=n;gN.appendChild(g);placeNode(g,n,n.x,n.y,n.h,0);});
  fixInline();
  ALL.forEach(function(p){var e=paths[p.k];if(B.T[p.k]&&!A.T[p.k]){e.style.display='';e.style.opacity=0;e.setAttribute('d',staticD(B.T[p.k]));e.setAttribute('stroke-width',strokeW(B.unit).toFixed(2));}});
  function frame(ts){
    if(t0==null)t0=ts;
    var raw=Math.min(1,(ts-t0)/dur),e=ease(raw);
    var out=Math.max(0,1-raw/.42),inn=Math.max(0,(raw-.58)/.42);
    setSize(A.H+(B.H-A.H)*e,B.W);
    ALL.forEach(function(p){
      var el=paths[p.k],a=A.T[p.k],b=B.T[p.k];
      if(a&&b){el.setAttribute('d',morphD(a,b,e));el.setAttribute('stroke-width',strokeW(a.w+(b.w-a.w)*e).toFixed(2));}
      else if(a){el.style.opacity=out*.8;}
      else if(b){el.style.opacity=inn*.8;}
    });
    Object.keys(both).forEach(function(id){var q=both[id],a=q[0],b=q[1];nodeEls[id].__n=b;placeNode(nodeEls[id],raw<.5?a:b,a.x+(b.x-a.x)*e,a.y+(b.y-a.y)*e,a.h+(b.h-a.h)*e,1,a.w+(b.w-a.w)*e);});
    onlyA.forEach(function(n){nodeEls[n.id].style.opacity=out;});
    onlyB.forEach(function(n){nodeEls[n.id].style.opacity=inn;});
    if(raw<.5){gZ.style.opacity=out;gL.style.opacity=out;}
    else{ if(gZ.__for!==B){drawZones(B,0);drawLoop(B,0);gZ.__for=B;} gZ.style.opacity=inn;gL.style.opacity=inn; }
    if(raw<1){anim=requestAnimationFrame(frame);}
    else{anim=null;gZ.__for=null;cur=B;renderStatic(B);}
  }
  anim=requestAnimationFrame(frame);
}

/* ---------- highlight, hover, selection ---------- */
function keysFor(x){
  if(!x||!cur)return null;
  if(x.type==='person')return cur.T[x.k]?[x.k]:[];
  var n=null;cur.nodes.forEach(function(m){if(m.id===x.id)n=m;});
  if(n)return n.keys;
  if(x.keys)return x.keys.filter(function(k){return !!cur.T[k];});
  return [];
}
function applyHighlight(){
  var x=hover||sel,keys=keysFor(x),set={};
  Object.keys(paths).forEach(function(k){paths[k].classList.remove('hl');});
  Object.keys(nodeEls).forEach(function(id){nodeEls[id].classList.remove('hl','sel');var cp=nodeEls[id].querySelector('.gbtn');if(cp){var on=!!(sel&&sel.id===cp.__gid);cp.classList.toggle('sel',on);var gp=nodeEls[id].querySelector('.gpill');if(gp)gp.classList.toggle('on',on);}});
  if(!keys||!keys.length){svg.classList.remove('dim');}
  else{
    svg.classList.add('dim');
    keys.forEach(function(k){set[k]=1;paths[k].classList.add('hl');});
    cur.nodes.forEach(function(n){for(var i=0;i<n.keys.length;i++){if(set[n.keys[i]]){nodeEls[n.id].classList.add('hl');break;}}});
  }
  if(sel&&sel.type==='node'&&nodeEls[sel.id])nodeEls[sel.id].classList.add('sel');
  Array.prototype.forEach.call(gK.querySelectorAll('.leak'),function(e){e.classList.toggle('on',!!(sel&&sel.id===e.__id));});
}
function setHover(x){hover=x;applyHighlight();if(!x)tip.hidden=true;}
function select(x){ if(sel&&x&&sel.type===x.type&&sel.id===x.id&&sel.k===x.k)x=null; if(x&&x.type==='node'&&x.group){x.view=curId;}else if(x&&x.type==='node'){var n=null;cur.nodes.forEach(function(m){if(m.id===x.id)n=m;});x.keys=n?n.keys.slice():[];x.label=n?(n.meta.full||nodeLabel(n).l):x.id;x.view=curId;} sel=x; if(!anim){REL=relFor(cur);relNote();refreshLabels();} applyHighlight(); renderDetail(); }
function svgPoint(ev){var r=svg.getBoundingClientRect();return {x:(ev.clientX-r.left)*(cur.W/r.width),y:(ev.clientY-r.top)*(cur.H/r.height),cx:ev.clientX,cy:ev.clientY,w:window.innerWidth};}
function nearest(pt){
  var best=null,bd=1e9;
  Object.keys(cur.T).forEach(function(k){var t=cur.T[k];if(pt.x<t.x0-2||pt.x>t.x1+2)return;var d=Math.abs(yAt(t,pt.x)-pt.y);if(d<bd){bd=d;best=t;}});
  return best&&bd<=Math.max(cur.unit/2+1.5,3.5)?best:null;
}
function showTip(pt,nodes){
  tip.textContent='';nodes.forEach(function(n){tip.appendChild(n);});tip.hidden=false;
  var w=tip.offsetWidth,hh=tip.offsetHeight,x=pt.cx+14,y=pt.cy+14;if(x+w>pt.w-6)x=pt.cx-w-12;if(x<4)x=4;if(y+hh>window.innerHeight-6)y=Math.max(4,pt.cy-hh-12);
  tip.style.left=x+'px';tip.style.top=y+'px';
}
svg.addEventListener('pointermove',function(ev){
  if(anim||!cur)return; if(VIEWP.busy()){tip.hidden=true;return;}
  var lkEl=ev.target.closest&&ev.target.closest('.leak');
  if(lkEl&&lkEl.__m){if(hover){hover=null;applyHighlight();}var tp=lkEl.__m.tip;showTip(svgPoint(ev),[h('b',{text:tp[0]})].concat(tp.slice(1).map(function(t){return h('span',{'class':'t2',text:t});})));return;}
  if(ev.target.closest&&ev.target.closest('.nodeg')){
    var g=ev.target.closest('.nodeg'),n=g.__n;if(!n)return;
    if(ev.target.classList&&(ev.target.classList.contains('gbtn')||ev.target.classList.contains('gpill'))){showTip(svgPoint(ev),[h('b',{text:n.meta.group.label}),h('span',{'class':'t2',text:plural((n.gkeys||[]).length,'person','people')+'. Select to follow the whole group.'})]);return;}
    if(n.meta.phantom){var W=WAIT;showTip(svgPoint(ev),[h('b',{text:n.meta.full}),h('span',{'class':'t2',text:W?(plural(W.n,'person','people')+' joined the waitlist and have not been let off. Half have waited '+W.median+' days or more. Not drawn to scale: no thread leaves this box. Select it for the breakdown.'):'These people are stored, but nothing the connector returns lists or counts them, so the box is empty here.'})]);return;}
    var lab=nodeLabel(n);
    var sh=n.meta.sharer;
    showTip(svgPoint(ev),sh?[h('b',{text:sh.by+' shared '+sh.app}),h('span',{'class':'t2',text:plural(sharerN(sh),'person','people')+' came in through this invite. '+(sh.aud==='private'?'Private':'Public')+' app.'+(sh.team?' A team link, its maker is not counted.':(sh.second?' '+sh.by+' joined an app through '+sh.person.inv.by+'\u2019s link.':''))})]:(n.meta.grid?[h('b',{text:n.meta.full}),h('span',{'class':'t2',text:plural(n.n,'person','people')+' · '+pct(n.n,count(cur.people,function(p){return !!cur.T[p.k]&&engaged(p);}))+' of the engaged people in this view'})]:[h('b',{text:lab.l}),h('span',{'class':'t2',text:plural(n.n,'person','people')+' · '+pct(n.n,n.colTotal)+' of this column'}),REL?h('span',{'class':'t2',text:relCount(n)+' of the '+REL.n+' selected pass through here ('+pct(relCount(n),REL.n)+')'}):null,REL?h('span',{'class':'t2',text:'That is '+relCount(n)+' of this box\u2019s '+n.n+' ('+pct(relCount(n),n.n)+')'}):null].filter(Boolean)));
    return;
  }
  var pt=svgPoint(ev),t=nearest(pt);
  if(t){ if(!hover||hover.k!==t.p.k){hover={type:'person',k:t.p.k};applyHighlight();} showTip(pt,[h('b',{text:t.p.n}),h('span',{'class':'t2',text:oneLine(t.p)})]); }
  else if(hover){hover=null;applyHighlight();tip.hidden=true;}
});
svg.addEventListener('pointerleave',function(){if(hover&&hover.type==='person'){hover=null;applyHighlight();}tip.hidden=true;});
svg.addEventListener('click',function(ev){
  if(anim||!cur)return; if(ev.target.closest&&ev.target.closest('.nodeg'))return;
  var t=nearest(svgPoint(ev)); select(t?{type:'person',k:t.p.k}:null);
});

/* ---------- words about one person ---------- */
var SRC={x:'Heard about it on X',friend:'Heard about it from a friend',event:'Heard about it at an event',other:'Heard about it somewhere else',unrecorded:'Where they heard about it was not recorded',invite:'Heard about it from a member',season1:'Came from '+EARLY};
function oneLine(p){
  var a=p.s1?EARLY:(p.door==='invite'?'Invited by '+p.inv.by:(p.door==='waitlist'?'Waitlist'+(p.src!=='unrecorded'?', said '+({x:'X',friend:'a friend',event:'an event',other:'somewhere else'}[p.src]||p.src):''):'Let in directly'));
  return a+' → '+nowWords(p);
}
function nowWords(p){
  if(p.lane==='both')return (sharedPriv(p)?'shares a private app':'in a friend\u2019s private app')+' and is on public apps';
  if(p.out==='shared')return 'shared a private app';
  if(p.out==='member')return "active in a friend's private app";
  if(p.out==='pub_contrib')return 'contributes to public apps';
  if(p.out==='pub_user')return 'uses public apps';
  if(p.out==='lapsed')return 'was taking part, nothing in four weeks';
  return N[whyNode(p)].l.charAt(0).toLowerCase()+N[whyNode(p)].l.slice(1);
}
function story(p){
  var rows=[],a;
  a=SRC[p.src]+'.';
  if(p.door==='waitlist')a+=' Joined the waitlist'+(p.wait!=null?' and waited '+plural(p.wait,'day','days'):'')+(p.cohort?'; admitted '+p.cohort:'')+'.';
  else if(p.door==='invite')a=p.inv.by+' invited them to '+p.inv.n+' (a '+(p.inv.aud==='private'?'private':'public')+' app).'+(p.inv.how==='was_signed_in'?' They were already signed in.':' They made a new account from the link.');
  else{ a=(p.s1?'Came from '+EARLY+': account made '+p.acct+(p.access?', given access '+p.access:'')+'.':SRC.unrecorded+'. Let in directly'+(p.access?' on '+p.access:'')+', with no waitlist admit.'); if(p.inv)a+=' Later joined '+p.inv.n+' through '+p.inv.by+'\u2019s invite link.'; }
  rows.push(['Came in',a]);
  var mailWords=p.mail&&p.mail[0]?'Opened the admit mail'+(p.mail[1]?' and clicked it':' but did not click it'):(p.mail&&p.mail[0]===false?'Never opened the admit mail':'No admit mail open is on record');
  if(p.got==='new')rows.push(['Getting in',p.noAccount?'Let off the waitlist '+plural(p.days,'day','days')+' ago and has not made an account yet. Too early to say.':'Signed up while waiting (account made '+p.acct+'), was let off the waitlist '+plural(p.days,'day','days')+' ago and has not opened Homeroom since. Too early to say.']);
  else if(p.got==='away')rows.push(['Getting in','Signed up while waiting (account made '+p.acct+') and was let off the waitlist later. Has not opened Homeroom since, '+plural(p.days,'day','days')+' on. '+mailWords+'.']);
  else if(p.got==='mail_ignored')rows.push(['Getting in',(p.mail&&p.mail[0]?'Opened the admit mail'+(p.mail[1]?' and clicked it':' but did not click it'):(p.mail&&p.mail[0]===false?'Never opened the admit mail':'Mail opens were not tracked for this batch'))+'. Has not signed in, '+plural(p.days,'day','days')+' on.']);
  else if(p.got==='mail_none')rows.push(['Getting in','Admitted, but no admit mail is on record. '+plural(p.days,'day','days')+' on.']);
  else if(p.got==='waiting')rows.push(['Getting in','Signed up from the invite and is still waiting for access, '+plural(p.days,'day','days')+' on.']);
  else if(p.got==='acct')rows.push(['Getting in','Started an account and did not finish it.']);
  else{
    var f=firstNode(p);
    rows.push(['First session',f==='first:never'?'Has access and has never opened Homeroom.':(f==='first:none'?'Opened Homeroom and did nothing yet.':'First act: '+N[f].l.toLowerCase()+'.')]);
  }
  if(p.made.length)rows.push(['Made',plural(p.made.length,'app','apps')+(p.made.length>=5?' or more':'')+': '+p.made.map(function(m){return m.n;}).join(', ')+'.']);
  if(p.shared.length)rows.push(['Shared',p.shared.map(function(x){return x.n+' ('+x.aud+'), '+plural(x.inv.length,'person','people')+' came in';}).join('; ')+'.']);
  if(p.pub)rows.push(['Public apps',(p.pubApp?'Returns most to '+p.pubApp+' ('+plural(p.pubDays,'day','days')+'). ':'Returns to no public app. ')+(has(p,'U')?'Has had a change go live with someone else’s yes.':(p.contribFlag?'Votes or gives feedback.':'Uses, has not contributed.'))]);
  if(p.st)rows.push(['Stages reached',['A:arrive','E:explore','V:activate','B:belong','U:use','S:stay'].filter(function(x){return has(p,x[0]);}).map(function(x){return x.slice(2);}).join(', ')+'.']);
  if(!p.noAccount)rows.push(['Last active',p.lastA==null?'No app use or contribution on record.':((p.lastA===0?'Today':plural(p.lastA,'day','days')+' ago')+'. '+(p.lastC==null?'Has never contributed.':('Last contributed '+(p.lastC===0?'today':plural(p.lastC,'day','days')+' ago')+'.'))+(p.out==='lapsed'?' Counted as lapsed: nothing in the last four weeks.':''))]);
  if(p.failed||p.taps)rows.push(['Friction',(p.failed?plural(p.failed,'failed attempt','failed attempts'):'')+(p.failed&&p.taps?', ':'')+(p.taps?plural(p.taps,'repeated tap','repeated taps'):'')+'.']);
  return rows;
}

/* ---------- selection panel ---------- */
var detailBody=byId('detailBody');
function personBtn(k){var p=BY[k];return h('button',{'class':'linkbtn',type:'button',text:p.n,'data-k':String(k)});}
detailBody.addEventListener('click',function(ev){var b=ev.target.closest&&ev.target.closest('.linkbtn');if(!b)return;var k=b.getAttribute('data-k');if(k==='__clear'){select(null);return;}select({type:'person',k:BY[k]?BY[k].k:k});});
function renderDetail(){
  detailBody.textContent='';
  var sheetEl=byId('detail'); sheetEl.hidden=!sel; if(!sel)return; sheetEl.scrollTop=0;
  if(sel.type==='person'){
    var p=BY[sel.k];
    detailBody.appendChild(h('div',{'class':'who'},h('h3',{text:p.n}),h('span',{'class':'pill '+p.lane,text:LANES[p.lane].l}),h('button',{'class':'linkbtn',type:'button','data-k':'__clear',text:'Clear'})));
    detailBody.appendChild(h('ul',{'class':'steps'},story(p).map(function(r){return h('li',null,h('span',{'class':'k',text:r[0]}),h('span',{text:r[1]}));})));
    if(!cur.T[p.k])detailBody.appendChild(h('p',{'class':'note',text:'Not part of this view: the '+VBY[curId].tab+' view leaves this person out.'}));
    return;
  }
  var keys=sel.keys||[],people=keys.map(function(k){return BY[k];});
  var here=keys.filter(function(k){return !!cur.T[k];}).length;
  detailBody.appendChild(h('div',{'class':'who'},h('h3',{text:sel.label}),h('span',{'class':'pill',text:plural((sel.id==='dw:waiting'&&WAIT)?WAIT.n:people.length,'person','people')}),h('button',{'class':'linkbtn',type:'button','data-k':'__clear',text:'Clear'})));
  if(sel.view!==curId)detailBody.appendChild(h('p',{'class':'note',text:'Selected in the '+VBY[sel.view].tab+' view. '+here+' of them appear in this one.'}));
  var n=null;cur.nodes.forEach(function(m){if(m.id===sel.id)n=m;});
  if(n&&n.meta.phantom){
    var W=WAIT;
    if(!W){detailBody.appendChild(h('p',{'class':'note',text:'People who joined the waitlist and have not been let off yet belong here. This copy of the data does not include them.'}));return;}
    var wl=function(title,rows){return h('div',null,h('p',{'class':'eyebrow2',text:title}),h('ul',{'class':'rows'},rows.map(function(r){return h('li',null,h('span',{text:r[0]}),h('span',{'class':'n',text:r[1]+' \u00b7 '+pct(r[1],W.n)}));})));};
    var drawn=count(P,function(p){return p.door==='waitlist';});
    detailBody.appendChild(h('p',{'class':'note',text:plural(W.n,'person','people')+' joined the waitlist and have not been let off, against '+drawn+' drawn on this page who were. Half have waited '+W.median+' days or more, the longest '+W.longest+'. The box is not to scale and no thread leaves it: nothing has happened to these people yet.'}));
    detailBody.appendChild(h('div',{'class':'split'},wl('Waited so far',W.waited),wl('How far they got',W.far)));
    detailBody.appendChild(h('div',{'class':'split'},wl('Said they heard about it from',W.said),wl('Joined through',W.form)));
    detailBody.appendChild(h('div',{'class':'split'},wl('Joined in',W.months)));
    return;}
  if(!n&&sel.group&&sel.view===curId){
    var at=function(p,d){var t=cur.T[p.k];if(!t)return null;var i=sel.col-t.start+d;if(d<0){while(i>0&&(N[t.nodes[i]]||{}).pass)i--;} return (i>=0&&i<t.nodes.length)?dispName(t.nodes[i]):(d>0?'Stopped here':(d<0?'Started here':null));};
    var mk=function(title,d){var rows=tally(people,function(p){return at(p,d);});return h('div',null,h('p',{'class':'eyebrow2',text:title}),h('ul',{'class':'rows'},rows.map(function(r){return h('li',null,h('span',{text:r[0]}),h('span',{'class':'n',text:String(r[1])}));})));};
    detailBody.appendChild(h('div',{'class':'split'},mk('In this group',0),mk('Went to',1)));
    detailBody.appendChild(h('div',{'class':'split'},mk('Came from',-1)));
  }
  if(n){
    var from=tally(people,function(p){var t=cur.T[p.k];if(!t)return null;var i=t.nodes.indexOf(n.id);var j=i-1;while(j>0&&(N[t.nodes[j]]||{}).pass)j--;return i>0?dispName(t.nodes[j]):(i===0?'Started here':null);});
    var to=tally(people,function(p){var t=cur.T[p.k];if(!t)return null;var i=t.nodes.indexOf(n.id);return i>=0&&i<t.nodes.length-1?dispName(t.nodes[i+1]):'Stopped here';});
    detailBody.appendChild(h('div',{'class':'split'},
      h('div',null,h('p',{'class':'eyebrow2',text:'Came from'}),h('ul',{'class':'rows'},from.map(function(r){return h('li',null,h('span',{text:r[0]}),h('span',{'class':'n',text:String(r[1])}));}))),
      h('div',null,h('p',{'class':'eyebrow2',text:'Went to'}),h('ul',{'class':'rows'},to.map(function(r){return h('li',null,h('span',{text:r[0]}),h('span',{'class':'n',text:String(r[1])}));})))));
  }
  var lanes=tally(people,function(p){return p.lane;});
  detailBody.appendChild(h('p',{'class':'note',text:'Where they are now: '+lanes.map(function(r){return r[1]+' '+LANES[r[0]].l.toLowerCase();}).join(', ')+'.'}));
  detailBody.appendChild(h('div',{'class':'names'},people.slice(0,24).map(function(p){return personBtn(p.k);}),people.length>24?h('span',{'class':'note',text:'and '+(people.length-24)+' more'}):null));
}

/* ---------- what the view says ---------- */
function fig(txt,lane){return h('span',{'class':'fig'+(lane?' '+lane:''),text:txt});}
function say(figure,lane,text,q){return h('li',null,fig(figure,lane),h('p',null,text,q?h('span',{'class':'q',text:q}):null));}
function reached(p){return p.lane!=='none';}
function says(id){
  var out=[],wl=P.filter(function(p){return p.door==='waitlist';}),newInv=P.filter(function(p){return p.door==='invite';});
  var of=function(a,b){return a+' of '+b;};
  if(id==='whole'){
    var s1p=P.filter(function(p){return p.s1;}),rest=P.filter(function(p){return !p.s1;});
    if(s1p.length)out.push(say(of(count(s1p,reached),s1p.length),'pub',of(count(s1p,reached),s1p.length)+' people from '+EARLY+' are taking part now, against '+of(count(rest,reached),rest.length)+' of everyone who came after.','Where they come from'));
    if(newInv.length||wl.length)out.push(say(of(count(newInv,reached),newInv.length),'share',of(count(newInv,reached),newInv.length)+' people who first came through a member’s invite link are taking part now, against '+of(count(wl,reached),wl.length)+' from the waitlist.','Where to double down'));
    var tooNew=count(wl,function(p){return p.got==='new';}),settled=wl.length-tooNew,noAcct=count(wl,function(p){return p.got==='mail_ignored'||p.got==='mail_none';});
    if(wl.length)out.push(say(of(noAcct,settled),'none',of(noAcct,settled)+' people let off the waitlist more than a week ago have not made an account: '+count(wl,function(p){return p.got==='mail_ignored';})+' have not followed the admit mail and '+count(wl,function(p){return p.got==='mail_none';})+' have no admit mail on record.'+(tooNew?' '+tooNew+' more were let off this week and are too early to say.':''),'Where people get lost'));
    var away=P.filter(function(p){return p.got==='away';});
    if(away.length)out.push(say(String(away.length),'none',plural(away.length,'person','people')+' already had an account when they were let off the waitlist and '+(away.length===1?'has':'have')+' not opened Homeroom since. '+count(away,function(p){return p.mail&&p.mail[0];})+' opened the admit mail and '+count(away,function(p){return p.mail&&p.mail[1];})+' clicked it. They are the waitlist\u2019s loss, not a loss after signing up.','Where people get lost'));
    var act=P.filter(acted);
    out.push(say(of(count(act,reached),act.length),'pub',of(count(act,reached),act.length)+' people who did anything in their first session are taking part now. '+count(act,function(p){return p.out==='lapsed';})+' were and have done nothing in four weeks, and '+count(act,function(p){return p.lane==='none'&&p.out!=='lapsed';})+' went quiet before they got that far.','Where they get deeper'));
    var pv=P.filter(function(p){return p.priv;});
    out.push(say(plural(pv.length,'person','people'),'both',plural(pv.length,'person is','people are')+' in a private app with someone else: '+count(pv,function(p){return p.lane==='both';})+' on public apps too and '+count(pv,function(p){return p.lane==='share';})+' private only.','Where they get deeper'));
    var eng=P.filter(engaged),core=eng.filter(function(p){return conTier(p)==='core';}),idle=eng.filter(function(p){return useTier(p)===0;});
    out.push(say(of(core.length,eng.length),'pub',of(core.length,eng.length)+' people taking part build often, with six or more changes live. '+count(eng,function(p){return conTier(p)==='voice';})+' only vote, give feedback or propose, and '+count(eng,function(p){return conTier(p)==='uses';})+' use apps without contributing.','How engaged'));
    out.push(say(of(idle.length,eng.length),null,of(idle.length,eng.length)+' people taking part have come back to no app: they contribute without using anything.','How engaged'));
    var unrec=count(P,function(p){return p.src==='unrecorded';});
    out.push(say(of(unrec,P.length),null,plural(unrec,'person has','people have')+' no source on record: '+count(P,function(p){return p.src==='unrecorded'&&p.door==='waitlist';})+' off the waitlist who did not say how they heard, and '+count(P,function(p){return p.src==='unrecorded'&&p.door==='direct';})+' let in directly.','Where they come from'));
  }
  if(id==='share'){
    var inv=P.filter(function(p){return !!p.inv;}),already=inv.filter(function(p){return p.linkJoin;});
    var teamNames={};SHARERS.forEach(function(x){if(x.team)teamNames[x.by]=1;});
    var privI=inv.filter(function(p){return p.inv.aud==='private';}),pubI=inv.filter(function(p){return p.inv.aud==='public';});
    out.push(say(plural(inv.length,'person','people'),'share',plural(inv.length,'person','people')+' followed an invite into an app. '+already.length+' were already on Homeroom and '+(inv.length-already.length)+' were new. '+count(inv,function(p){return teamNames[p.inv.by];})+' came through an invite from someone who is not counted here.'));
    out.push(say(of(count(privI,function(p){return !p.linkJoin;}),inv.length-already.length),'share',of(count(privI,function(p){return !p.linkJoin;}),inv.length-already.length)+' people new to Homeroom were invited to a private app. Of the '+pubI.length+' invited to a public app, '+count(pubI,function(p){return p.linkJoin;})+' were already inside.'));
    var waiting=inv.filter(function(p){return p.inv.status!=='joined';});
    out.push(say(String(waiting.length),'none',plural(waiting.length,'invited person is','invited people are')+' not in yet'+(waiting.length?', a median of '+median(waiting.map(function(p){return p.days||0;}))+' days on':'')+'.'));
    var engI=inv.filter(engaged);
    out.push(say(of(engI.length,inv.length),'pub',of(engI.length,inv.length)+' people who followed an invite are taking part now, and '+count(inv,function(p){return p.shared.length>0;})+' have gone on to invite others.','How engaged'));
    var sentAll=P.filter(function(p){return p.sent>0;}),noneCame=count(sentAll,function(p){return !p.shared.length;});
    out.push(say(of(noneCame,sentAll.length),null,plural(sentAll.length,'person has','people have')+' made an invite link or invited someone by name. For '+noneCame+' of them nobody has followed yet.','Invites nobody followed'));
    var vrec=count(inv,function(p){return p.via&&p.via.t==='rec';}),vnone=count(inv,function(p){return p.via&&p.via.t==='noref';});
    out.push(say(of(vrec,inv.length),null,'How the link reached someone is recorded for '+of(vrec,inv.length)+'. For '+vnone+' the platform looked and the browser named no referrer, which is what a chat app does.','Link came via'));
  }
  if(id==='priv'){
    var pvw=P.filter(VBY.priv.filter),mk=pvw.filter(function(p){return madePriv(p)||sharedPriv(p);}),shd=mk.filter(sharedPriv),jn=pvw.filter(function(p){return !(madePriv(p)||sharedPriv(p));});
    out.push(say(of(shd.length,mk.length),'none',plural(mk.length,'person','people')+' made a private app, and '+shd.length+' of them had someone follow an invite into it. The other '+(mk.length-shd.length)+' are still their maker’s alone.','Where people get lost'));
    out.push(say(of(count(mk,function(p){return !!p.pub;}),mk.length),'pub',of(count(mk,function(p){return !!p.pub;}),mk.length)+' makers of a private app are on public apps too. '+count(mk,function(p){return p.s1;})+' came from '+EARLY+'.','Where they come from'));
    out.push(say(count(pvw,function(p){return p.lane==='share';})+' and '+count(pvw,function(p){return p.lane==='both';}),'both',count(pvw,function(p){return p.lane==='share';})+' people are private only and '+count(pvw,function(p){return p.lane==='both';})+' are in both. '+count(pvw,function(p){return p.out==='lapsed';})+' were taking part and have lapsed.','Private and public'));
    out.push(say(of(count(jn,function(p){return p.first!=='none';}),jn.length),'share',plural(jn.length,'person','people')+' joined someone else’s private app without making one. '+count(jn,function(p){return p.first!=='none';})+' did something in their first session and '+count(jn,function(p){return p.recent;})+' have been active in the last four weeks.','Where they get deeper'));
  }
  if(id==='pub'){
    var pub=P.filter(function(p){return !!p.pub;});
    out.push(say(String(pub.length),'pub',plural(pub.length,'person uses or contributes','people use or contribute')+' to public apps and have been active in the last four weeks. '+count(pub,function(p){return p.s1;})+' came from '+EARLY+', '+count(pub,function(p){return p.door==='waitlist';})+' off the waitlist and '+count(pub,function(p){return p.door==='invite';})+' by a member’s invite.'));
    var noapp=pub.filter(function(p){return !p.pubN;}),multi=pub.filter(function(p){return p.pubN>=2;});
    out.push(say(of(noapp.length,pub.length),'pub',of(noapp.length,pub.length)+' contribute and come back to no public app. '+of(count(multi,function(p){return p.lastC!=null&&p.lastC<14;}),multi.length)+' of those who come back to two or more contributed this week or last.','When they last contributed'));
    var top=tally(pub.filter(function(p){return p.pubApp;}),function(p){return p.pubApp;})[0];
    if(top)out.push(say(String(top[1]),'pub',top[0]+' is the public app most people come back to: it is the most-used one for '+top[1]+' of them.'));
    out.push(say(of(count(pub,function(p){return conTier(p)==='core';}),pub.length),'pub',count(pub,function(p){return conTier(p)==='core';})+' build often, with six or more changes live, and '+count(pub,function(p){return conTier(p)==='build';})+' more have had a change go live. '+count(pub,function(p){return p.pub==='user';})+' use public apps without contributing.','How engaged'));
  }
  if(id==='drop'){
    var d=P.filter(function(p){return p.lane==='none';}),adm=d.filter(function(p){return farNode(p)==='far:admit';});
    out.push(say(of(adm.length,d.length),'none',of(adm.length,d.length)+' people here were let off the waitlist and never made an account. '+count(adm,function(p){return whyNode(p)==='why:openmail';})+' opened the admit mail, '+count(adm,function(p){return whyNode(p)==='why:unopened';})+' never opened it, and '+count(adm,function(p){return whyNode(p)==='why:nomail';})+' have no admit mail on record.'));
    out.push(say(String(count(d,function(p){return p.out==='lapsed';})),'none',plural(count(d,function(p){return p.out==='lapsed';}),'person was','people were')+' taking part and have done nothing in the last four weeks.'));
    if(count(d,function(p){return p.got==='new';}))out.push(say(String(count(d,function(p){return p.got==='new';})),null,plural(count(d,function(p){return p.got==='new';}),'person was','people were')+' let off the waitlist this week and have not come in yet. They are here because nothing has happened, not because they left.'));
    var awayD=d.filter(function(p){return p.got==='away';});
    if(awayD.length)out.push(say(String(awayD.length),'none',plural(awayD.length,'person','people')+' already had an account when they were let off the waitlist and '+(awayD.length===1?'has':'have')+' not opened Homeroom since. '+count(awayD,function(p){return p.mail&&p.mail[0];})+' opened the admit mail and '+count(awayD,function(p){return p.mail&&p.mail[1];})+' clicked it.'));
    var wd=d.filter(function(p){return p.door==='waitlist'&&p.wait!=null;}).map(function(p){return p.wait;}),wi=P.filter(function(p){return p.door==='waitlist'&&p.lane!=='none'&&p.wait!=null;}).map(function(p){return p.wait;});
    if(wd.length)out.push(say(median(wd)+' days','none','People off the waitlist who are here waited a median of '+median(wd)+' days to be let in'+(wi.length?', against '+median(wi)+' for the '+wi.length+' who are taking part':'')+'.'));
    out.push(say(String(count(d,function(p){return farNode(p)==='far:account'||farNode(p)==='far:opened';})),'none',count(d,function(p){return farNode(p)==='far:account';})+' have access and never opened Homeroom, and '+count(d,function(p){return farNode(p)==='far:opened';})+' opened it and did nothing.'));
    out.push(say(String(count(d,function(p){return p.got==='waiting';})),'none',plural(count(d,function(p){return p.got==='waiting';}),'person has','people have')+' an account and cannot get in until they are let in.'));
  }
  return out;
}

/* ---------- tables ---------- */
function meter(a,b,c,d){var t=a+b+c+d||1;return h('div',{'class':'meter',role:'img','aria-label':a+' private only, '+b+' private and public, '+c+' public only, '+d+' dropped off'},[['share',a],['both',b],['pub',c],['none',d]].map(function(x){return x[1]?h('i',{'class':x[0],style:'width:'+(100*x[1]/t)+'%'}):null;}));}
function table(heads,rows){return h('table',null,h('thead',null,h('tr',null,heads.map(function(x){return h('th',{scope:'col','class':x[1]||'',text:x[0]});}))),h('tbody',null,rows));}
function td(t,cls){return h('td',{'class':cls||'',text:String(t)});}
function tables(id){
  var title,note,el;
  if(id==='whole'){
    title='Sources against outcomes';
    var groups=[[EARLY,function(p){return p.src==='season1';}],['Member\u2019s invite link',function(p){return p.src==='invite';}],['Said: X',function(p){return p.src==='x';}],['Said: a friend',function(p){return p.src==='friend';}],['Said: somewhere else',function(p){return p.src==='other';}],['Said: an event',function(p){return p.src==='event';}],['Not recorded',function(p){return p.src==='unrecorded';}]];
    el=table([['Arrived from'],['People','num'],['Made an account','num'],['First act','num'],['Private only','num'],['Both','num'],['Public only','num'],['Dropped off','num'],['Outcome mix'],['Read']],groups.filter(function(g){return P.filter(g[1]).length>0;}).map(function(g){
      var a=P.filter(g[1]),sh=count(a,function(p){return p.lane==='share';}),bo=count(a,function(p){return p.lane==='both';}),pu=count(a,function(p){return p.lane==='pub';}),no=count(a,function(p){return p.lane==='none';});
      var read=a.length<10?'Too few to read':((sh+bo+pu)/a.length>=.6?(g[0]===EARLY?'Existing base, not a channel':'Double down'):((sh+bo+pu)/a.length<=.2?'Leaking':'Mixed'));
      return h('tr',null,h('th',{scope:'row',text:g[0]}),td(a.length,'num'),td(count(a,isIn),'num'),td(count(a,acted),'num'),td(sh,'num'),td(bo,'num'),td(pu,'num'),td(no,'num'),h('td',null,meter(sh,bo,pu,no)),td(read));
    }));
    note='The read column is a rule, not a judgement: 60% or more taking part reads Double down, 20% or fewer reads Leaking, and fewer than 10 people reads Too few. '+count(P,function(p){return p.tooNew;})+' people were let off the waitlist in the last week and have had little time to do anything.';
  }
  if(id==='share'){
    title='Sharers and what came of each link';
    el=table([['Sharer'],['App'],['Audience'],['Sharer came in by'],['Came in','num'],['Joined','num'],['Contribute','num'],['Sharer now']],SHARERS.map(function(x){
      var people=P.filter(function(p){return p.inv&&p.inv.by===x.by&&p.inv.n===x.app;});
      var sp=x.person;
      return h('tr',null,h('th',{scope:'row',text:x.by+(x.team?' (team)':'')}),td(x.app),td(x.aud==='private'?'Private':'Public'),td(sp?(sp.s1?EARLY:(sp.door==='invite'?'Invite from '+sp.inv.by:N['door:'+sp.door].l)):'Not counted'),td(people.length,'num'),td(count(people,function(p){return p.inv.status==='joined';}),'num'),td(count(people,function(p){return p.contribFlag;}),'num'),td(sp?(sp.recent?'Active in the last four weeks':'Nothing in four weeks'):''));
    }));
    note='An invite appears here once someone followed it. Invites from people who are not counted here (the team, the left-out list) are drawn in grey.';
  }
  if(id==='priv'){
    title='Private apps by where people came from';
    var pvt=P.filter(VBY.priv.filter);
    var grp=[[EARLY,function(p){return p.src==='season1';}],['Waitlist',function(p){return p.door==='waitlist';}],['Member\u2019s invite link',function(p){return p.src==='invite';}],['Not recorded, let in directly',function(p){return p.src==='unrecorded'&&p.door==='direct';}]];
    el=table([['Came from'],['Made a private app','num'],['Someone joined it','num'],['Joined a friend\u2019s','num'],['Took part in it','num'],['Private only','num'],['Private and public','num'],['Lanes']],grp.filter(function(g){return pvt.filter(g[1]).length>0;}).map(function(g){
      var a=pvt.filter(g[1]),m=a.filter(function(p){return madePriv(p)||sharedPriv(p);}),j=a.filter(function(p){return !(madePriv(p)||sharedPriv(p));});
      return h('tr',null,h('th',{scope:'row',text:g[0]}),td(m.length,'num'),td(count(m,sharedPriv),'num'),td(j.length,'num'),td(count(j,function(p){return p.first!=='none';}),'num'),td(count(a,function(p){return p.lane==='share';}),'num'),td(count(a,function(p){return p.lane==='both';}),'num'),h('td',null,meter(count(a,function(p){return p.lane==='share';}),count(a,function(p){return p.lane==='both';}),count(a,function(p){return p.lane==='pub';}),count(a,function(p){return p.lane==='none';}))));
    }));
    note='Private and public are each app\u2019s audience as it is today. \u201cSomeone joined it\u201d means a person followed the maker\u2019s invite, by link or by name.';
  }
  if(id==='pub'){
    title='Public apps people return to';
    el=table([['App'],['People who opened it','num'],['Came back on a later day','num'],['Return rate','num'],['Made by']],DATA.pubApps.map(function(a){return h('tr',null,h('th',{scope:'row',text:a.n}),td(a.vis,'num'),td(a.back,'num'),td(a.vis?pct(Math.min(a.back,a.vis),a.vis):'','num'),td(a.mk.length?a.mk.join(', '):'Not among these people'));}));
    note='The top '+DATA.pubApps.length+' of '+DATA.nPublic+' public apps, by people who came back. Both counts leave out the app\u2019s own maker. A return is an app used on two or more days.';
  }
  if(id==='drop'){
    title='Where drop-offs stopped, and what the record shows';
    var d=P.filter(function(p){return p.lane==='none';});
    var rows=tally(d,function(p){return farNode(p)+'|'+whyNode(p);});
    var order=VBY.drop.cols[3].order;
    rows.sort(function(a,b){return order.indexOf(a[0].split('|')[0])-order.indexOf(b[0].split('|')[0])||b[1]-a[1];});
    el=table([['Got as far as'],['What the record shows'],['People','num'],['From the waitlist','num'],['Median days since','num'],['What would test it']],rows.map(function(r){
      var ids=r[0].split('|'),a=d.filter(function(p){return farNode(p)===ids[0]&&whyNode(p)===ids[1];});
      var test={'why:openmail':'A clearer button and a second mail','why:unopened':'Subject line, sender, a reminder','why:untracked':'Nothing to test: not tracked then','why:nomail':'Check why no admit mail went out','why:new':'Nothing yet: let off this week','why:away':'An admit mail for people who already have an account','why:lapsed':'What brought them back before','why:queued':'Let invitees of a private app straight in','why:neveropen':'A nudge after access is granted','why:noact':'What the first screen offers','why:tried':'A reason to return to the app they tried','why:explored':'What they came back for','why:joined':'A first thing to do after joining','why:solo':'The invite step on the made screen'}[ids[1]]||'';
      return h('tr',null,h('th',{scope:'row',text:N[ids[0]].l}),td(N[ids[1]].l),td(a.length,'num'),td(count(a,function(p){return p.door==='waitlist';}),'num'),td(median(a.map(function(p){return p.days;}).filter(function(x){return x!=null;})),'num'),td(test));
    }));
    note='The last column is a suggestion for what to try, not a finding.';
  }
  var gc=byId('gridCard');gc.hidden=VBY[id].gridAt==null;
  if(VBY[id].gridAt!=null){
    var eng=P.filter(VBY[id].filter).filter(engaged),gw=byId('gridwrap');gw.textContent='';
    byId('gridTitle').textContent={whole:'Engaged people: use against contribution',share:'Sharers and the people they invited: use against contribution',priv:'People in private apps: use against contribution',pub:'People on public apps: use against contribution'}[id];
    var mx=1;EROWS.forEach(function(r){ECOLS.forEach(function(c,ci){mx=Math.max(mx,count(eng,function(p){return conTier(p)===r.k&&useTier(p)===ci;}));});});
    gw.appendChild(table([['Contribution']].concat(ECOLS.map(function(c){return [c.l+' ('+c.d.replace(' app-days','')+')','num'];})).concat([['People','num'],['Invite others','num']]),EROWS.map(function(r){
      var row=eng.filter(function(p){return conTier(p)===r.k;});
      return h('tr',null,h('th',{scope:'row'},r.l,h('span',{'class':'sub',text:r.d})),ECOLS.map(function(c,ci){
        var nn=count(row,function(p){return useTier(p)===ci;}),cell=h('td',{'class':'cell',style:'background:color-mix(in srgb, var(--pub) '+Math.round(42*nn/mx)+'%, transparent)'});
        if(nn){var b=h('button',{type:'button',text:String(nn),'aria-label':r.l+', '+c.l.toLowerCase()+' use: '+plural(nn,'person','people')});b.addEventListener('click',function(){select({type:'node',id:'eng:'+r.k+':'+ci});NOTES.close();});cell.appendChild(b);}else cell.textContent='\u00b7';
        return cell;}),td(row.length,'num'),td(count(row,function(p){return p.shared.length>0;}),'num'));
    }).concat([h('tr',null,h('th',{scope:'row',text:'All engaged'}),ECOLS.map(function(c,ci){return td(count(eng,function(p){return useTier(p)===ci;}),'num');}),td(eng.length,'num'),td(count(eng,function(p){return p.shared.length>0;}),'num'))])));
    byId('gridNote').textContent='App-days are the days a person used an app they came back to (one used on two or more days), summed over apps, over all time. They say how much, not how recently. Rows count changes of their own that went live. Select a number to see who is in that cell.';
  }
  byId('tableTitle').textContent=title;
  var w=byId('tablewrap');w.textContent='';w.appendChild(el);
  byId('tableNote').textContent=note;
}

/* ---------- chrome ---------- */
var tabsEl=byId('tabs');
VIEWS.forEach(function(v){
  var b=h('button',{'class':'tab',type:'button',role:'tab','data-tab':v.id,'aria-selected':'false'},h('span',{'class':'dot '+v.dot}),v.tab,h('span',{'class':'cnt',text:String(P.filter(v.filter).length)}));
  b.addEventListener('click',function(){show(v.id,true);});
  tabsEl.appendChild(b);
});
function tabCounts(){VIEWS.forEach(function(v){var c=tabsEl.querySelector('[data-tab="'+v.id+'"] .cnt');if(c)c.textContent=String(P.filter(v.filter).length);});}
tabsEl.addEventListener('keydown',function(ev){
  if(ev.key!=='ArrowRight'&&ev.key!=='ArrowLeft')return;
  var i=VIEWS.map(function(v){return v.id;}).indexOf(curId);i=(i+(ev.key==='ArrowRight'?1:VIEWS.length-1))%VIEWS.length;
  show(VIEWS[i].id,true);tabsEl.querySelector('[data-tab="'+VIEWS[i].id+'"]').focus();
});
function viewLine(id,prev){
  var v=VBY[id],n=P.filter(v.filter).length,el=byId('viewline');el.textContent='';
  var txt={
   whole:'All '+n+' people, left to right: where they arrived from, which door they used and how long they waited, whether they got in and what happened to the admit mail, what they did first, whether they made or joined an app, and where they are now. People who are taking part now carry on into a grid on the right: rows are how much they contribute, columns are how much they use apps, and the loop runs from there back to the invite link. A thread that stops is a person who stopped there.',
   share:n+' people: everyone whose invite link brought someone into an app, and everyone who joined through one, private or public. Each sharer and app is a box, and the people they invited fan out of it to the right, first through how the link reached them. Everyone who is taking part now, sharers included, ends in the grid. Each sharer box carries a mark for the people its invite reached: a clay tag with how many are not taking part now, or a green check with the count when all of them are.',
   priv:n+' people who made a private app or joined someone else\u2019s. Where they came from is compressed on the left. The middle is the step that matters: whether anyone else joined the app they made, and whether they are on public apps too.',
   pub:n+' people who use or contribute to a public app and have been active in the last four weeks. Where they came from is compressed on the left. The right shows which app they return to, then the grid: rows are how much they contribute, columns are how much they use apps. People in “Returns to no app” are here for what they contributed (votes, feedback, changes), not for using apps: they have used no public app on two or more days. The Last contributed column says how recently.',
   drop:n+' people who are in no private app with someone else and on no public app, or who have done nothing in the last four weeks. Where they came from is compressed on the left. The right is their story: how long they waited, how far they got, and the last thing the record shows.'
  }[id];
  el.appendChild(h('b',{text:v.tab+'. '}));el.appendChild(document.createTextNode(txt));
  if(prev&&prev!==id){var pv=VBY[prev],keep=count(P,function(p){return pv.filter(p)&&v.filter(p);}),was=P.filter(pv.filter).length;
    el.appendChild(document.createTextNode(' '+(keep===n&&keep===was?'':'Same threads as before: '+keep+' carried over'+(was-keep>0?', '+(was-keep)+' faded out':'')+(n-keep>0?', '+(n-keep)+' joined':'')+'.')));}
}
function legend(L){
  var el=byId('legend');el.textContent='';
  LANEKEYS.forEach(function(l){var n=count(L.people,function(p){return p.lane===l;});if(!n)return;el.appendChild(h('li',{title:LANES[l].d},h('span',l==='both'?{'class':'sw both'}:{'class':'sw','style':'background:var(--'+(l==='none'?'drop':l)+')'}),LANES[l].l+' '+n));});
  el.appendChild(h('li',null,h('span',{'class':'box hatch'}),'Not recorded'));
  if(L.view&&L.view.leaks)el.appendChild(h('li',{title:'A thread ends at this card'},h('span',{'class':'stop'}),'Stops here'));
}
/* The chart is laid out once at a fixed design width and then moved and scaled like a map. */
var DESIGN_W=1500;
function width(v){return DESIGN_W;}
function fitStage(L){stage.style.width=L.W+'px';}
var VIEWP=(function(){
  var sc=byId('scroller'),x=0,y=0,k=1,moved=false,ptrs=new Map(),gest=null,dragged=false,busy=false;
  sc.style.cursor='grab';
  /* The chart moves by its transform alone. Focusing a card (a click in some browsers, the Tab key in all) makes the
     browser scroll it into view inside any box that can scroll, hidden overflow included, which threw the drawing to a
     corner. The stylesheet clips these boxes; where a browser still scrolls one, put it back. */
  [sc,root].forEach(function(box){listen(box,'scroll',function(){if(box.scrollLeft||box.scrollTop){box.scrollLeft=0;box.scrollTop=0;}});});
  function apply(){stage.style.transform='translate('+x.toFixed(1)+'px,'+y.toFixed(1)+'px) scale('+k.toFixed(4)+')';}
  function clamp(){
    if(!cur)return; var vw=sc.clientWidth,vh=sc.clientHeight,w=cur.W*k,hh=cur.H*k,keep=90;
    x=Math.min(vw-keep,Math.max(keep-w,x)); y=Math.min(vh-keep,Math.max(keep-hh,y));
  }
  /* default view: the whole chart when that leaves it readable; otherwise its full height, starting at the left */
  function fit(){
    if(!cur)return; var r=sc.getBoundingClientRect(),c=byId('ctl').getBoundingClientRect();
    var vw=r.width,vh=r.height,top=(c.bottom-r.top)+10,pad=12,kw=(vw-2*pad)/cur.W,kh=(vh-top-pad)/cur.H;
    var kc=Math.min(kw,kh); k=Math.max(0.2,Math.min(1.3,kc>=0.6?kc:Math.min(kh,1)));
    x=cur.W*k<=vw-2*pad?(vw-cur.W*k)/2:pad; y=top; apply();
  }
  function zoomAt(cx,cy,f){var k1=Math.min(6,Math.max(0.15,k*f));x=cx-(cx-x)*(k1/k);y=cy-(cy-y)*(k1/k);k=k1;moved=true;clamp();apply();}
  function loc(e){var r=sc.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
  sc.addEventListener('pointerdown',function(e){
    if(e.pointerType==='mouse'&&e.button!==0)return;
    ptrs.set(e.pointerId,loc(e)); dragged=false;
    if(ptrs.size===1)gest={type:'pan',moved:0};
    else if(ptrs.size===2){var a=Array.from(ptrs.values());gest={type:'pinch',d:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)||1,mx:(a[0].x+a[1].x)/2,my:(a[0].y+a[1].y)/2};dragged=true;busy=true;}
  });
  listen(window,'pointermove',function(e){
    if(!ptrs.has(e.pointerId)||!gest)return;
    var p=loc(e),prev=ptrs.get(e.pointerId);ptrs.set(e.pointerId,p);
    if(gest.type==='pan'&&ptrs.size===1){
      var dx=p.x-prev.x,dy=p.y-prev.y;gest.moved+=Math.abs(dx)+Math.abs(dy);
      if(gest.moved>6){dragged=true;busy=true;moved=true;sc.style.cursor='grabbing';x+=dx;y+=dy;clamp();apply();tip.hidden=true;}
    }else if(gest.type==='pinch'&&ptrs.size>=2){
      var a=Array.from(ptrs.values()),d=Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)||1,mx=(a[0].x+a[1].x)/2,my=(a[0].y+a[1].y)/2;
      x+=mx-gest.mx;y+=my-gest.my;zoomAt(mx,my,d/gest.d);gest.d=d;gest.mx=mx;gest.my=my;
    }
  });
  function end(e){
    if(!ptrs.has(e.pointerId))return; ptrs.delete(e.pointerId);
    if(ptrs.size===0){sc.style.cursor='grab';gest=null;busy=false;}
    else if(ptrs.size===1){gest={type:'pan',moved:99};}
  }
  listen(window,'pointerup',end);listen(window,'pointercancel',end);
  /* a drag must not also count as a click on the box or thread under it */
  sc.addEventListener('click',function(e){if(dragged){dragged=false;e.stopPropagation();e.preventDefault();}},true);
  /* A trackpad's two-finger scroll moves the chart and its pinch (which arrives as ctrl+wheel) zooms; a mouse wheel zooms.
     A wheel notch comes in whole steps of 120 with no sideways part; a trackpad sends small, uneven amounts, often in both directions.
     A run of events keeps the kind it started as, so one large trackpad step in the middle of a swipe is not taken for a wheel. */
  var wheelKind='',wheelAt=0;
  function panBy(dx,dy){x+=dx;y+=dy;moved=true;clamp();apply();}
  sc.addEventListener('wheel',function(e){
    e.preventDefault(); tip.hidden=true;
    var p=loc(e),unit=e.deltaMode===1?16:(e.deltaMode===2?sc.clientHeight:1),dx=e.deltaX*unit,dy=e.deltaY*unit,now=e.timeStamp;
    if(e.ctrlKey||e.metaKey){zoomAt(p.x,p.y,Math.exp(-dy*(e.deltaMode===0&&Math.abs(e.deltaY)<50?0.012:0.0016)));return;}
    var wd=e.wheelDeltaY,notch=e.deltaMode===1||(e.deltaX===0&&wd!=null&&wd!==0&&wd%120===0);
    var kind=(now-wheelAt<220&&wheelKind)?wheelKind:(notch?'wheel':'pad'); wheelKind=kind; wheelAt=now;
    if(kind==='wheel')zoomAt(p.x,p.y,Math.exp(-dy*0.0016));
    else panBy(-dx,-dy);
  },{passive:false});
  sc.addEventListener('dblclick',function(e){var p=loc(e);zoomAt(p.x,p.y,1.8);});
  return {fit:fit,refit:function(){if(!moved)fit();else{clamp();apply();}},busy:function(){return busy;},moved:function(){return moved;},reset:function(){moved=false;fit();}};
})();
var NOTES=(function(){
  var el=byId('notes'),btn=byId('notesBtn');
  function set(open){el.hidden=!open;btn.setAttribute('aria-expanded',open?'true':'false');if(open){el.scrollTop=0;byId('notesClose').focus();}}
  btn.addEventListener('click',function(){set(el.hidden);});
  byId('notesClose').addEventListener('click',function(){set(false);btn.focus();});
  return {close:function(){set(false);},isOpen:function(){return !el.hidden;}};
})();
byId('sheetClose').addEventListener('click',function(){select(null);});
listen(document,'keydown',function(e){if(e.key!=='Escape')return;if(NOTES.isOpen())NOTES.close();else if(sel)select(null);});
function show(id,animate,force){
  var prev=curId,L=layout(VBY[id],width(VBY[id]));fitStage(L);
  curId=id;
  VIEWS.forEach(function(v){tabsEl.querySelector('[data-tab="'+v.id+'"]').setAttribute('aria-selected',v.id===id?'true':'false');});
  viewLine(id,animate?prev:null); legend(L);
  var s=byId('says');s.textContent='';says(id).forEach(function(li){s.appendChild(li);});
  tables(id);
  byId('flowDesc').textContent=VBY[id].tab+' view of '+L.people.length+' people as a flow diagram with '+VBY[id].cols.length+' columns: '+VBY[id].cols.map(function(c){return c.t;}).join(', ')+'. The notes carry the same numbers.';
  if(animate&&cur&&(prev!==id||force)){var A=cur;hover=null;tip.hidden=true;transition(A,L);cur=L;}
  else{cur=L;renderStatic(L);}
  renderDetail();
  VIEWP.refit();
  try{localStorage.setItem('admin.onboardingFlows.view',id);}catch(e){}
}
var rz=null;
listen(window,'resize',function(){clearTimeout(rz);rz=setTimeout(function(){if(cur)VIEWP.refit();},120);});

/* header facts and how to read the numbers */
function facts(){
  var f=byId('facts');f.textContent='';
  var early=count(ALL,function(p){return p.s1;});
  [[String(P.length),' people'],[String(count(P,function(p){return !p.noAccount;})),' with an account'],
   early?(NO_S1?[String(early),' from '+EARLY+' left out']:[String(count(P,function(p){return p.s1;})),' from '+EARLY]):null,
   [String(count(P,function(p){return p.door==='waitlist';})),' off the waitlist'],[String(count(P,function(p){return p.door==='invite';})),' new by invite'],
   WAIT?[String(WAIT.n),' still on the waitlist']:null,['All time',' · read '+ASOF]
  ].forEach(function(x){if(x)f.appendChild(h('span',null,h('b',{text:x[0]}),x[1]));});
  var R=DATA.rules||{},recent=R.recentDays||28,fresh=R.tooNewDays||7;
  var m=byId('method');m.textContent='';
  ['Who is counted: everyone let off the waitlist, and every other real person who has access or followed an invite, over all time. That is '+count(P,function(p){return !p.noAccount;})+' people with an account and '+count(P,function(p){return p.noAccount;})+' let off the waitlist with none yet, shown by sign-up number. Staff, test accounts and the left-out list are excluded, as on the Journey page. People still on the waitlist are counted in their own box and are not drawn as threads.',
   early?(EARLY+': a person is drawn under '+EARLY+' when their account was made by '+dayWords(DATA.early.until)+', the end of that season. The toggle beside the legend leaves them out.'):null,
   'The door: an invite, when it came before the person was in; else the waitlist, when they were let off it; else they were let in directly. '+count(P,function(p){return p.linkJoin;})+' people followed an invite when they were already inside, so their door is not the invite and the invite shows only in the Sharing view.',
   'Arrived from: a recorded channel when there is one (the site that sent them, a campaign or tag, or how the invite was passed on), then what they said on the waitlist form, then '+EARLY+'.',
   'Private and public: each app’s audience as it is today. An app only its people can see is private; one anyone can see is public. An app that was opened up later reads as public for everything that happened in it.',
   'A contribution is a vote on a change or a request, feedback, a request filed, or a change of their own. It counts for the app it was on.',
   'Lanes: a person is in a private app when their invite brought someone into one, or when they joined one and did something. A person is on public apps when they contribute to one or come back to one (use it on two or more days). Either counts only while they are active: a contribution or a day in an app in the last '+recent+' days. After that they are lapsed and drawn as dropped off.',
   'Too early to say: somebody let off the waitlist in the last '+fresh+' days who has no account yet, or who had one already and has not opened Homeroom since. They are drawn in grey and are not counted as lost.',
   'Had an account, has not come back: somebody who signed up while they were still waiting, was let off the waitlist later and has not opened Homeroom since. They are counted with the waitlist\u2019s losses, not as people who made an account and then did nothing. A join the platform applied for a queued invite at the moment someone was let in is not counted as something they did.',
   'Engaged rows go by contribution: Builds often is six or more changes of their own live, Builds is one to five or a change that went live with someone else’s yes, Voices is votes, feedback or a proposal, Uses only is none of those. Columns go by app-days over all time: none, 1 to 9, 10 to 29, 30 or more.',
   'Marks on the cards: a step is from one card to the next card its people reach. A clay tag counts the people lost at that step, a green check means over 90% go on, and a grey minus means the card is itself an end.',
   'Small numbers: most counts here are small. Treat a difference of a few people as noise.'
  ].forEach(function(t){if(t)m.appendChild(h('li',{text:t}));});
  if(NO_S1)m.appendChild(h('li',{text:EARLY+' is left out: every count, share and finding on this page is over the '+P.length+' people who came after it. The public-apps table still counts everyone.'}));
}
facts();

/* leave Season 1 out: the same views over the people who came after it */
var s1Btn=byId('s1Toggle');
s1Btn.lastChild.textContent='Exclude '+EARLY;
s1Btn.hidden=!count(ALL,function(p){return p.s1;});
function setS1(off,animate){
  NO_S1=!!off; P=NO_S1?ALL.filter(function(p){return !p.s1;}):ALL;
  s1Btn.setAttribute('aria-pressed',NO_S1?'true':'false');
  if(sel)select(null);
  tabCounts(); facts();
  if(cur)show(curId,animate,true);
  try{localStorage.setItem('admin.onboardingFlows.noEarly',NO_S1?'1':'0');}catch(e){}
}
s1Btn.addEventListener('click',function(){setS1(!NO_S1,true);});

function setMode(m,animate){
  MODE='cards';
  if(!cur)return;
  var A=cur,L=layout(VBY[curId],width(VBY[curId]));fitStage(L);
  hover=null;tip.hidden=true;
  if(animate){transition(A,L);cur=L;}else{cur=L;renderStatic(L);}
}
setMode(MODE,false);
var start='whole';
try{var sv=localStorage.getItem('admin.onboardingFlows.view');if(sv&&VBY[sv])start=sv;}catch(e){}
try{if(localStorage.getItem('admin.onboardingFlows.noEarly')==='1'){NO_S1=true;P=ALL.filter(function(p){return !p.s1;});s1Btn.setAttribute('aria-pressed','true');tabCounts();facts();}}catch(e){}
show(start,false);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){if(!dead&&!anim)setMode(MODE,false);});
return { destroy: function(){
  dead=true;
  cleanups.forEach(function(fn){try{fn();}catch(e){}});cleanups=[];
  if(anim){cancelAnimationFrame(anim);anim=null;}
  clearTimeout(rz);
} };
}
