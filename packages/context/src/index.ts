import { createHash } from 'node:crypto'
import type { ContentPart, ContextConfig, ContextCtx, ContextMessages, ContextPolicy, ContextSnapshot, Message } from '@apollo-code/provider-kit'

export interface TokenCounter { countTokens(text:string,model:string):number|Promise<number> }
export interface CompactHooks { preCompact?(context:ContextCtx): boolean|Promise<boolean>; postCompact?(snapshot:ContextSnapshot):void|Promise<void> }
const textOf=(part:ContentPart):string=>part.type==='text'||part.type==='thinking'?part.text:part.type==='tool_use'?JSON.stringify(part.input):part.type==='tool_result'?part.content.map(textOf).join(''):''
const toolIds=(message:Message):string[]=>message.content.flatMap(part=>part.type==='tool_use'?[part.id]:part.type==='tool_result'?[part.toolUseId]:[])

export class SlidingWindowPolicy implements ContextPolicy {
  readonly name='sliding'; readonly #cache=new Map<string,number>(); #config:Required<ContextConfig>
  constructor(config:ContextConfig={},readonly counter?:TokenCounter,readonly hooks:CompactHooks={}){this.#config={compactionThreshold:.85,targetRatio:.6,reservedOutputTokens:8192,keepRecent:20,maxTokens:Number.MAX_SAFE_INTEGER,...config}}
  async init(config:ContextConfig):Promise<void>{this.#config={...this.#config,...config}}
  estimateTokens(text:string,model:string):number{const key=`${model}:${createHash('sha256').update(text).digest('base64url')}`,hit=this.#cache.get(key);if(hit!==undefined)return hit;let count=Math.ceil(text.length/3.5);try{const value=this.counter?.countTokens(text,model);if(typeof value==='number')count=value}catch{}this.#cache.set(key,count);if(this.#cache.size>5000)this.#cache.delete(this.#cache.keys().next().value!);return count}
  shouldCompact(ctx:ContextCtx):boolean{return this.total(ctx.session.messages,ctx.model)>=this.budget(ctx)*this.#config.compactionThreshold}
  buildPrompt(ctx:ContextCtx):ContextMessages{const target=this.budget(ctx),messages=this.select(ctx,target),ids=new Set(messages.map(x=>x.id));return{messages,removedMessageIds:ctx.session.messages.filter(x=>!ids.has(x.id)).map(x=>x.id),estimatedTokens:this.total(messages,ctx.model)+(ctx.systemTokens??0)+(ctx.toolSchemaTokens??0),hasSummary:messages.some(x=>Boolean((x.meta as Record<string,unknown>|undefined)?.compacted))}}
  async compact(ctx:ContextCtx):Promise<ContextSnapshot>{if(this.hooks.preCompact&&await this.hooks.preCompact(ctx)===false){const tokens=this.total(ctx.session.messages,ctx.model);return{messages:ctx.session.messages,compactedMessageIds:[],beforeTokens:tokens,afterTokens:tokens,strategy:this.name,hookIntercepted:true}}const before=this.total(ctx.session.messages,ctx.model),messages=this.select(ctx,this.budget(ctx)*this.#config.targetRatio),kept=new Set(messages.map(x=>x.id)),snapshot={messages,compactedMessageIds:ctx.session.messages.filter(x=>!kept.has(x.id)).map(x=>x.id),beforeTokens:before,afterTokens:this.total(messages,ctx.model),strategy:this.name,hookIntercepted:false};await this.hooks.postCompact?.(snapshot);return snapshot}
  private budget(ctx:ContextCtx):number{return Math.max(1,Math.min(this.#config.maxTokens,ctx.capabilities.maxContextTokens)-(ctx.systemTokens??0)-(ctx.toolSchemaTokens??0)-this.#config.reservedOutputTokens)}
  private tokens(message:Message,model:string):number{return this.estimateTokens(message.content.map(textOf).join('\n'),model)+4}
  private total(messages:readonly Message[],model:string):number{return messages.reduce((n,m)=>n+this.tokens(m,model),0)}
  private select(ctx:ContextCtx,target:number):Message[]{const all=[...ctx.session.messages];if(this.total(all,ctx.model)<=target)return all;let start=Math.max(0,all.length-this.#config.keepRecent),sum=this.total(all.slice(start),ctx.model);while(start>0&&sum+this.tokens(all[start-1]!,ctx.model)<=target){start--;sum+=this.tokens(all[start]!,ctx.model)}
    // Preserve complete user/assistant turns.
    if(start>0&&all[start]?.role==='assistant')start--
    const selected=new Set(all.slice(start).map(x=>x.id)),needed=new Set<string>();for(const m of all)if(selected.has(m.id))for(const id of toolIds(m))needed.add(id);for(const m of all)if(toolIds(m).some(id=>needed.has(id)))selected.add(m.id)
    return all.filter(m=>selected.has(m.id))}
}
