/** Stable slots, lowest free index first. Holes below highWater remain hidden. */
export class SlotAllocator {
  private readonly occupied:Uint8Array;
  private firstFree=0;
  private high=0;
  private live=0;
  constructor(readonly capacity:number){if(!Number.isInteger(capacity)||capacity<=0)throw new Error('Invalid slot capacity');this.occupied=new Uint8Array(capacity);}
  get count():number{return this.live;}
  get highWater():number{return this.high;}
  has(slot:number):boolean{return Number.isInteger(slot)&&slot>=0&&slot<this.capacity&&this.occupied[slot]===1;}
  allocate():number {
    if(this.firstFree===this.capacity)throw new Error('Instance slots exhausted');
    const slot=this.firstFree;this.occupied[slot]=1;this.live++;this.high=Math.max(this.high,slot+1);
    while(this.firstFree<this.capacity&&this.occupied[this.firstFree])this.firstFree++;
    return slot;
  }
  free(slot:number):void {
    if(!this.has(slot))throw new Error('Slot is not allocated');this.occupied[slot]=0;this.live--;this.firstFree=Math.min(this.firstFree,slot);
    while(this.high>0&&!this.occupied[this.high-1])this.high--;
  }
}
