// Local portable archive; no network, dependencies, or secure-context requirement.
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const TYPES = new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif','image/bmp']);
export const supported = blob => TYPES.has(blob.type);
export function adjustment(position, saturation) {
    const finite = (v,min,max) => typeof v==='number' && Number.isFinite(v) && v>=min && v<=max;
    if(position != null && (!finite(position.x,0,100)||!finite(position.y,0,100)||!finite(position.zoom,50,300)||!finite(position.rotation,0,360)))throw new Error('备份内的取景参数无效。');
    if(saturation != null && !finite(saturation,0,300))throw new Error('备份内的饱和度参数无效。');
    return {position:position ? {x:position.x,y:position.y,zoom:position.zoom,rotation:position.rotation}:null,saturation:saturation ?? null};
}

