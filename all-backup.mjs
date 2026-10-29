import {writeZip,readZip,crc32} from './archive-zip.mjs';
import {adjustment,supported,MAX_IMAGE_BYTES} from './gallery-backup.mjs';
import {normalizeCycle} from './cycle-core.mjs';

export function matchGroup(group,targets){
 const matches=targets.filter(t=>t.key===group.key&&t.kind===group.kind&&t.label===group.label);
 return matches.length===1?matches[0].key:null;
}
export function cleanGroup(group){
 if(!group||typeof group.key!=='string'||group.key.length>1000||!/^(avatar:|persona:)/.test(group.key)||group.key.includes('::library::')||typeof group.label!=='string'||group.label.length>240||!['character','persona'].includes(group.kind)||!Array.isArray(group.images))throw new Error('图库信息无效。');
 if((group.kind==='character')!==group.key.startsWith('avatar:'))throw new Error('图库类型不一致。');
 const cycle=normalizeCycle(group.cycle);
 return {key:group.key,label:group.label,kind:group.kind,cycle:{enabled:cycle.enabled,every:cycle.every,mode:cycle.mode},base:adjustment(group.base?.position,group.base?.saturation),images:group.images};
}
export async function packAll(groups,preferences,progress){
 if(groups.length>5000)throw new Error('单个备份最多 5000 份图库。');
 const entries=[],portable=[];let total=0;
 for(const raw of groups){
  const group=cleanGroup(raw),images=[];
  for(const image of group.images){
   if(!supported(image.blob)||!image.blob.size||image.blob.size>MAX_IMAGE_BYTES)throw new Error(`“${group.label}”含不支持或超过 16 MiB 的图片。`);
   const file=`images/${entries.length}.bin`;total+=image.blob.size;
   if(entries.length>=20000||total>2*1024**3)throw new Error('总备份超过 20000 张图片或 2 GiB。');
   entries.push({name:file,blob:image.blob});images.push({file,name:String(image.name||'头像图片').slice(0,240),type:image.blob.type,...adjustment(image.position,image.saturation)});
  }
  portable.push({...group,images});
 }
 const manifest=new Blob([JSON.stringify({format:'stafe-all-libraries',version:1,groups:portable,preferences})]);
 if(manifest.size>8*1024**2)throw new Error('图库清单超过大小限制。');
 return writeZip([{name:'manifest.json',blob:manifest},...entries],progress);
}
export async function unpackAll(file,progress=()=>{}){
 const zip=await readZip(file);if(zip.entries.get('manifest.json').blob.size>8*1024**2)throw new Error('图库清单过大。');
 let data;try{data=JSON.parse(await(await zip.get('manifest.json')).text())}catch{throw new Error('备份清单损坏。')}
 if(data?.format!=='stafe-all-libraries'||data.version!==1||!Array.isArray(data.groups)||data.groups.length>5000)throw new Error('不是支持的全图库备份。');
 const groups=[],paths=new Set();let count=0;
 for(const raw of data.groups){
  const group=cleanGroup(raw),images=[];
  for(const image of group.images){
   if(typeof image.file!=='string'||!/^images\/[0-9]+\.bin$/.test(image.file)||paths.has(image.file)||typeof image.name!=='string'||image.name.length>240||typeof image.type!=='string')throw new Error('图片索引无效。');
   paths.add(image.file);const entry=zip.entries.get(image.file);
   if(!entry||!entry.blob.size||entry.blob.size>MAX_IMAGE_BYTES)throw new Error('图片缺失或超过大小限制。');
   const blob=(await zip.get(image.file)).slice(0,entry.blob.size,image.type);
   if(!supported(blob))throw new Error('备份中包含不支持的图片格式。');
   images.push({name:image.name,blob,...adjustment(image.position,image.saturation)});progress(++count,zip.entries.size-1);
  }
  groups.push({...group,images});
 }
 if(paths.size!==zip.entries.size-1)throw new Error('备份包含清单之外的文件。');
 return {groups,preferences:data.preferences};
}
export async function sameImage(a,b){
 if(a.blob.size!==b.blob.size||a.blob.type!==b.blob.type||JSON.stringify(adjustment(a.position,a.saturation))!==JSON.stringify(adjustment(b.position,b.saturation)))return false;
 if(await crc32(a.blob)!==await crc32(b.blob))return false;
 // CRC only screens candidates. Compare actual bytes to avoid collision-based deduplication.
 for(let p=0;p<a.blob.size;p+=1048576){const x=new Uint8Array(await a.blob.slice(p,p+1048576).arrayBuffer()),y=new Uint8Array(await b.blob.slice(p,p+1048576).arrayBuffer());if(x.some((v,i)=>v!==y[i]))return false;}
 return true;
}

