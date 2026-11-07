import { assembleLibrary,entityKey,equal } from "./entity-sync";
import { readScopedEntry,readScopedIndex,readScopedDeletions } from "./scoped-store";
import type { ReaderPage,ReaderQuery } from "./library-reader";
import type { IdeaSummary } from "./ideas";
export async function overlayPage(scope:string,page:ReaderPage,options:ReaderQuery):Promise<ReaderPage> {
  const pending=(await readScopedIndex()).filter(row=>row.scope===scope),sections=new Map(page.sections.map(section=>[section.id,section])),ideas=new Map(page.ideas.map(idea=>[idea.id,idea]));
  const counts={...page.counts};let total=page.total;
  for(const row of (await readScopedDeletions()).filter(row=>row.scope===scope)) {
    if(row.kind==="section") {
      sections.delete(row.id);let removed=0;for(const [id,idea] of ideas)if(idea.sectionId===row.id){ideas.delete(id);removed++;}
      total-=options.query?removed:options.sectionId && options.sectionId!==row.id?0:counts[row.id] || 0;delete counts[row.id];
    } else {
      const before=ideas.get(row.id);if(ideas.delete(row.id)){total--;if(before)counts[before.sectionId]=Math.max(0,(counts[before.sectionId] || 0)-1);}
    }
  }
  const matches=(idea:IdeaSummary|null|undefined)=>!!idea && (!options.sectionId || idea.sectionId===options.sectionId) && (!options.query?.trim() || `${idea.name}\n${idea.description}`.toLowerCase().includes(options.query.trim().toLowerCase()));
  const rows=pending.flatMap(row=>row.target.kind==="library" ? row.entries || (row.deletedSections || []).map(id=>({...row,target:{kind:"section-tree" as const,id},section:null})) : [row]);
  for(const row of rows) {
    if(row.target.kind!=="idea") {
      if(row.section)sections.set(row.section.id,row.section);
      else {
        sections.delete(row.target.id);
        const removed=[...ideas.values()].filter(idea=>idea.sectionId===row.target.id);for(const idea of removed)ideas.delete(idea.id);
        total-=options.query ? removed.length : options.sectionId && options.sectionId!==row.target.id ? 0 : counts[row.target.id] || 0;
        delete counts[row.target.id];
      }
      continue;
    }
    const current=ideas.get(row.target.id),alreadyApplied=current && row.idea && equal(current,row.idea);
    if(!alreadyApplied) {
      if(row.before && (!row.idea || row.idea.sectionId!==row.before.sectionId))counts[row.before.sectionId]=Math.max(0,(counts[row.before.sectionId] || 0)-1);
      if(row.idea && (!row.before || row.before.sectionId!==row.idea.sectionId))counts[row.idea.sectionId]=(counts[row.idea.sectionId] || 0)+1;
      total+=Number(matches(row.idea))-Number(matches(row.before));
    }
    ideas.delete(row.target.id);
    if(row.idea && matches(row.idea))ideas.set(row.idea.id,row.idea);
  }
  return {...page,...(pending.some(row=>row.target.kind==="library" && row.reset!==false)?{nextCursor:null}:{}),sections:[...sections.values()],ideas:[...ideas.values()].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)||a.id.localeCompare(b.id)),counts,total:Math.max(ideas.size,total)};
}
export async function overlayIdea(scope:string,id:string) {
  const entries=(await readScopedIndex()).filter(row=>row.scope===scope);
  if(entries.some(row=>row.deletedIds.includes(id) || row.target.kind==="idea" && row.target.id===id && row.idea===null))return {deleted:true as const};
  const own=entries.find(row=>row.target.kind==="idea" && row.target.id===id || row.target.kind==="library" && row.entries?.some(child=>child.target.kind==="idea" && child.target.id===id));
  if(!own) {
    const deleted=(await readScopedDeletions()).some(row=>row.scope===scope && row.kind==="idea" && row.id===id);
    return deleted?{deleted:true as const,confirmed:true}:undefined;
  }
  const entry=await readScopedEntry(scope,own.target);if(!entry)return;
  const idea=assembleLibrary(entry.local).projects.find(idea=>idea.id===id);
  return idea?{idea,version:`pending:${entry.sequence}`,offline:navigator.onLine===false}:undefined;
}
