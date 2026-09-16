/** The browser's visual hooks over the existing fixed-step RunHost. */
import type { Scene } from 'three/webgpu';
import type { LegRunner } from '@game/LegRunner';
import type { FocusCameraRig } from '@render';
import type { DerezzPool } from '@render/derezz/DerezzPool';
import type { EffectRegistry } from '@world/effects/EffectRegistry';
import type { AudioEngine } from '@audio/AudioEngine';
import type { Hud } from '@ui/hud/Hud';
import type { Terminal } from '@terminal/Terminal';
import { PROFILES, QualityGovernor } from '@platform';
import type { BootContext } from './boot';
import type { CameraTarget } from './input';
import type { SimHost } from './loop';
import type { LayoutStage } from './stage/LayoutStage';

export interface FrameState { elapsedSeconds: number; dtSeconds: number; alpha: number }

export function browserFrameHooks(options: {
  readonly boot: BootContext;
  readonly runner: LegRunner;
  readonly scene: Scene;
  readonly focus: FocusCameraRig;
  readonly target: CameraTarget;
  readonly state: FrameState;
  readonly stage: () => LayoutStage | null;
  readonly effects: EffectRegistry;
  readonly pool: DerezzPool;
  readonly engine: AudioEngine;
  readonly hud: Hud;
  readonly terminal: () => Terminal | null;
  readonly endConsumers: () => void;
  readonly commit: () => void;
  readonly panic: (message: string) => void;
  readonly canFinish: () => boolean;
}): Pick<SimHost, 'variableUpdate' | 'render' | 'onFrameMetrics' | 'onRunStateChanged'> {
  const { boot, focus, state } = options;
  const governor = new QualityGovernor(boot.tier, profile => {
    boot.backend.setQuality(profile);
    boot.backend.postChain?.setTier(profile.tier, profile);
  }, () => undefined);
  return {
    variableUpdate(dt, alpha) {
      state.dtSeconds = dt; state.elapsedSeconds += dt; state.alpha = alpha;
      options.runner.variableUpdate(dt, alpha);
      focus.setFreeTarget(options.target);
      const stage = options.stage();
      if (stage === null) focus.update(dt);
      else stage.update(dt, alpha);
      options.endConsumers();
      options.effects.update(dt);
      options.pool.update(dt);
      for (const entry of options.pool.entries) entry.mesh.visible = entry.alive;
      options.hud.frame(performance.now());
      if (options.canFinish() && options.runner.kernel !== null && options.runner.finished) options.runner.exit();
    },
    render(alpha) {
      try {
        boot.backend.renderFrame({ scene: options.scene, camera: focus.camera, alpha, dtSeconds: state.dtSeconds, elapsedSeconds: state.elapsedSeconds });
      } catch (error) { options.panic(error instanceof Error ? error.message : String(error)); }
      options.hud.flush();
      options.terminal()?.flush();
      options.commit();
    },
    onFrameMetrics(metrics) {
      governor.onFrame(metrics, boot.backend.stats.drawCalls > PROFILES[governor.current].drawCalls);
    },
    onRunStateChanged(running) {
      const context = options.engine.adapter.context;
      if (context !== null) void (running ? context.resume() : context.suspend()).catch(() => undefined);
    },
  };
}
