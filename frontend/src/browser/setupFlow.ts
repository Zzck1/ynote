import type { ModelKind } from './modelState'
export type SetupRequest={kinds:ModelKind[];continueTask?:()=>void|Promise<void>;taskKey?:string}
export function requestSetup(request:SetupRequest){window.dispatchEvent(new CustomEvent<SetupRequest>('ynote:open-local-setup',{detail:request}))}
