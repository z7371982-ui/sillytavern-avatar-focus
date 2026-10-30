// Refresh only resources that explicitly identify the changed avatar; never guess by message position.
export function resourceKey(source,base=location.href){
 try{const u=new URL(source,base),type=u.searchParams.get('type'),file=u.searchParams.get('file')||u.searchParams.get('avatar');
 if(file&&['avatar','persona'].includes(type))return type+':'+file;
 const path=decodeURIComponent(u.pathname),match=path.match(/\/(characters|user[ _-]?avatars?|personas?)\/([^/]+)$/i);
 return match?(match[1].toLowerCase()==='characters'?'avatar:':'persona:')+match[2]:'';}catch{return '';}
}
export function refreshChatResources(key,stamp){
 const rules=[];
 let style=document.getElementById('stafe_chat_refresh');
 if(!style){style=document.createElement('style');style.id='stafe_chat_refresh';document.head.append(style);}
 const replace=value=>value.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi,(whole,_q,src)=>{
  if(resourceKey(src)!==key)return whole;
  const url=new URL(src,location.href);url.searchParams.set('t',stamp);return `url(${JSON.stringify(url.href)})`;
 });
 // Preserve earlier per-avatar rules while replacing this avatar's revision.
 const saved=refreshChatResources.rules ||= new Map();
 for(const element of document.querySelectorAll('#chat, #chat *')){
  if(element instanceof HTMLImageElement){
   for(const attr of ['src']){const value=element.getAttribute(attr);if(value&&resourceKey(value)===key){const u=new URL(value,location.href);u.searchParams.set('t',stamp);if(value!==u.href)element.setAttribute(attr,u.href);}}
   const srcset=element.getAttribute('srcset');
   if(srcset){const next=srcset.replace(/(\S+)(\s+\d+(?:\.\d+)?[wx])?(\s*,|$)/g,(whole,url,descriptor='',comma='')=>{if(resourceKey(url)!==key)return whole;const u=new URL(url,location.href);u.searchParams.set('t',stamp);return u.href+descriptor+comma;});if(next!==srcset)element.setAttribute('srcset',next);}
  }
  for(const pseudo of ['', '::before','::after']){
   const computed=getComputedStyle(element,pseudo||null);
   for(const property of ['background-image','content']){
    const value=computed.getPropertyValue(property),next=replace(value);if(next===value)continue;
    if(!pseudo)element.style.setProperty(property,next,'important');
    else{if(!element.dataset.stafeRefreshId)element.dataset.stafeRefreshId='r'+(++refreshChatResources.sequence);rules.push(`[data-stafe-refresh-id="${element.dataset.stafeRefreshId}"]${pseudo}{${property}:${next}!important}`);}
   }
  }
 }
 saved.set(key,rules.join('\n'));style.textContent=[...saved.values()].join('\n');
 // Opt-in companion bridge. Do not touch another theme's layout or emit host edit events.
 document.dispatchEvent(new CustomEvent('stafe:avatar-resource-updated', {detail:{key,stamp:String(stamp)}}));
}
refreshChatResources.sequence=0;
