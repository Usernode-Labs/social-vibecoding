import {useEffect,useState} from 'react';
import {AdminUI} from './admin-console.js';
const base='/api/admin/database-migrations/batches';
type Move={operation:string;slug:string;from:{targetId:string};to:{targetId:string};databaseBytes:number};
type Batch={id:string;phase:string;attempt:number;plan:{moves:Move[];kept:{slug:string;target:string}[]};progress:{stage?:string;children?:Record<string,string>}};
type Data={inventoryError?:string;enabled:boolean;canWrite:boolean;apps:{name:string;slug:string;phase:string}[];targets:{id:string;displayName:string}[];batches:Batch[]};
export function DatabaseBatches(){
 const[data,setData]=useState<Data|null>(null),[apps,setApps]=useState<string[]>([]),[targets,setTargets]=useState<string[]>([]),[plan,setPlan]=useState<(Batch['plan']&{id:string})|null>(null);
 const[confirmation,setConfirmation]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{const c=new AbortController();let timer:ReturnType<typeof setTimeout>;const load=async()=>{try{const r=await fetch(base,{signal:c.signal});if(!r.ok)throw Error('Bulk migration service unavailable');const d=await r.json();if(!c.signal.aborted)setData(d);}catch(e){if(!c.signal.aborted)setError((e as Error).message);}finally{if(!c.signal.aborted)timer=setTimeout(load,5000);}};void load();return()=>{c.abort();clearTimeout(timer);};},[refresh]);
 async function send(path:string,body:unknown){setBusy(true);setError('');try{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'Migration request failed');setRefresh(v=>v+1);return d;}catch(e){setError((e as Error).message);return null;}finally{setBusy(false);}}
 const label=(id:string)=>data?.targets.find(t=>t.id===id)?.displayName||id;
 const active=data?.batches.some(b=>['Pending','Running','NeedsAttention'].includes(b.phase));
 const toggle=(list:string[],id:string)=>list.includes(id)?list.filter(x=>x!==id):[...list,id];
 if(data&&!data.enabled)return null;
 return <section className={`${AdminUI.card} p-4 mb-4 space-y-4`} aria-label="Bulk database migration">
  <h2 className={AdminUI.cardTitle}>Distribute app databases</h2>
  <p className={AdminUI.muted}>Review a distribution across existing pools. The platform pauses once; apps move sequentially. Verified source databases are deleted after cutover. Completed moves are kept if a later move stops.</p>
  {(error||data?.inventoryError)&&<p role="alert" className={AdminUI.muted}>{error||data?.inventoryError}</p>}
  <div className="flex flex-wrap gap-6"><fieldset disabled={!data?.canWrite||busy||active} className="space-y-2"><legend className={AdminUI.muted}>Apps</legend>
   {data?.apps.map(a=><label key={a.name} className="flex gap-2 items-center"><input type="checkbox" checked={apps.includes(a.name)} disabled={a.phase!=='Ready'} onChange={()=>{setApps(toggle(apps,a.name));setPlan(null);}}/>{a.slug} · {a.phase}</label>)}
  </fieldset><fieldset disabled={!data?.canWrite||busy||active} className="space-y-2"><legend className={AdminUI.muted}>Destination pools</legend>
   {data?.targets.map(t=><label key={t.id} className="flex gap-2 items-center"><input type="checkbox" checked={targets.includes(t.id)} onChange={()=>{setTargets(toggle(targets,t.id));setPlan(null);}}/>{t.displayName}</label>)}
  </fieldset></div>
  <button className={AdminUI.btn.outline} disabled={!data?.canWrite||busy||active||!apps.length||!targets.length} onClick={async()=>{const p=await send('/plan',{apps,targets});if(p){setPlan(p);setConfirmation('');}}}>Review distribution</button>
  {plan&&<div role="region" aria-label="Confirm bulk migration" className="space-y-3">
   {plan.moves.map(m=><p key={m.operation}>{m.slug}: {label(m.from.targetId)} → {label(m.to.targetId)} · {(m.databaseBytes/1048576).toFixed(1)} MiB</p>)}
   {plan.kept.map(k=><p key={k.slug} className={AdminUI.muted}>{k.slug}: stays on {label(k.target)}</p>)}
   <label className={AdminUI.muted}>Type {plan.id} to confirm downtime and source deletion<input aria-label="Confirm batch ID" className={AdminUI.input} value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
   <button className={AdminUI.btn.primary} disabled={!data?.canWrite||busy||active||confirmation!==plan.id} onClick={async()=>{if(await send('/'+plan.id+'/start',{confirmation}))setPlan(null);}}>Start batch</button>
   <button className={AdminUI.btn.outline} disabled={busy} onClick={()=>setPlan(null)}>Close review</button>
  </div>}
  {data?.batches.filter(b=>b.phase!=='Planned').map(b=><div className={`${AdminUI.card} p-4 space-y-2`} key={b.id}>
   <strong>{b.id}</strong><p>{b.phase} · {b.progress.stage||'Queued'}</p>
   {b.plan.moves.map(m=><p className={AdminUI.muted} key={m.operation}>{m.slug} → {label(m.to.targetId)} · {b.progress.children?.[m.operation]||'Pending'}</p>)}
   {b.phase==='NeedsAttention'&&data.canWrite&&<><button disabled={busy} className={AdminUI.btn.primary} onClick={()=>void send('/'+b.id+'/action',{action:'resume',attempt:b.attempt})}>Resume batch</button><button disabled={busy} className={AdminUI.btn.outline} onClick={()=>{if(window.confirm('Cancel pending moves? The current move must be safely aborted or completed; already completed moves remain in place.'))void send('/'+b.id+'/action',{action:'cancel',attempt:b.attempt});}}>Cancel remaining moves</button></>}
  </div>)}
 </section>;
}