export function installAllBackup(adapter){
 const $=id=>document.getElementById(id);let busy=false,dialog=null;
 const status=text=>{$('stafe_all_status').textContent=text;};
 const setBusy=value=>{busy=value;for(const id of ['stafe_all_export','stafe_all_import','stafe_all_pending'])$(id).disabled=value;};
 async function preview(data,pending=false){
  if(dialog)return;const targets=adapter.targets(),previous=document.activeElement;
  dialog=document.createElement('dialog');dialog.id='stafe_all_dialog';
  dialog.innerHTML='<form method="dialog"><header><h3>确认图库导入</h3><button type="submit" aria-label="取消">取消</button></header><p class="stafe-all-summary"></p><div class="stafe-all-bulk"><button type="button" data-bulk="keep">未匹配：全部保留</button><button type="button" data-bulk="skip">未匹配：全部跳过</button></div><div class="stafe-all-rows"></div><label><input class="stafe-all-cycles" type="checkbox"> 用备份覆盖已有角色的轮换设置（计数重新开始）</label><label><input class="stafe-all-preferences" type="checkbox"> 恢复备份中的长按、三击、魔法棒及长按时间设置</label><p class="stafe-all-help">保留会存为待关联图库；跳过不改本地数据。不会创建角色或自动替换头像。</p><p class="stafe-all-result" role="status"></p><footer><button type="button" class="stafe-all-confirm">确认合并</button></footer></form>';
  dialog.querySelector('h3').textContent=pending?'关联已保留的图库':'确认图库导入';
  const rows=[];let unmatched=0;
  for(const kind of ['character','persona']){
   const list=document.createElement('datalist');list.id='stafe_all_targets_'+kind;
   for(const t of targets.filter(t=>t.kind===kind)){const option=new Option(t.label+' — '+t.key,t.key);list.append(option);}
   dialog.append(list);
  }
  for(const group of data.groups){
   const match=matchGroup(group,targets);if(!match)unmatched++;
   const row=document.createElement('label'),name=document.createElement('span'),select=document.createElement('select');row.className='stafe-all-row';
   name.textContent=`${group.label} · ${group.images.length} 张 · ${group.kind==='character'?'角色':'用户'}\n${group.key}\n${match?'找到对应对象，请核对':'未找到确定对应对象'}`;
   select.add(new Option('保留待关联','keep'));select.add(new Option('跳过（不改本地）','skip'));
   if(match)select.add(new Option('关联：'+targets.find(t=>t.key===match).label+' — '+match,match));
   select.add(new Option('手动选择接收角色 / 用户…','manual'));
   const manual=document.createElement('input');manual.setAttribute('list','stafe_all_targets_'+group.kind);manual.placeholder='输入头像文件名选择对应对象';manual.setAttribute('aria-label','手动选择接收对象');manual.hidden=true;
   select.onchange=()=>{manual.hidden=select.value!=='manual';};
   select.value=match||'keep';row.append(name,select,manual);dialog.querySelector('.stafe-all-rows').append(row);rows.push({group,select,manual,unmatched:!match});
  }
  dialog.querySelector('.stafe-all-summary').textContent=`共 ${rows.length} 份图库，${unmatched} 份未匹配。请检查每行的接收对象，再确认合并。`;
  for(const button of dialog.querySelectorAll('[data-bulk]'))button.onclick=()=>{for(const row of rows)if(row.unmatched){row.select.value=button.dataset.bulk;row.manual.hidden=true;}};
  const close=()=>{dialog?.remove();dialog=null;previous?.focus?.();};
  dialog.addEventListener('close',close,{once:true});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.querySelector('.stafe-all-confirm').onclick=async()=>{
   if(busy)return;setBusy(true);const result=dialog.querySelector('.stafe-all-result');
   const overwrite=dialog.querySelector('.stafe-all-cycles').checked,preferences=dialog.querySelector('.stafe-all-preferences').checked;
   for(const e of dialog.querySelectorAll('button,input,select'))e.disabled=true;
   try{
    const report=await adapter.merge(rows.map(r=>({group:r.group,choice:r.select.value==='manual'?r.manual.value.trim():r.select.value})),{overwrite,preferences:preferences?data.preferences:null},text=>{result.textContent=text;});
    status(`完成：新增 ${report.added} 张，重复 ${report.duplicates} 张；保留待关联 ${report.kept} 份，跳过 ${report.skipped} 份。`);
    dialog.close();
   }catch(error){result.textContent='未完成：'+error.message;}
   finally{setBusy(false);if(dialog)for(const e of dialog.querySelectorAll('button,input,select'))e.disabled=false;}
  };
  document.body.append(dialog);dialog.showModal();
 }
 $('stafe_all_export').onclick=async()=>{
  if(busy||dialog)return;setBusy(true);status('正在读取全部图库……');
  try{
   const data=await adapter.snapshot();if(!data.groups.length)throw new Error('没有可导出的图库或调整。');
   const blob=await packAll(data.groups,data.preferences,(n,total)=>status(`正在打包 ${n}/${total}……`));
   const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`头像库-全部-${Date.now()}.stafe.zip`;document.body.append(a);a.click();a.remove();
   const cleanup=()=>{clearTimeout(timer);URL.revokeObjectURL(url);window.removeEventListener('pagehide',cleanup);};const timer=setTimeout(cleanup,60000);window.addEventListener('pagehide',cleanup,{once:true});
   status(`已发起下载，共 ${data.groups.length} 份图库。请到浏览器下载列表确认。`);
  }catch(error){status('导出失败：'+error.message);}finally{setBusy(false);}
 };
 $('stafe_all_import').onclick=()=>{if(!busy&&!dialog){$('stafe_all_file').value='';$('stafe_all_file').click();}};
 $('stafe_all_file').onchange=async()=>{
  const file=$('stafe_all_file').files?.[0];$('stafe_all_file').value='';if(!file||busy||dialog)return;
  setBusy(true);status('正在检查备份……');
  try{const data=await unpackAll(file,(n,total)=>status(`正在检查图片 ${n}/${total}……`));setBusy(false);await preview(data);status('等待确认，尚未导入。');}
  catch(error){status('无法读取：'+error.message);}finally{setBusy(false);}
 };
 $('stafe_all_pending').onclick=async()=>{
  if(busy||dialog)return;setBusy(true);
  try{const data=await adapter.snapshot();data.groups=data.groups.filter(g=>g.pendingOwner);if(!data.groups.length){status('没有待关联图库。');return;}setBusy(false);await preview(data,true);}
  catch(error){status(error.message);}finally{setBusy(false);}
 };
 return {isBusy:()=>busy||!!dialog};
}
