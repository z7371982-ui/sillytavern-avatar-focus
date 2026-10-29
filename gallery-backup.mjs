// Local portable archive; no network, dependencies, or secure-context requirement.
export const MAX_FILE_BYTES = 96 * 1024 * 1024;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const TYPES = new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif','image/bmp']);
export const supported = blob => TYPES.has(blob.type);
export function adjustment(position, saturation) {
    const finite = (v,min,max) => typeof v==='number' && Number.isFinite(v) && v>=min && v<=max;
    if(position != null && (!finite(position.x,0,100)||!finite(position.y,0,100)||!finite(position.zoom,50,300)||!finite(position.rotation,0,360)))throw new Error('备份内的取景参数无效。');
    if(saturation != null && !finite(saturation,0,300))throw new Error('备份内的饱和度参数无效。');
    return {position:position ? {x:position.x,y:position.y,zoom:position.zoom,rotation:position.rotation}:null,saturation:saturation ?? null};
}
function base64(bytes) {
    let result='';for(let i=0;i<bytes.length;i+=16384)result+=String.fromCharCode(...bytes.subarray(i,i+16384));
    return btoa(result);
}
export async function serializeImage(record, profile) {
    if(!supported(record.blob))throw new Error('图库备份支持 PNG/JPG/WebP/GIF/AVIF/BMP；请先移除不支持的格式。');
    if(!record.blob.size || record.blob.size>MAX_IMAGE_BYTES)throw new Error('单张图片必须在 16 MiB 以内。');
    return {name:String(record.name||'头像图片').slice(0,240),type:record.blob.type,data:base64(new Uint8Array(await record.blob.arrayBuffer())),...adjustment(profile.position,profile.saturation)};
}
export function imageIdentity(entry) {
    return JSON.stringify([entry.type,entry.data,adjustment(entry.position,entry.saturation)]);
}
export async function makeBackup(records,label,profile) {
    if(records.length>500 || records.reduce((n,r)=>n+r.blob.size,0)>MAX_RAW_BYTES)throw new Error('单次备份最多 500 张、原图合计 64 MiB。');
    const images=[];for(const r of records)images.push(await serializeImage(r,profile(r)));
    return {format:'stafe-avatar-library',version:1,label:String(label||'头像库').slice(0,240),images};
}
export function readBackup(text) {
    if(typeof text!=='string'||text.length>MAX_FILE_BYTES)throw new Error('备份文件过大。');
    let data;try{data=JSON.parse(text)}catch{throw new Error('文件不是有效的头像库备份。')}
    if(data?.format!=='stafe-avatar-library'||data.version!==1||!Array.isArray(data.images)||data.images.length>500)throw new Error('不是此扩展支持的图库备份版本。');
    let total=0;
    const images=data.images.map(entry=>{
        if(!entry||!TYPES.has(entry.type)||typeof entry.name!=='string'||entry.name.length>240||typeof entry.data!=='string'||!entry.data.length||entry.data.length%4!==0||entry.data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||! /^[A-Za-z0-9+/]*={0,2}$/.test(entry.data))throw new Error('备份中的图片格式无效或过大。');
        const bytes=Uint8Array.from(atob(entry.data),c=>c.charCodeAt(0));
        total+=bytes.length;if(bytes.length>MAX_IMAGE_BYTES||total>MAX_RAW_BYTES)throw new Error('备份图片超过大小限制。');
        return {name:entry.name,type:entry.type,data:entry.data,...adjustment(entry.position,entry.saturation),blob:new Blob([bytes],{type:entry.type})};
    });
    return {label:typeof data.label==='string'?data.label.slice(0,240):'头像库',images};
}
