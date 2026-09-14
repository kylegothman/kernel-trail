import type { BackendId } from '../RendererBackend';
export type LossOutcome='recovered_same'|'recovered_fallback'|'unrecoverable';
export class DeviceLossPolicy {
  private pending:Promise<void>|null=null;
  constructor(private readonly rebuild:(forceWebGL:boolean)=>Promise<void>,private readonly onOutcome:(outcome:LossOutcome,note:string)=>void,private readonly persistFallbackFlag:()=>void) {}
  handle(reason:string,backend:BackendId='webgpu'):Promise<void> {
    if(reason==='destroyed')return Promise.resolve();
    if(this.pending)return this.pending;
    this.pending=this.recover(reason,backend).finally(()=>{this.pending=null;});return this.pending;
  }
  private async recover(reason:string,backend:BackendId):Promise<void> {
    try{await this.rebuild(backend==='webgl2');this.onOutcome('recovered_same',reason);return;}catch{/* Try the approved fallback once. */}
    if(backend==='webgpu')try{await this.rebuild(true);this.persistFallbackFlag();this.onOutcome('recovered_fallback',reason);return;}catch{/* Host shows the recoverable card. */}
    this.onOutcome('unrecoverable',reason);
  }
}
