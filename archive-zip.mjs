// ZIP STORE: original compressed image bytes, no external library or filesystem extraction.
export const MAX_ARCHIVE = 2 * 1024 * 1024 * 1024;
const table=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export async function crc32(blob){
 let crc=0xffffffff;
 for(let p=0;p<blob.size;p+=1048576){const bytes=new Uint8Array(await blob.slice(p,p+1048576).arrayBuffer());for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);}
 return (crc^0xffffffff)>>>0;
}
function header(size){const bytes=new Uint8Array(size);return {bytes,view:new DataView(bytes.buffer)};}
const safeName=name=>/^(manifest\.json|images\/[0-9]+\.bin)$/.test(name);
export async function writeZip(entries,progress=()=>{}){
 if(entries.length>20001)throw new Error('最多备份 20000 张图片。');
 let offset=0;const parts=[],central=[],names=new Set();
 for(let i=0;i<entries.length;i++){
  const {name,blob}=entries[i];if(!safeName(name)||names.has(name))throw new Error('备份路径无效。');names.add(name);
  const n=new TextEncoder().encode(name),crc=await crc32(blob),h=header(30+n.length),v=h.view;
  v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(14,crc,true);v.setUint32(18,blob.size,true);v.setUint32(22,blob.size,true);v.setUint16(26,n.length,true);h.bytes.set(n,30);
  const c=header(46+n.length),w=c.view;w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint32(16,crc,true);w.setUint32(20,blob.size,true);w.setUint32(24,blob.size,true);w.setUint16(28,n.length,true);w.setUint32(42,offset,true);c.bytes.set(n,46);
  parts.push(h.bytes,blob);central.push(c.bytes);offset+=h.bytes.length+blob.size;
  if(offset>MAX_ARCHIVE)throw new Error('总备份超过 2 GiB，请先精简图库。');progress(i+1,entries.length);
 }
 const centralSize=central.reduce((n,b)=>n+b.length,0),end=header(22),v=end.view;
 v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,centralSize,true);v.setUint32(16,offset,true);
 if(offset+centralSize+22>MAX_ARCHIVE)throw new Error('总备份超过 2 GiB。');
 return new Blob([...parts,...central,end.bytes],{type:'application/zip'});
}
export async function readZip(file){
 if(file.size<22||file.size>MAX_ARCHIVE)throw new Error('ZIP 为空、损坏或超过 2 GiB。');
 const end=new DataView(await file.slice(-22).arrayBuffer());
 if(end.getUint32(0,true)!==0x06054b50||end.getUint16(4,true)||end.getUint16(6,true)||end.getUint16(20,true))throw new Error('请选择此扩展导出的完整 ZIP 文件。');
 const count=end.getUint16(10,true),size=end.getUint32(12,true),offset=end.getUint32(16,true);
 if(!count||count>20001||size>4*1024*1024||offset+size!==file.size-22||end.getUint16(8,true)!==count)throw new Error('ZIP 索引无效。');
 const bytes=new Uint8Array(await file.slice(offset,offset+size).arrayBuffer()),v=new DataView(bytes.buffer),entries=new Map();let p=0,expectedOffset=0;
 for(let i=0;i<count;i++){
  if(p+46>size||v.getUint32(p,true)!==0x02014b50)throw new Error('ZIP 索引损坏。');
  const length=v.getUint16(p+28,true),extra=v.getUint16(p+30,true),comment=v.getUint16(p+32,true),start=v.getUint32(p+42,true),stored=v.getUint32(p+20,true);
  if(p+46+length+extra+comment>size)throw new Error('ZIP 条目损坏。');
  const name=new TextDecoder().decode(bytes.slice(p+46,p+46+length));
  if(!safeName(name)||entries.has(name)||v.getUint16(p+8,true)!==0||v.getUint16(p+10,true)!==0||v.getUint16(p+34,true)!==0||stored!==v.getUint32(p+24,true)||start!==expectedOffset)throw new Error('不支持此 ZIP 的路径、加密或压缩方式。请勿重新压缩备份包。');
  const local=new DataView(await file.slice(start,start+30).arrayBuffer());
  if(local.byteLength!==30||local.getUint32(0,true)!==0x04034b50||local.getUint16(6,true)||local.getUint16(8,true)||local.getUint16(26,true)!==length||local.getUint16(28,true)||local.getUint32(18,true)!==stored||local.getUint32(22,true)!==stored||local.getUint32(14,true)!==v.getUint32(p+16,true))throw new Error('ZIP 图片索引不一致。');
  const localName=new TextDecoder().decode(await file.slice(start+30,start+30+length).arrayBuffer());
  expectedOffset=start+30+length+stored;if(localName!==name||expectedOffset>offset)throw new Error('ZIP 图片越界。');
  const blob=file.slice(start+30+length,expectedOffset);entries.set(name,{blob,crc:v.getUint32(p+16,true)});p+=46+length+extra+comment;
 }
 if(p!==size||expectedOffset!==offset||!entries.has('manifest.json'))throw new Error('ZIP 内容不完整。');
 return {async get(name){const entry=entries.get(name);if(!entry)throw new Error('备份缺少图片。');if(await crc32(entry.blob)!==entry.crc)throw new Error('备份校验失败，文件可能损坏。');return entry.blob;},entries};
}
