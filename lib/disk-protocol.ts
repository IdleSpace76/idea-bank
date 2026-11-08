import type { IdeaSummary,Library,Project,Section } from "./ideas";

export type DiskCursor={offset:number;revision:number;sectionId?:string;query?:string};
export type DiskCatalog={sections:Section[];ideas:IdeaSummary[];counts:Record<string,number>;total:number;revision:number;initialized:boolean;nextCursor:DiskCursor|null};
export type DiskPatch={sections:Section[];ideas:{idea:Project;blocks:boolean;create:boolean;base?:Project}[];deleteSections:string[];deleteIdeas:string[]};
export type DiskWrite={operationId:string;revision:number;patch:DiskPatch;settleDrafts?:{id:string;revision:string|null}[]};
export type DiskSnapshot={library:Library;revision:number;initialized:boolean};
export type DiskDraftData={base:Project;project:Project;revision:string;savedAt:string};
export type DiskDraftState={instance:string|null;head:string|null;draft:DiskDraftData|null};
