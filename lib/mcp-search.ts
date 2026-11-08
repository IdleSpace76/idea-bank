import type {AgentBackend} from "./mcp-domain";
const normalize=(value:string)=>value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/ё/g,"е").replace(/[^\p{L}\p{N}]+/gu," ").trim();
const stop=new Set(["the","and","about","with","what","have","idea","ideas","что","есть","меня","мне","про","идея","идеи","для"]);
function distance(left:string,right:string){let row=Array.from({length:right.length+1},(_,index)=>index);for(let a=0;a<left.length;a++){const next=[a+1];for(let b=0;b<right.length;b++)next.push(Math.min(next[b]+1,row[b+1]+1,row[b]+Number(left[a]!==right[b])));row=next;}return row[right.length];}
function score(query:string,name:string,description:string){
  const wanted=normalize(query),title=normalize(name),body=normalize(description);
  if(!wanted)return 1;
  const tokens=wanted.split(" ").filter(token=>token.length>1&&!stop.has(token)).slice(0,20),words=`${title} ${body}`.split(" ").slice(0,200);
  let result=title.includes(wanted)?10:body.includes(wanted)?4:0;
  for(const token of tokens){const hit=words.some(word=>word===token || Math.min(word.length,token.length)>=3 && (word.startsWith(token)||token.startsWith(word)) || token.length>=4 && word.length>=4 && Math.abs(word.length-token.length)<=1 && distance(token,word)<=1);if(hit)result+=title.includes(token)?3:1;}
  return result;
}
/** Bounded metadata scan. Bodies and attachments are read only by an explicit read/content search. */
export async function searchAgentIdeas(backend:AgentBackend,input:{query:string;section_id?:string;limit?:number;cursor?:string;content?:boolean}){
  const page=await backend.page({limit:input.content?10:100,cursor:input.cursor,sectionId:input.section_id}),ranked=page.ideas.map(idea=>({idea,score:score(input.query,idea.name,idea.description)}));
  if(input.content){
    // Full-text search is explicit and paged: never open all documents on an ordinary lookup.
    for(const row of ranked.slice(0,10)){if(row.idea.conflicted)continue;const full=await backend.read(row.idea.id);const text=full.idea.blocks.map(block=>`${block.heading}\n${block.text}`).join("\n");row.score+=score(input.query,"",text);}
  }
  const found=ranked.filter(row=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,input.limit || 8);
  return {ideas:found.map(({idea,score})=>({id:idea.id,name:idea.name,description:idea.description,section_id:idea.sectionId,updated_at:idea.updatedAt,conflicted:!!idea.conflicted,score})),total:page.total,next_cursor:page.cursor,scanned:page.ideas.length,...(input.content?{content_scanned:Math.min(page.ideas.length,10)}:{})};
}
