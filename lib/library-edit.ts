import { equal } from "./entity-sync";
import { parseLibrary, type Library, type Project } from "./ideas";

/** Saving an unchanged form is not a new idea revision. Preserve dates before queueing. */
export function preserveUnchangedIdeaDates(base: Library, next: Library): Library {
  const previous=new Map(base.projects.map(idea=>[idea.id,idea]));
  return {...next,projects:next.projects.map(idea=>{
    const old=previous.get(idea.id);
    return old && equal({...old,updatedAt:undefined},{...idea,updatedAt:undefined}) ? {...idea,updatedAt:old.updatedAt} : idea;
  })};
}

/** Apply an explicit UI edit to a complete baseline; absent, unloaded ideas are never deletions. */
export function applyVisibleEdit(base: Library, before: Library, next: Library): Library {
  const result=structuredClone(base);
  const removedSections=new Set(before.sections.filter(section=>!next.sections.some(value=>value.id===section.id)).map(section=>section.id));
  result.sections=result.sections.filter(section=>!removedSections.has(section.id));
  for(const section of next.sections) {
    const old=before.sections.find(value=>value.id===section.id);
    if(old && equal(old,section))continue;
    const offset=result.sections.findIndex(value=>value.id===section.id);
    if(offset<0)result.sections.push(section);else result.sections[offset]=section;
  }
  const removedIdeas=new Set(before.projects.filter(idea=>!next.projects.some(value=>value.id===idea.id)).map(idea=>idea.id));
  result.projects=result.projects.filter(idea=>!removedIdeas.has(idea.id) && !removedSections.has(idea.sectionId));
  for(const idea of next.projects) {
    const old=before.projects.find(value=>value.id===idea.id);
    if(old && equal(old,idea))continue;
    const offset=result.projects.findIndex(value=>value.id===idea.id);
    if(!old) {if(offset>=0)throw new Error("Idea already exists");result.projects.push(idea);continue;}
    if(offset<0)throw new Error("Idea no longer exists");
    const target=result.projects[offset];
    for(const field of ["name","description","sectionId","cover","coverImage","updatedAt","blocks"] as const) if(!equal(old[field],idea[field])) {
      (target as unknown as Record<string,unknown>)[field]=(idea as Project)[field];
    }
  }
  return parseLibrary(JSON.stringify(result));
}
