export type CompanionRelease = {minimum_os?:string|null;platform:string;architecture:string;version:string;file_name:string|null;bytes:number|null;sha256:string|null;signature:string;protocol:number;built:boolean;installed:boolean;local_pipeline_verified:boolean;production_https_verified:boolean;clean_machine_verified:boolean;published:boolean;release_authorized:boolean;release_channel?:'testing';download_url:string|null;development_download_url?:string|null;release_notes:string}

export function companionDownload(release: CompanionRelease | undefined, hostname: string): {url:string|null;development:boolean;testing?:boolean} {
  if (!release || release.protocol !== 1 || release.built !== true) return {url:null,development:false}
  let secureUrl=false
  try {const url=new URL(release.download_url || '');secureUrl=url.protocol==='https:' && !url.username && !url.password} catch { /* Unpublished release. */ }
  const production=[release.installed,release.local_pipeline_verified,release.production_https_verified,release.clean_machine_verified,release.published,release.release_authorized].every(value=>value===true) && release.signature==='valid' && secureUrl
  if(production)return {url:release.download_url,development:false}
  const local=['127.0.0.1','localhost','::1','[::1]'].includes(hostname)
  const candidate=release.development_download_url || ''
  const metadata=Number.isSafeInteger(release.bytes) && release.bytes!>0 && typeof release.sha256==='string' && /^[a-f0-9]{64}$/i.test(release.sha256)
  if(release.release_channel==='testing' && release.release_authorized===true && metadata && /^\/downloads\/[A-Za-z0-9_.-]+\.zip$/i.test(release.download_url || ''))return {url:release.download_url,development:false,testing:true}
  if(local && metadata && /^\/downloads\/[A-Za-z0-9_.-]+\.zip$/i.test(candidate))return {url:candidate,development:true}
  return {url:null,development:false}
}
